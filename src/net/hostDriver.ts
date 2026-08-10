// ホスト権威ドライバ（契約03）。ルーム作成者のクライアントだけがエンジンを実行する。
// - 自席の操作は dispatch() で直接エンジンに適用（ホストも1人のプレイヤー）。
// - ゲストの要求は handleAction() で受け、なりすまし/不正/二重要求を検証して適用（E2/E7/E8）。
// - 状態が変わるたび、各ゲストへ deriveViewFor で視界フィルタした全量スナップショットを配信（要件§3.1）。
//   他家の手札・山札の中身はネットワークに一切載らない（E5）。
import type { Action, ActionResult, GameState, PlayerView } from '../core';
import { applyAction, createGame, deriveViewFor, eligibleClaims } from '../core';
import type { ClaimOption, GameDriver } from '../driver/types';
import { CLAIM_WINDOW_MS, type AckMsg, type ActionMsg, type ErrMsg, type SnapshotMsg } from './protocol';

export interface HostDriverDeps {
  /** 席順（index=席）。id は playerKey。慣例として先頭がホスト自身。 */
  players: { id: string; name: string }[];
  /** ホスト自身の playerKey（=自席の id）。 */
  selfPk: string;
  totalRounds: number;
  seed?: number;
  /** playerKey → 現在の生 peerId（未接続/自分は null）。セッションが束縛を維持する（E8）。 */
  resolvePeer: (pk: string) => string | null;
  /** peerId → playerKey（未知は null）。なりすまし検証に使う（E7）。 */
  resolvePk: (peerId: string) => string | null;
  sendSnap: (peerId: string, msg: SnapshotMsg) => void;
  sendErr: (peerId: string, msg: ErrMsg) => void;
  sendAck: (peerId: string, msg: AckMsg) => void;
}

/** ホスト専用アクション（プレイヤーを持たない＝ゲストからは受け付けない）。 */
const HOST_ONLY = new Set<Action['type']>(['startRound', 'closeWindow']);

export class HostDriver implements GameDriver {
  readonly players: readonly { id: string; name: string }[];
  readonly totalRounds: number;
  private readonly selfPk: string;
  private readonly deps: HostDriverDeps;
  private state: GameState;
  private listeners = new Set<() => void>();
  private seq = 0;
  private windowDeadline: number | null = null; // performance.now 基準の鳴きウィンドウ満了時刻

  constructor(deps: HostDriverDeps) {
    this.deps = deps;
    this.selfPk = deps.selfPk;
    this.players = deps.players.map((p) => ({ id: p.id, name: p.name }));
    this.state = createGame({
      players: deps.players,
      totalRounds: deps.totalRounds,
      seed: deps.seed ?? ((Date.now() >>> 0) || 1),
    });
    this.totalRounds = this.state.totalRounds;
  }

  // ---- GameDriver 実装（ホスト自席視点） --------------------------------

  getView(playerId: string): PlayerView {
    return deriveViewFor(this.state, playerId);
  }

  currentPlayerId(): string {
    // ネット実装ではローカル自席を返す（types.ts の契約）。手番判定は view.seats[isCurrent] を使う。
    return this.selfPk;
  }

  claimants(): ClaimOption[] {
    // 視界フィルタ: 自席の鳴き可否のみ返す（他家の鳴き可否は漏らさない）。
    const s = this.state;
    if (s.phase !== 'meldWindow' || !s.claimWindow) return [];
    const passed = new Set(s.claimWindow.passed);
    const meIndex = s.players.findIndex((p) => p.id === this.selfPk);
    const me = s.players[meIndex];
    if (!me || passed.has(me.id)) return [];
    const kinds = eligibleClaims(s)
      .filter((c) => c.playerIndex === meIndex)
      .map((c) => c.kind);
    if (kinds.length === 0) return [];
    return [{ playerIndex: meIndex, playerId: me.id, name: me.name, kinds }];
  }

