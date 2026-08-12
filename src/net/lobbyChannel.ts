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
const MAX_ADS = 50; // 保持する広告の全体上限（送信 peer 単位・溢れさせ攻撃の防御・契約10項目4）
const HEAL_CHECK_MS = 10_000; // 自己修復の点検間隔（契約35）
const HEAL_STALE_MS = 45_000; // ピア0かつ無活動がこの時間続いたらトランスポートを作り直す

interface LobbyOpts {
  now?: () => number;
}

/** 固定ロビーチャネルへの接続（広告送信・受信の両役）。 */
export class LobbyLink {
  private transport: Transport;
  private send: (ad: RoomAd) => void = () => undefined;
  private readonly now: () => number;
  // 送信 peer ごとに最新1件だけ保持する（1 peer が多数コードで一覧を溢れさせるのを防ぐ・項目4）。
  private readonly ads = new Map<string, { ad: RoomAd; at: number }>();
  private listeners = new Set<(rooms: RoomAd[]) => void>();
  private adTimer = 0;
  private sweepTimer = 0;
  private getAd: (() => RoomAd | null) | null = null;
  private disposed = false;
  // 自己修復（契約35）: nostr 購読のサイレント死・モバイル復帰でロビーが「新規ピアを発見できない」
  // 状態に陥ったら、トランスポートを作り直して復旧する。
  private healFactory: (() => Transport) | null = null;
  private healTimer = 0;
  private lastActivity = 0;
  private onWake: (() => void) | null = null;

  constructor(transport: Transport, opts: LobbyOpts = {}) {
    this.transport = transport;
    this.now = opts.now ?? (() => Date.now());
    this.lastActivity = this.now();
    this.wire(transport);
  }

  /** トランスポートへアクション/イベントを結線する（初期化と自己修復の再生成で共用）。 */
  private wire(transport: Transport): void {
    const [send, recv] = transport.makeAction<RoomAd>(LOBBY_NS);
    this.send = send;
    recv((raw, peer) => this.onAd(raw, peer));
    // 閲覧者がロビーへ入った瞬間に広告を即送する（定期間隔の待ちやモバイルのタイマー
    // 抑制に依存しない・2026-08-11）。広告していない側では postAd が no-op。
    transport.onPeerJoin(() => {
      this.lastActivity = this.now();
      this.postAd();
    });
  }

  /**
   * 自己修復を有効化する（契約35）。ピア0のまま HEAL_STALE_MS 無活動なら、ロビーの
   * トランスポートを factory で作り直す（nostr 購読が静かに切れた端末の復旧）。ピアが居る間は
   * 広告は WebRTC 上を流れるため作り直さない。モバイルの画面復帰/回線復帰でも即点検する。
   */
  enableSelfHeal(factory: () => Transport, checkMs = HEAL_CHECK_MS, staleMs = HEAL_STALE_MS): void {
    if (this.disposed || this.healFactory) return;
    this.healFactory = factory;
    const check = (): void => {
      if (this.disposed || !this.healFactory) return;
      if (this.transport.getPeers().length > 0) {
        this.lastActivity = this.now();
        return;
      }
      if (this.now() - this.lastActivity < staleMs) return;
      this.lastActivity = this.now();
      try {
        this.transport.leave();
      } catch {
        /* leave 失敗は無視（すでに切断済み等） */
      }
      this.transport = this.healFactory();
      this.wire(this.transport);
      this.postAd(); // ホスト側は復旧直後に広告を打ち直す
    };
    this.healTimer = setIntervalSafe(check, checkMs);
    // モバイルのスリープ復帰・回線復帰は即点検（タイマー抑制で checkMs が伸びるため）
    if (typeof window !== 'undefined') {
      this.onWake = check;
      window.addEventListener('online', this.onWake);
      document.addEventListener('visibilitychange', this.onWake);
    }
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

  /** 失効していない公開ルーム一覧（コード単位で重複排除し最新を採用・ホスト名順で安定表示）。 */
  getRooms(): RoomAd[] {
    const t = this.now();
    // ads は peer 単位。同一コードを複数 peer が広告し得るので、コードごとに最新の到着を1件へ畳む。
    const byCode = new Map<string, { ad: RoomAd; at: number }>();
    for (const v of this.ads.values()) {
      if (t - v.at > AD_TTL_MS) continue;
      const cur = byCode.get(v.ad.code);
      if (!cur || v.at > cur.at) byCode.set(v.ad.code, v);
    }
    return [...byCode.values()]
      .map((v) => v.ad)
      .sort((a, b) => a.hostName.localeCompare(b.hostName) || a.code.localeCompare(b.code));
  }

  /** ロビーの接続ピア数（診断表示用・契約35）。 */
  peerCount(): number {
    try {
      return this.transport.getPeers().length;
    } catch {
      return 0;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAdvertising();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = 0;
    if (this.healTimer) clearInterval(this.healTimer);
    this.healTimer = 0;
    this.healFactory = null;
    if (this.onWake && typeof window !== 'undefined') {
      window.removeEventListener('online', this.onWake);
      document.removeEventListener('visibilitychange', this.onWake);
      this.onWake = null;
    }
    this.listeners.clear();
    this.ads.clear();
    this.transport.leave();
  }

  // ---- 内部 -------------------------------------------------------------

  private onAd(raw: unknown, peer: string): void {
    this.lastActivity = this.now(); // 自己修復の無活動判定（契約35）
    const ad = sanitizeRoomAd(raw); // 4項目のみへ整形＋妥当性検証（不正/汚染は破棄・E5-lobby）
    if (!ad) return;
    // 送信 peer ごとに最新1件へ上書き。新規 peer で全体上限を超える分は破棄（項目4）。
    if (!this.ads.has(peer) && this.ads.size >= MAX_ADS) return;
    this.ads.set(peer, { ad, at: this.now() });
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
