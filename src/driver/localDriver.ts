// ホットシート用ローカルドライバ: ルールエンジンに直結し、1台で全席を順に操作する。
// DOM / Three.js に非依存（テスト可能な純粋ロジック）。
import type { Action, ActionResult, GameState, PlayerView } from '../core';
import { applyAction, createGame, deriveViewFor, eligibleClaims } from '../core';
import type { ClaimOption, GameDriver } from './types';

export interface LocalDriverConfig {
  players: { id: string; name: string }[];
  totalRounds: number;
  seed?: number;
}

export class LocalDriver implements GameDriver {
  readonly players: readonly { id: string; name: string }[];
  readonly totalRounds: number;
  private state: GameState;
  private listeners = new Set<() => void>();

  constructor(config: LocalDriverConfig) {
    this.players = config.players.map((p) => ({ id: p.id, name: p.name }));
    this.state = createGame({
      players: config.players,
      totalRounds: config.totalRounds,
      seed: config.seed ?? ((Date.now() >>> 0) || 1),
    });
    this.totalRounds = this.state.totalRounds;
  }

  getView(playerId: string): PlayerView {
    return deriveViewFor(this.state, playerId);
  }

  currentPlayerId(): string {
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

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
