// ゲストドライバ（契約03）。エンジンは実行せず、ホストへアクション要求を送り、
// ホスト配信の視界フィルタ済みスナップショットを描画するだけの受動的クライアント。
// 権威状態は持たない（ok 応答用の state はプレースホルダ）。
import type { Action, ActionResult, GameState, PlayerView } from '../core';
import { createGame } from '../core';
import type { ClaimOption, GameDriver } from '../driver/types';
import type { ActionMsg, SnapshotMsg } from './protocol';

export interface GuestDriverDeps {
  selfPk: string;
  players: { id: string; name: string }[];
  totalRounds: number;
  /** ホストへアクション要求を送る（セッションがホスト peer を宛先にする）。 */
  sendAct: (msg: ActionMsg) => void;
}

const ACK_TIMEOUT_MS = 4000;

export class GuestDriver implements GameDriver {
  readonly players: readonly { id: string; name: string }[];
  readonly totalRounds: number;
  private readonly selfPk: string;
  private readonly deps: GuestDriverDeps;
  private view: PlayerView;
  private lastSeq = -1;
  private claimAt: number | null = null; // performance.now 基準の満了時刻（残り時間から算出）
  private listeners = new Set<() => void>();
  private reqCounter = 0;
  private pending = new Map<number, (r: ActionResult) => void>();
  /** ok 応答に返す state はプレースホルダ（ゲストは権威状態を持たない）。app は r.ok のみ参照する。 */
  private readonly ackState: GameState;

  constructor(deps: GuestDriverDeps) {
    this.deps = deps;
    this.selfPk = deps.selfPk;
    this.players = deps.players.map((p) => ({ id: p.id, name: p.name }));
    this.totalRounds = deps.totalRounds;
    this.ackState = createGame({ players: deps.players, totalRounds: deps.totalRounds, seed: 1 });
    this.view = emptyView(deps.players, deps.totalRounds, this.selfPk);
  }

  getView(_playerId: string): PlayerView {
    // ゲストは自席のビューしか持たない（他家分は問い合わせられない＝視界フィルタ）。
    return this.view;
  }

  currentPlayerId(): string {
    return this.selfPk;
  }

  claimants(): ClaimOption[] {
    if (this.view.phase !== 'meldWindow' || this.view.yourClaims.length === 0) return [];
    const me = this.view.seats[this.view.youIndex];
    if (!me) return [];
    return [{ playerIndex: me.index, playerId: this.selfPk, name: me.name, kinds: [...this.view.yourClaims] }];
  }

  dispatch(action: Action): Promise<ActionResult> {
    const reqId = ++this.reqCounter;
    this.deps.sendAct({ reqId, action });
    return new Promise<ActionResult>((resolve) => {
      this.pending.set(reqId, resolve);
      // ホストは受理時に ack、却下時に err を、いずれも reqId 付きで要求元にのみ返す。
      // 取りこぼし対策として楽観タイムアウトで ok に倒す（描画は次スナップショットが正）。
      setTimeout(() => {
        if (this.pending.delete(reqId)) resolve({ ok: true, state: this.ackState });
      }, ACK_TIMEOUT_MS);
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isAuthority(): boolean {
    return false;
  }

  claimDeadline(): number | null {
    return this.view.phase === 'meldWindow' ? this.claimAt : null;
  }

  dispose(): void {
    this.listeners.clear();
    this.pending.clear();
  }

  // ---- ホストからの受信（セッションが配線） -----------------------------

  /** スナップショット適用。古い seq は破棄（順序保証・E3）。 */
  applySnapshot(msg: SnapshotMsg): void {
    if (msg.seq <= this.lastSeq) return; // 古い到着を破棄
    this.lastSeq = msg.seq;
    this.view = msg.view;
    this.claimAt = msg.claimMs == null ? null : performance.now() + msg.claimMs;
    this.emit();
  }

  /** アクション受理の確認（reqId で該当保留要求を成功解決）。 */
  applyAck(reqId: number): void {
    const resolve = this.pending.get(reqId);
    if (resolve) {
      this.pending.delete(reqId);
      resolve({ ok: true, state: this.ackState });
    }
  }

  /** アクション却下の受信（reqId で該当保留要求を失敗解決）。 */
  applyError(reqId: number, message: string): void {
    const resolve = this.pending.get(reqId);
    if (resolve) {
      this.pending.delete(reqId);
      resolve({ ok: false, error: message });
    }
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

/** 開始直後（スナップショット未受信）の空ビュー。名前一覧のみ既知。 */
function emptyView(
  players: { id: string; name: string }[],
  totalRounds: number,
  selfPk: string,
): PlayerView {
  const youIndex = players.findIndex((p) => p.id === selfPk);
  return {
    youIndex,
    hand: [],
    seats: players.map((p, i) => ({
      id: p.id,
      name: p.name,
      index: i,
      handCount: 0,
      isYou: i === youIndex,
      isDealer: false,
      isCurrent: false,
    })),
    melds: [],
    discardPile: [],
    discardTop: null,
    deckCount: 0,
    phase: 'awaitingStart',
    round: 0,
    totalRounds,
    scores: [],
    lastWinner: null,
    finished: false,
    finalWinners: [],
    claimWindow: null,
    yourClaims: [],
  };
}
