// P2P 通信プロトコル定義とトランスポート境界（契約03）。
// ここは「WebRTC の生 API」を薄く抽象化し、ホスト権威のメッセージ型を1か所に集約する。
// Trystero への依存はトランスポート実装（createTrysteroTransport）だけに閉じ込め、
// ドライバ/セッション/テストは Transport interface のみに依存する（実 WebRTC なしで検証可能にする）。
import type { Action, PlayerView } from '../core';

/** Trystero appId（この抽象化された名前空間の中でルームコードを部屋IDにする）。 */
export const APP_ID = 'seven-bridge-3d-v1';

/**
 * 席上限（内部定数・要件§3.1「人数は開始時確定」）。作成UIから人数指定は撤去し、
 * ホストが開始した時点の名簿人数で確定する。満員拒否はこの値で行う。
 */
export const SEAT_CAP = 6;

/**
 * 公開ルーム広告用の固定ロビーチャネルの roomId（公開ロビー・要件§3.1）。
 * generateRoomCode は CODE_ALPHABET の6桁しか生成しないため、ハイフンを含む長い ID は
 * 通常コード空間と衝突しない（予約チャネル）。password も同値で E2E するが広告は公開情報のみ。
 */
export const LOBBY_ROOM = 'seven-lobby-public-v1';

/** 鳴き受付ウィンドウ長（ホスト権威のタイマー基準・要件 D6）。app.ts と一致させる。 */
export const CLAIM_WINDOW_MS = 10000;

/** ゲスト参加時に「ホスト応答なし」と判断してリトライ案内を出すまでの猶予（E1/E5）。 */
export const JOIN_TIMEOUT_MS = 15000;

/** ルームコードの文字集合（紛らわしい 0/O/1/I/L を除外・E6）。 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

/** 英数6桁のルームコードを生成する（暗号乱数・E6）。 */
export function generateRoomCode(): string {
  const buf = new Uint32Array(CODE_LENGTH);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[buf[i]! % CODE_ALPHABET.length];
  return out;
}

/** 入力コードを正規化（大文字化・空白/ハイフン除去・英数のみ抽出）。E6。 */
export function normalizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, CODE_LENGTH);
}

/** 正規化後に 6 桁の英数として妥当か。 */
export function isValidRoomCode(code: string): boolean {
  return /^[0-9A-Z]{6}$/.test(code);
}

/** 各クライアントの安定した席鍵（playerKey）。peerId は再接続で変わるため席同定には使わない（E8）。 */
export function loadOrCreatePlayerKey(code: string): string {
  const storageKey = `sb_pk_${code}`;
  try {
    const existing = globalThis.localStorage?.getItem(storageKey);
    if (existing) return existing;
  } catch {
    /* localStorage 不可（SSR/プライベート制限）なら都度生成 */
  }
  const pk = randomKey();
  try {
    globalThis.localStorage?.setItem(storageKey, pk);
  } catch {
    /* 保存不可でもゲームは成立する（再接続同定のみ弱くなる） */
  }
  return pk;
}

function randomKey(): string {
  const buf = new Uint32Array(4);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => n.toString(36)).join('');
}

// ---- メッセージ型（ホスト権威） -----------------------------------------

/** ゲスト→ホスト: 参加/再接続時の自己申告（席鍵と表示名）。 */
export interface HelloMsg {
  pk: string;
  name: string;
}

export interface RosterMember {
  pk: string;
  name: string;
}

/** ホスト→全員: 待機ルームの名簿と設定（開始前・E1/E2）。公開情報のみ。 */
export interface RosterMsg {
  code: string;
  hostPk: string;
  maxPlayers: number;
  totalRounds: number;
  members: RosterMember[];
  started: boolean;
}

/** ホスト→全員: 対局開始。席順（id=playerKey）とラウンド数を確定して配る。 */
export interface StartMsg {
  players: { id: string; name: string }[];
  totalRounds: number;
}

/**
 * ホスト→各ピア: 視界フィルタ済みの全量スナップショット（要件§3.1）。
 * view は deriveViewFor(state, その席) の結果のみ＝他家手札・山札の中身は含まない。
 * seq は連番。ゲストは古い seq を破棄する（順序保証・E3）。
 * claimMs は鳴きウィンドウ残り時間（ms）または null（配信する残り時間・アーキ要求）。
 */
export interface SnapshotMsg {
  seq: number;
  view: PlayerView;
  claimMs: number | null;
}

/** ゲスト→ホスト: アクション要求（reqId でエラー返信を紐付ける）。 */
export interface ActionMsg {
  reqId: number;
  action: Action;
}

/** ホスト→要求元のみ: アクション却下通知（E2）。 */
export interface ErrMsg {
  reqId: number;
  message: string;
}

/** ホスト→要求元のみ: アクション受理の確認（reqId で保留要求を解決する）。 */
export interface AckMsg {
  reqId: number;
}

/** ホスト→特定ピア: 入室拒否（満員/対局開始後の途中参加・E1）。 */
export interface RejectMsg {
  reason: string;
}

/**
 * 公開ロビーへの広告ペイロード（公開ルーム一覧・要件§3.1）。
 * **この4項目以外を載せない**（契約08不変条件・個人情報/手札情報を含めない）。
 * TTL 失効は受信側がローカルの到着時刻で管理し、ペイロードに時刻を入れない。
 */
export interface RoomAd {
  code: string;
  hostName: string;
  count: number;
  rounds: number;
}

/** 広告名前空間（固定ロビーチャネル）。 */
export const LOBBY_NS = 'ad';

/**
 * 受信広告を4項目のみへ整形し妥当性検証する（外部由来ペイロードの防御・E5-lobby/E4）。
 * 型不一致・コード不正・異常人数は null（破棄）。ここを通ったものだけが一覧に載る。
 */
export function sanitizeRoomAd(raw: unknown): RoomAd | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const code = typeof r.code === 'string' ? normalizeRoomCode(r.code) : '';
  if (!isValidRoomCode(code)) return null;
  const hostName = typeof r.hostName === 'string' ? r.hostName.slice(0, 10) : '';
  const count = typeof r.count === 'number' && Number.isFinite(r.count) ? Math.max(0, Math.min(SEAT_CAP, Math.round(r.count))) : 0;
  const rounds = typeof r.rounds === 'number' && Number.isFinite(r.rounds) ? Math.max(1, Math.min(99, Math.round(r.rounds))) : 1;
  return { code, hostName, count, rounds };
}

/** Trystero makeAction の名前空間（12バイト以内）。 */
export const NS = {
  hello: 'hello',
  roster: 'roster',
  start: 'start',
  snap: 'snap',
  act: 'act',
  err: 'err',
  ack: 'ack',
  reject: 'reject',
} as const;

// ---- トランスポート境界 -------------------------------------------------

export type Sender<T> = (data: T, target?: string | string[] | null) => void;
export type Receiver<T> = (fn: (data: T, peerId: string) => void) => void;

/**
 * 通信トランスポートの最小境界。Trystero の Room をこの形に写像する。
 * テストではインメモリのモックを差し込み、実 WebRTC なしでホスト権威ロジックを検証する。
 */
export interface Transport {
  readonly selfId: string;
  /** namespace ごとに [送信関数, 受信登録関数] を返す。各 namespace は1回だけ生成すること。 */
  makeAction<T>(namespace: string): [Sender<T>, Receiver<T>];
  onPeerJoin(fn: (peerId: string) => void): void;
  onPeerLeave(fn: (peerId: string) => void): void;
  getPeers(): string[];
  leave(): void;
}
