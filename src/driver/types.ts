// ドライバ境界（凍結事項・契約02 アーキテクチャ要求）。
// UI/3D 層はここより下（エンジン）に直接触れず、この抽象越しに動作する。
// 契約03 は同一 interface のネットワーク実装（ホスト権威 + WebRTC）を追加できる。
import type { Action, ActionResult, PlayerView } from '../core';

/** 鳴き受付ウィンドウで「今まさに鳴ける」プレイヤー1人分の選択肢。 */
export interface ClaimOption {
  playerIndex: number;
  playerId: string;
  name: string;
  kinds: ('pon' | 'chi')[];
}

/**
 * ゲームドライバ。UI はこの契約のみに依存する。
 * - ローカル実装（本契約 LocalDriver）: エンジン直結・1台で全席を操作するホットシート。
 * - ネットワーク実装（契約03）: dispatch をホストへ送信、getView はホスト配信の
 *   フィルタ済みスナップショットを返す。claimants は自分の分のみ返す。
 * dispatch は非同期契約（ネットワーク往復のため）。
 */
export interface GameDriver {
  readonly players: readonly { id: string; name: string }[];
  readonly totalRounds: number;

  /** 指定プレイヤー視点のフィルタ済みスナップショット。 */
  getView(playerId: string): PlayerView;

  /** ホットシートで「今操作すべき席」の id（ネット実装ではローカル自席）。 */
  currentPlayerId(): string;

  /** 鳴き受付ウィンドウ中の、まだパスしていない鳴き可能者を優先順に返す（先頭が最優先）。 */
  claimants(): ClaimOption[];

  dispatch(action: Action): Promise<ActionResult>;

  /** 状態変化の購読。戻り値は解除関数。 */
  subscribe(listener: () => void): () => void;
}
