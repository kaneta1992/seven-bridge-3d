// 公開ルーム一覧のための固定ロビーチャネル（公開ロビー・要件§3.1 / 契約08項目3）。
// ゲーム本体とは別の Trystero 部屋（LOBBY_ROOM）へ join し、
//   - ホスト（公開ON）: 自室の広告を数秒間隔で送信（開始/満員/解散で停止）
//   - 閲覧者（ロビー画面）: 広告を受信して TTL 失効付きの一覧を保持
// を1クラスに集約する。広告ペイロードは {code, hostName, count, rounds} のみ（不変条件）。
// Transport 境界に依存し trystero を直接は知らない（テストではインメモリ Transport を注入）。
import { LOBBY_NS, sanitizeRoomAd, type RoomAd, type Transport } from './protocol';

const AD_INTERVAL_MS = 3000; // 広告送信間隔（数秒間隔・契約）
const AD_TTL_MS = 8000; // 受信広告の失効時間（この間 未更新なら一覧から消す＝開始/解散/満員で自然消滅）
const SWEEP_MS = 1500; // TTL 掃引間隔

interface LobbyOpts {
  now?: () => number;
}

/** 固定ロビーチャネルへの接続（広告送信・受信の両役）。 */
export class LobbyLink {
  private readonly transport: Transport;
  private readonly send: (ad: RoomAd) => void;
  private readonly now: () => number;
  private readonly ads = new Map<string, { ad: RoomAd; at: number }>();
  private listeners = new Set<(rooms: RoomAd[]) => void>();
  private adTimer = 0;
  private sweepTimer = 0;
  private getAd: (() => RoomAd | null) | null = null;
  private disposed = false;

  constructor(transport: Transport, opts: LobbyOpts = {}) {
    this.transport = transport;
    this.now = opts.now ?? (() => Date.now());
    const [send, recv] = transport.makeAction<RoomAd>(LOBBY_NS);
    this.send = send;
    recv((raw) => this.onAd(raw));
    // 閲覧者がロビーへ入った瞬間に広告を即送する（定期間隔の待ちやモバイルのタイマー
    // 抑制に依存しない・2026-08-11）。広告していない側では postAd が no-op。
    transport.onPeerJoin(() => this.postAd());
  }

  // ---- ホスト側（広告送信） ---------------------------------------------

  /** 広告の定期送信を開始する。getAd が null を返す間は送らない（開始/満員で自然停止）。 */
  startAdvertising(getAd: () => RoomAd | null, intervalMs = AD_INTERVAL_MS): void {
    if (this.disposed) return;
    this.getAd = getAd;
    this.postAd(); // 即時に1回（新規閲覧者を数秒待たせない）
    if (!this.adTimer) this.adTimer = setIntervalSafe(() => this.postAd(), intervalMs);
  }

  stopAdvertising(): void {
    this.getAd = null;
    if (this.adTimer) {
      clearInterval(this.adTimer);
      this.adTimer = 0;
    }
  }

  /** 現在の広告を1回送る（getAd が null を返せば送らない）。送信直前にも4項目へ整形し不変条件を担保。 */
  postAd(): void {
    if (this.disposed) return;
    const ad = sanitizeRoomAd(this.getAd?.() ?? null); // 送信側でも余分フィールドを載せない（契約08不変条件）
    if (ad) this.send(ad);
  }

  // ---- 閲覧側（一覧受信） -----------------------------------------------

  /** TTL 掃引を開始する（受信自体は生成時から常時有効）。 */
  watch(): void {
    if (this.disposed || this.sweepTimer) return;
    this.sweepTimer = setIntervalSafe(() => this.sweep(), SWEEP_MS);
  }

  /** 一覧の変化購読。登録直後に現在値で1回呼ぶ。戻り値は解除関数。 */
  onChange(cb: (rooms: RoomAd[]) => void): () => void {
    this.listeners.add(cb);
    cb(this.getRooms());
    return () => this.listeners.delete(cb);
  }

  /** 失効していない公開ルーム一覧（ホスト名順で安定表示）。 */
  getRooms(): RoomAd[] {
    const t = this.now();
    return [...this.ads.values()]
      .filter((v) => t - v.at <= AD_TTL_MS)
      .map((v) => v.ad)
      .sort((a, b) => a.hostName.localeCompare(b.hostName) || a.code.localeCompare(b.code));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAdvertising();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = 0;
    this.listeners.clear();
    this.ads.clear();
    this.transport.leave();
  }

  // ---- 内部 -------------------------------------------------------------

  private onAd(raw: unknown): void {
    const ad = sanitizeRoomAd(raw); // 4項目のみへ整形＋妥当性検証（不正/汚染は破棄・E5-lobby）
    if (!ad) return;
    this.ads.set(ad.code, { ad, at: this.now() });
    this.emit();
  }

  private sweep(): void {
    const t = this.now();
    let changed = false;
    for (const [k, v] of this.ads) {
      if (t - v.at > AD_TTL_MS) {
        this.ads.delete(k);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  private emit(): void {
    const rooms = this.getRooms();
    for (const l of this.listeners) l(rooms);
  }
}

/** setInterval を number で返す（DOM/Node の型差を吸収）。 */
function setIntervalSafe(fn: () => void, ms: number): number {
  return setInterval(fn, ms) as unknown as number;
}