  /** ホスト自身のローカル操作（自席アクション + ホスト専用の startRound/closeWindow/次ラウンド）。 */
  dispatch(action: Action): Promise<ActionResult> {
    if ('player' in action && action.player !== this.selfPk) {
      // ホスト UI は自席のアクションのみ発行する。他席を騙る操作は受け付けない。
      return Promise.resolve({ ok: false, error: 'host: can only act as self' });
    }
    const result = applyAction(this.state, action);
    if (result.ok) this.commit(result.state);
    return Promise.resolve(result);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isAuthority(): boolean {
    return true;
  }

  claimDeadline(): number | null {
    return this.state.phase === 'meldWindow' ? this.windowDeadline : null;
  }

  dispose(): void {
    this.listeners.clear();
  }

  // ---- ゲスト要求のホスト権威検証（E2/E7/E8） ---------------------------

  /**
   * ゲストからのアクション要求を検証・適用する。セッションが 'act' 受信時に呼ぶ。
   * - 送信元 peerId → playerKey を束縛から解決し、最新束縛でなければ無視（残存/二重接続・E8）。
   * - action.player は解決した playerKey と一致必須（なりすまし拒否・E7）。
   * - ホスト専用アクションはゲストから受け付けない。
   * - エンジンが拒否したら要求元のみへ err を返す（他家に漏らさない）。
   */
  handleAction(msg: ActionMsg, fromPeer: string): void {
    const err = (message: string): void => this.deps.sendErr(fromPeer, { reqId: msg.reqId, message });
    const pk = this.deps.resolvePk(fromPeer);
    if (!pk) return; // 未知のピア（名簿にない）: 黙って無視
    if (this.deps.resolvePeer(pk) !== fromPeer) return; // 古い/残存接続からの要求は無視（E8）

    const action = msg.action;
    if (HOST_ONLY.has(action.type)) return err('この操作はホストのみ実行できます');
    if (!('player' in action) || action.player !== pk) return err('不正なプレイヤー指定です');

    const result = applyAction(this.state, action);
    if (!result.ok) return err(this.friendly(action, result.error));
    this.commit(result.state);
    this.deps.sendAck(fromPeer, { reqId: msg.reqId }); // 要求元の保留 Promise を解決させる
  }

  /** 再接続したピア（同 playerKey・新 peerId）へ最新スナップショットを再送する（要件§3.1 復帰）。 */
  resend(peerId: string, pk: string): void {
    this.deps.sendSnap(peerId, this.snapshotFor(pk));
  }

  /** 復帰時（visibilitychange）に全ゲストへ最新スナップショットを再配信する（契約08項目1）。 */
  resendAll(): void {
    this.broadcast();
  }

  /** 現在の権威状態のプレイヤー視点ビュー（ホスト UI 用に外へ渡すためのアクセサ）。 */
  snapshotView(pk: string): PlayerView {
    return deriveViewFor(this.state, pk);
  }

  // ---- 内部 -------------------------------------------------------------

  private commit(next: GameState): void {
    const enteringWindow = next.phase === 'meldWindow' && this.state.phase !== 'meldWindow';
    this.state = next;
    if (enteringWindow) this.windowDeadline = performance.now() + CLAIM_WINDOW_MS;
    if (next.phase !== 'meldWindow') this.windowDeadline = null;
    this.seq += 1;
    this.broadcast();
    this.emit();
  }

  private snapshotFor(pk: string): SnapshotMsg {
    const claimMs =
      this.state.phase === 'meldWindow' && this.windowDeadline != null
        ? Math.max(0, Math.round(this.windowDeadline - performance.now()))
        : null;
    return { seq: this.seq, view: deriveViewFor(this.state, pk), claimMs };
  }

  /** 全ゲストへ各自の視界フィルタ済みスナップショットを配信（ホスト自身は state を直読みするため送らない）。 */
  private broadcast(): void {
    for (const p of this.players) {
      if (p.id === this.selfPk) continue;
      const peer = this.deps.resolvePeer(p.id);
      if (peer) this.deps.sendSnap(peer, this.snapshotFor(p.id));
    }
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private friendly(action: Action, raw: string): string {
    switch (action.type) {
      case 'draw':
        return 'いまはツモできません（手番/フェーズ違い）';
      case 'discard':
        return 'いまは捨てられません';
      case 'publishMeld':
        return '有効なメルドではありません';
      case 'attach':
        return 'このメルドには付け札できません';
      case 'pon':
      case 'chi':
        return '鳴けません（優先順/資格の問題）';
      case 'pass':
        return 'パスできません';
      default:
        return `操作できません（${raw}）`;
    }
  }
}
