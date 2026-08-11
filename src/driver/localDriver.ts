// ホットシート用ローカルドライバ: ルールエンジンに直結し、1台で全席を順に操作する。
// DOM / Three.js に非依存（テスト可能な純粋ロジック）。
import type { Action, ActionResult, GameState, PlayerView } from '../core';
import { applyAction, createGame, deriveViewFor, eligibleClaims } from '../core';
import type { ClaimOption, GameDriver } from './types';

export interface LocalDriverConfig {
  players: { id: string; name: string }[];
  totalRounds: number;
  seed?: number;
  /**
   * 1人プレイ（人間1+NPC）の固定自席 id（契約16）。指定時は currentPlayerId が常にこの席を返し、
   * 手番が NPC へ移っても視点・カメラが人間席に固定される（app は getView(currentPlayerId()) を描画）。
   * 未指定は従来のホットシート（手番席が回る＝全席を1台で操作）。
   */
  selfId?: string;
  /** NPC（ボット）が担当する席 id（1人プレイのみ）。applyBot はこの席のみ受理する。 */
  npcIds?: string[];
}

export class LocalDriver implements GameDriver {
  readonly players: readonly { id: string; name: string }[];
  readonly totalRounds: number;
  private state: GameState;
  private listeners = new Set<() => void>();
  private readonly selfId: string | null;
  private readonly npcIds: Set<string>;

  constructor(config: LocalDriverConfig) {
    this.players = config.players.map((p) => ({ id: p.id, name: p.name }));
    this.state = createGame({
      players: config.players,
      totalRounds: config.totalRounds,
      seed: config.seed ?? ((Date.now() >>> 0) || 1),
    });
    this.totalRounds = this.state.totalRounds;
    this.selfId = config.selfId ?? null;
    this.npcIds = new Set(config.npcIds ?? []);
  }

  getView(playerId: string): PlayerView {
    return deriveViewFor(this.state, playerId);
  }

  currentPlayerId(): string {
    // 1人プレイ（selfId 指定）では常に人間席を返す＝視点/カメラが NPC 手番で移動しない（契約16）。
    if (this.selfId) return this.selfId;
    return this.state.players[this.state.currentPlayerIndex]!.id;
  }

  /**
   * 鳴き受付ウィンドウ中の、未パスの鳴き可能者を優先順（先頭=最優先）で返す。
   * ホットシートは全席を1台で操作するため、全席分の選択肢を返してよい（デバッグ用途）。
   * ネットワーク実装では自席分のみに絞る（視界フィルタ・要件§3.1）。
   */
  claimants(): ClaimOption[] {
    const s = this.state;
    if (s.phase !== 'meldWindow' || !s.claimWindow) return [];
    const passed = new Set(s.claimWindow.passed);
    // 1人プレイ（selfId 指定）では自席の鳴き可否のみ返す（HostDriver と同じ視界フィルタ。
    // NPC の鳴きは BotRunner が担うため、人間が NPC の鳴きを操作しないよう自席に絞る・契約16）。
    if (this.selfId) {
      const meIndex = s.players.findIndex((p) => p.id === this.selfId);
      const me = s.players[meIndex];
      if (!me || passed.has(me.id)) return [];
      const kinds = eligibleClaims(s)
        .filter((c) => c.playerIndex === meIndex)
        .map((c) => c.kind);
      return kinds.length ? [{ playerIndex: meIndex, playerId: me.id, name: me.name, kinds }] : [];
    }
    const byPlayer = new Map<number, ClaimOption>();
    // eligibleClaims は優先順（ポン優先・近い順、その後チー）で返る。挿入順を保つ。
    for (const claim of eligibleClaims(s)) {
      const p = s.players[claim.playerIndex]!;
      if (passed.has(p.id)) continue;
      let opt = byPlayer.get(claim.playerIndex);
      if (!opt) {
        opt = { playerIndex: claim.playerIndex, playerId: p.id, name: p.name, kinds: [] };
        byPlayer.set(claim.playerIndex, opt);
      }
      opt.kinds.push(claim.kind);
    }
    return [...byPlayer.values()];
  }

  dispatch(action: Action): Promise<ActionResult> {
    const result = applyAction(this.state, action);
    if (result.ok) {
      this.state = result.state;
      this.emit();
    }
    return Promise.resolve(result);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- NPC（契約16） -----------------------------------------------------

  botSeats(): string[] {
    return [...this.npcIds];
  }

  /** NPC 席のアクションを適用する（BotRunner 専用・player は npcIds のみ許可）。 */
  applyBot(action: Action): Promise<ActionResult> {
    if (!('player' in action) || !this.npcIds.has(action.player)) {
      return Promise.resolve({ ok: false, error: 'applyBot: not an NPC seat' });
    }
    const result = applyAction(this.state, action);
    if (result.ok) {
      this.state = result.state;
      this.emit();
    }
    return Promise.resolve(result);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
