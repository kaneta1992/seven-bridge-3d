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

  // ---- 契約03 の後方互換拡張（すべて任意。未実装は既定動作にフォールバック） ----

  /**
   * この端末がエンジンを実行しホスト専用アクション（startRound / closeWindow / 次ラウンド）を
   * 発行できる権威を持つか。省略時は true（ホットシート / ホストは true、ゲストは false）。
   */
  isAuthority?(): boolean;

  /**
   * 鳴きウィンドウ満了の絶対時刻（performance.now 基準 ms）。null は非表示。
   * 省略時は UI が自前で 5 秒を計測する（ホットシート）。ネット実装ではホスト配信の残り時間から算出する。
   */
  claimDeadline?(): number | null;

  /** リソース解放（ネットワーク切断など）。省略可。 */
  dispose?(): void;

  // ---- 契約16 の NPC（ボット）拡張（すべて任意・省略時は NPC 非対応） ----

  /**
   * この対局で NPC（ボット）が担当する席の id 一覧。権威ドライバのみ返す（ゲストは省略/空）。
   * app はこれと isAuthority() を見て BotRunner を起動する。
   */
  botSeats?(): string[];

  /**
   * NPC 席のアクションを権威として直接適用する（BotRunner 専用）。
   * player が botSeats に含まれる席のときのみ受理する。ホスト権威実装ではこの経路は
   * ローカル専用で受信配線を持たないため、なりすまし検証（E7・handleAction）とは衝突しない。
   */
  applyBot?(action: Action): Promise<ActionResult>;
}
