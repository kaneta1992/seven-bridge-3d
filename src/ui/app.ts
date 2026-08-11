// ゲーム全体のオーケストレータ。ドライバ境界（GameDriver）越しに 3D シーンと HUD を駆動する。
// ホットシート（LocalDriver）と通信対戦（HostDriver/GuestDriver）を同じゲーム描画で扱い、
// 差分は driver の任意メソッド（isAuthority / claimDeadline）で吸収する。
// エンジンには直接触れず、状態は driver.getView / claimants から受け取る（付け札の可否判定にのみ
// 純粋関数 canAttach を利用＝ UI アフォーダンス用途で、アクションは必ず driver 経由）。
import type { Action, Card, Meld, PlayerView } from '../core';
import { canAttach, cardId } from '../core';
import { LocalDriver } from '../driver/localDriver';
import type { ClaimOption, GameDriver } from '../driver/types';
import {
  CLAIM_WINDOW_MS,
  generateRoomCode,
  isValidRoomCode,
  loadOrCreatePlayerKey,
  LOBBY_ROOM,
  normalizeRoomCode,
  SEAT_CAP,
  type RoomAd,
  type RosterMember,
} from '../net/protocol';
import { LobbyLink } from '../net/lobbyChannel';
import { NetSession } from '../net/session';
import { createTrysteroTransport } from '../net/trysteroTransport';
import { orderedMeldCards } from '../render/meldSort';
import { TableScene } from '../render/scene';
import { SUIT_COLOR, SUIT_GLYPH } from '../render/suitStyle';
import { AudioKit } from './audio';
import { Callouts, countUp } from './callout';
import { clear, el } from './dom';
import { renderLobby, type CreateRoomConfig, type LobbyResult } from './lobby';
import { renderConnecting, renderJoinPrompt, renderNotice, renderWaitingRoom } from './room';
import { buildScoreTable } from './scoreTable';
import { loadPrefs, savePrefs } from './settings';

// スートのグリフ/配色は render/suitStyle を単一ソースとして共有（4色デッキ・項目2）。
const RANK_LABEL: Record<number, string> = {
  1: 'A', 11: 'J', 12: 'Q', 13: 'K',
};
const rankText = (c: Card): string => RANK_LABEL[c.rank] ?? String(c.rank);
// 鳴きウィンドウ長は protocol.ts（ホスト権威の基準・現在10秒）を単一ソースとして import する（項目13）。

interface WaitInfo {
  code: string;
  members: RosterMember[];
  amHost: boolean;
  maxPlayers: number;
  totalRounds: number;
}

export class GameUI {
  private root: HTMLElement;
  private sceneHost!: HTMLElement;
  private overlay!: HTMLElement;
  private scene: TableScene | null = null;
  private driver: GameDriver | null = null;
  private unsub: (() => void) | null = null;
  private session: NetSession | null = null;
  private waitInfo: WaitInfo | null = null;
  // 公開ルーム: ロビー画面の一覧閲覧チャネル（lobbyBrowser）と、ホストの広告チャネル（advertiser）。
  private lobbyBrowser: LobbyLink | null = null;
  private advertiser: LobbyLink | null = null;

  private selected = new Set<string>();
  // 手札のローカル表示順（cardId の並び）。ユーザーが D&D で決めた相対順序を保持する。
  // エンジンの手札集合には影響せず（src/core 非改変）、3D と DOM の両方へ同一順序を反映する。
  private handOrder: string[] = [];
  // 手札ドラッグ中は driver 由来の再描画（他家アクションのスナップショット等）で .hand DOM が
  // 作り直されないよう render を保留し、pointerup/cancel 後の render() でまとめて反映する。
  private dragging = false;
  // 永続化された手札コンテナとカード要素プール（R4項目3: UIだけの変化＝並び替え/フォーカス/選択では
  // DOM を作り直さず要素を再利用し、transform の transition だけで滑らかに動かす）。
  private bottomEl: HTMLElement | null = null;
  private handEl: HTMLElement | null = null;
  private footerEl: HTMLElement | null = null; // hint + actions（毎 render 作り直し可）
  // 永続コントロール（スコア票/ミュート/視点リセット）。overlay とは別コンテナに保持し renderHud の
  // clear(overlay) で破棄されないようにする（項目8: 毎 render のボタン作り直しでタップが取りこぼされる
  // 不具合の解消）。ボタンとハンドラは beginWithDriver で一度だけ生成し、以後 DOM を作り直さない。
  private controlsEl: HTMLElement | null = null;
  private cardEls = new Map<string, HTMLElement>(); // cardId -> 永続カード要素
  private handCards: { id: string; el: HTMLElement }[] = [];
  private focusedId: string | null = null;
  private lastView: PlayerView | null = null; // 直近の表示順ビュー（ドラッグ操作から参照）
  // メルドの被り解消（契約05項目3）: 2D メルドリストは既定で折り畳み、3D 卓を一次情報にする。
  private meldPanelOpen = false;
  // ツモ演出（R4項目4: 大きめ表示→扇形へスライド→数秒ハイライト）
  private drawnId: string | null = null;
  private drawnBig = false;
  private drawTimers: number[] = [];
  private autoDrawKey = ''; // 自動ツモの発火済み手番キー
  private prevDeckCount = -1;
  private prevTurnKey = '';
  private prevHandIds: string[] = [];
  // 進行中ドラッグの状態
  private drag: { id: string; pointerId: number; startX: number; startY: number; active: boolean } | null =
    null;
  private lastRound = 0;
  private lastPhaseKey = '';
  private claimKey: string | null = null;
  private claimDeadline = 0;
  private claimTimer = 0;
  private timerBar: HTMLElement | null = null;
  private closing = false;
  private toastEl: HTMLElement | null = null;
  private toastTimer = 0;
  // 演出（ジューシー化ラウンド）: SFX・コールアウト・イベント検出用の直近状態
  private audio: AudioKit | null = null;
  private callouts: Callouts | null = null;
  private vignetteEl: HTMLElement | null = null;
  private fxTimers: number[] = [];
  private evRound = -1;
  private prevMeldIds = new Set<number>();
  private prevCurrentSeat = -1;
  private prevDiscardCount = -1;
  private lastClaimCard: Card | null = null;
  private celebratedRound = -1;
  private celebratedGameOver = false;

  constructor(root: HTMLElement) {
    this.root = root;
    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', this.onResize);
    // バックグラウンド復帰時の自動回復（契約08項目1）。可視化・ページ復帰・オンライン復帰で発火。
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pageshow', this.onVisibility);
    window.addEventListener('online', this.onVisibility);
    // URL 直行参加（?room=CODE・契約08項目4）。不正コードは無視して通常ロビーへ（E2）。
    const urlCode = this.roomFromUrl();
    if (urlCode) this.startUrlJoin(urlCode);
    else this.showLobby();
  }

  private onResize = (): void => {
    this.scene?.resize();
    if (this.driver) this.renderScene(this.orderedView());
    this.layoutFan(); // 扇形手札を新しいビューポート幅へ再配置
  };

  private onVisibility = (): void => {
    if (document.visibilityState === 'visible') this.session?.recover();
  };

  private roomFromUrl(): string | null {
    try {
      const raw = new URLSearchParams(location.search).get('room');
      if (!raw) return null;
      const code = normalizeRoomCode(raw);
      return isValidRoomCode(code) ? code : null;
    } catch {
      return null;
    }
  }

  // URL 直行参加: 保存名があれば即参加、無ければ名前入力を挟む（E2）。参加後URLをクリーンしてループ防止（E12追補）。
  private startUrlJoin(code: string): void {
    try {
      history.replaceState(null, '', location.origin + location.pathname);
    } catch {
      /* file:// 等で失敗しても続行 */
    }
    const saved = loadPrefs().name.trim();
    if (saved) {
      this.joinRoom(code, saved);
      return;
    }
    this.teardownGame();
    this.teardownNet();
    clear(this.root);
    renderJoinPrompt(
      this.root,
      code,
      '',
      (name) => {
        savePrefs({ name });
        this.joinRoom(code, name);
      },
      () => this.showLobby(),
    );
  }

  // ---- 画面遷移 ----------------------------------------------------------

  private showLobby(): void {
    this.teardownGame();
    this.teardownNet();
    clear(this.root);
    const lobby = el('div', {});
    this.root.append(lobby);
    renderLobby(lobby, {
      onHotseat: (r) => this.startHotseat(r),
      onCreateRoom: (cfg) => this.createRoom(cfg),
      onJoinRoom: (code, name) => this.joinRoom(code, name),
      watchPublicRooms: (cb) => this.watchPublicRooms(cb),
    });
  }

  // 公開ルーム一覧の購読。初回呼び出しで閲覧用ロビーチャネルを遅延生成する（未閲覧なら接続しない）。
  // チャネル接続失敗はゲーム機能へ波及させず空一覧のまま返す（E4）。
  private watchPublicRooms(cb: (rooms: RoomAd[]) => void): () => void {
    if (!this.lobbyBrowser) {
      try {
        this.lobbyBrowser = new LobbyLink(createTrysteroTransport(LOBBY_ROOM));
        this.lobbyBrowser.watch();
      } catch {
        cb([]);
        return () => {};
      }
    }
    return this.lobbyBrowser.onChange(cb);
  }

  private teardownLobbyBrowser(): void {
    this.lobbyBrowser?.dispose();
    this.lobbyBrowser = null;
  }

  private showNotice(title: string, message: string): void {
    this.teardownGame();
    clear(this.root);
    renderNotice(this.root, title, message, () => this.showLobby());
  }

  private teardownGame(): void {
    this.unsub?.();
    this.unsub = null;
    this.scene?.dispose();
    this.scene = null;
    this.driver?.dispose?.();
    this.driver = null;
    this.callouts?.dispose();
    this.callouts = null;
    this.audio?.dispose();
    this.audio = null;
    this.vignetteEl = null;
    for (const t of this.fxTimers) clearTimeout(t);
    this.fxTimers = [];
    this.evRound = -1;
    this.prevMeldIds = new Set();
    this.prevCurrentSeat = -1;
    this.prevDiscardCount = -1;
    this.lastClaimCard = null;
    this.celebratedRound = -1;
    this.celebratedGameOver = false;
    this.stopClaimTimer();
    this.closing = false; // 鳴きウィンドウ確定中の破棄で closing が残り、次局の閉窓が永久閉塞するのを防ぐ（項目9）
    this.clearDrawTimers();
    this.selected.clear();
    this.handOrder = [];
    this.dragging = false;
    this.bottomEl = null;
    this.handEl = null;
    this.footerEl = null;
    this.controlsEl = null;
    this.cardEls.clear();
    this.handCards = [];
    this.focusedId = null;
    this.meldPanelOpen = false;
    this.drag = null;
    this.drawnId = null;
    this.drawnBig = false;
    this.autoDrawKey = '';
    this.lastView = null;
    this.prevDeckCount = -1;
    this.prevTurnKey = '';
    this.prevHandIds = [];
    this.lastRound = 0;
    this.lastPhaseKey = '';
  }

  private clearDrawTimers(): void {
    for (const t of this.drawTimers) clearTimeout(t);
    this.drawTimers = [];
  }

  private teardownNet(): void {
    this.session?.dispose();
    this.session = null;
    this.advertiser?.dispose();
    this.advertiser = null;
    this.waitInfo = null;
  }

  // ---- ホットシート ------------------------------------------------------

  private startHotseat(cfg: LobbyResult): void {
    this.teardownLobbyBrowser();
    const driver = new LocalDriver({ players: cfg.players, totalRounds: cfg.totalRounds });
    this.beginWithDriver(driver);
  }

  // ---- 通信対戦: ルーム作成（ホスト） -----------------------------------

  private createRoom(cfg: CreateRoomConfig): void {
    this.teardownGame();
    this.teardownNet();
    this.teardownLobbyBrowser();
    const code = generateRoomCode();
    const pk = loadOrCreatePlayerKey(code);
    const transport = createTrysteroTransport(code);
    const session = NetSession.host(
      code,
      pk,
      cfg.name,
      transport,
      { maxPlayers: SEAT_CAP, totalRounds: cfg.totalRounds },
      () => createTrysteroTransport(code),
    );
    this.session = session;
    this.wireSession(session);
    this.waitInfo = {
      code,
      members: [{ pk, name: cfg.name }],
      amHost: true,
      maxPlayers: SEAT_CAP,
      totalRounds: cfg.totalRounds,
    };
    // 公開ONなら固定ロビーチャネルへ広告を開始（開始/満員/解散で停止）。広告は4項目のみ（不変条件）。
    if (cfg.isPublic) {
      try {
        this.advertiser = new LobbyLink(createTrysteroTransport(LOBBY_ROOM));
        this.advertiser.startAdvertising(() => this.currentRoomAd());
      } catch {
        this.advertiser = null; // 広告失敗はゲーム進行に影響させない（E4）
      }
    }
    this.renderWaiting();
  }

  // 広告ペイロード。待機中かつ未満員のときだけ値を返し、開始/満員では null（送信停止→TTL失効・E10追補）。
  private currentRoomAd(): RoomAd | null {
    const info = this.waitInfo;
    if (!info || !info.amHost || this.driver) return null; // driver 有＝対局開始後
    if (info.members.length >= SEAT_CAP) return null; // 満員は載せない
    return {
      code: info.code,
      hostName: info.members[0]?.name ?? 'ホスト',
      count: info.members.length,
      rounds: info.totalRounds,
    };
  }

  // ---- 通信対戦: ルーム参加（ゲスト） -----------------------------------

  private joinRoom(code: string, name: string): void {
    this.teardownGame();
    this.teardownNet();
    this.teardownLobbyBrowser();
    const pk = loadOrCreatePlayerKey(code);
    const transport = createTrysteroTransport(code);
    const session = NetSession.guest(code, pk, name, transport, () => createTrysteroTransport(code));
    this.session = session;
    this.wireSession(session);
    clear(this.root);
    renderConnecting(this.root, code, () => this.showLobby());
  }

  private wireSession(session: NetSession): void {
    session.on('roster', (members, amHost, info) => {
      this.waitInfo = { members, amHost, code: info.code, maxPlayers: info.maxPlayers, totalRounds: info.totalRounds };
      // 対局開始後はゲーム画面を維持（roster は開始前のみ発火）。
      if (!this.driver) this.renderWaiting();
    });
    session.on('started', (driver) => {
      // 対局開始で公開広告を停止（TTL失効で一覧から消える・E10追補）。ロビー接続も閉じる。
      this.advertiser?.dispose();
      this.advertiser = null;
      this.beginWithDriver(driver);
    });
    session.on('error', (message) => this.showNotice('接続できませんでした', message));
    session.on('fatal', (message) => this.showNotice('ゲーム終了', message));
  }

  private renderWaiting(): void {
    if (!this.waitInfo || !this.session) return;
    const info = this.waitInfo;
    clear(this.root);
    renderWaitingRoom(this.root, {
      code: info.code,
      members: info.members,
      amHost: info.amHost,
      maxPlayers: info.maxPlayers,
      totalRounds: info.totalRounds,
      canStart: info.amHost && info.members.length >= 2,
      onStart: () => this.startHostGame(),
      onLeave: () => this.showLobby(),
    });
  }

  // ホスト: 開始ボタン。ボタン活性だけに頼らず人数を再確認し、2人未満はトーストで拒否する（項目5）。
  private startHostGame(): void {
    const info = this.waitInfo;
    if (!info || !this.session) return;
    if (info.members.length < 2) {
      this.toast('2人以上そろってから開始できます');
      return;
    }
    this.session.startGame();
  }

  // ---- ゲーム開始（共通） ------------------------------------------------

  private beginWithDriver(driver: GameDriver): void {
    this.teardownGame();
    clear(this.root);
    this.sceneHost = el('div', { id: 'scene' });
    this.overlay = el('div', { class: 'overlay' });
    // 手札は overlay とは別の永続コンテナに保持し、renderHud の作り直し対象から外す（R4項目3）。
    this.handEl = el('div', { class: 'hand fan' });
    this.footerEl = el('div', { class: 'footer' });
    this.bottomEl = el('div', { class: 'bottom' }, [this.handEl, this.footerEl]);
    this.toastEl = el('div', { class: 'toast' });
    this.vignetteEl = el('div', { class: 'vignette' }); // 画面周縁を落とす映画的ビネット（3D品質）
    this.controlsEl = el('div', { class: 'controls' }); // 永続コントロール（項目8）
    this.root.append(this.sceneHost, this.vignetteEl, this.overlay, this.controlsEl, this.bottomEl, this.toastEl);
    this.attachHandContainer(this.handEl);

    // SFX とコールアウト層。コールアウトは overlay とは別に root 直下へ（最前面・pointer 透過）。
    this.audio = new AudioKit();
    this.callouts = new Callouts(this.root);
    this.buildControls(); // 永続ボタン群を一度だけ生成（audio 生成後にミュート状態を反映）

    this.scene = new TableScene(this.sceneHost);
    this.driver = driver;
    this.unsub = driver.subscribe(() => this.render());
    // 権威者（ホットシート/ホスト）だけが最初のラウンドを配る。ゲストはスナップショットで受け取る。
    if (driver.isAuthority?.() ?? true) void driver.dispatch({ type: 'startRound' });
    this.render();
  }

  // ---- 描画 --------------------------------------------------------------

  private currentView(): PlayerView {
    const d = this.driver!;
    return d.getView(d.currentPlayerId());
  }

  private isMyTurn(view: PlayerView): boolean {
    return view.seats[view.youIndex]?.isCurrent ?? false;
  }

  // 鳴きウィンドウ中、この端末に鳴ける席があるか（項目3: 鳴き選択UI・カウントダウンの秘匿判定）。
  // ネット実装の claimants() は視界フィルタで自席分のみを返すため、非対象者では空になる。
  // ホットシートは全席を1台で操作するため常に非空＝現行どおり表示される（秘匿対象外）。
  private amClaimant(view: PlayerView): boolean {
    return view.phase === 'meldWindow' && this.driver!.claimants().length > 0;
  }

  // 手札をローカル表示順（handOrder）に並べ替えて返す。同時に handOrder を現在の手札集合へ
  // 追従させる（消えた id を除去し、ツモ等で増えた新規カードはエンジン順のまま末尾へ追加）。
  // 冪等なので renderScene / render のどちらから呼んでも安全。
  private applyHandOrder(hand: Card[]): Card[] {
    const byId = new Map(hand.map((c) => [cardId(c), c] as const));
    const ordered: Card[] = [];
    for (const id of this.handOrder) {
      const c = byId.get(id);
      if (c) {
        ordered.push(c);
        byId.delete(id);
      }
    }
    // 残った id は今回新しく手に入ったカード（ツモ・鳴き後の受け入れ等）→ エンジン順で末尾に足す
    for (const c of hand) {
      if (byId.has(cardId(c))) ordered.push(c);
    }
    this.handOrder = ordered.map((c) => cardId(c));
    return ordered;
  }

  // 手札を表示順に差し替えたビュー（3D と HUD の両方に同一順序を渡すため）。
  private orderedView(): PlayerView {
    const view = this.currentView();
    return { ...view, hand: this.applyHandOrder(view.hand) };
  }

  private renderScene(view: PlayerView): void {
    if (!this.scene) return;
    this.scene.update(view);
  }

  private render(): void {
    if (!this.driver || !this.scene) return;
    // 手札ドラッグ中は再描画を保留（DOM 作り直しでドラッグ・確定順序が失われるのを防ぐ）。
    // 他家アクションで手札枚数は変わらないため、pointerup/cancel 後の再描画で整合する。
    if (this.dragging) return;
    const view = this.currentView();

    // ラウンドが進んだらカードを一掃して配札演出を作る（新配札で並び順もリセット＝自然な新順序）
    if (view.round !== this.lastRound && view.round > 0 && view.phase !== 'gameOver') {
      this.scene.clearCards();
      this.lastRound = view.round;
      this.selected.clear();
      this.handOrder = [];
      // 配札のリズミカルな効果音（3D 側のスタッガ配札に同期）
      for (let i = 0; i < 12; i++) {
        this.fxTimers.push(window.setTimeout(() => this.audio?.deal(i), i * 45));
      }
    }
    // フェーズ/手番が変わったら選択解除
    const phaseKey = `${view.phase}:${view.youIndex}:${view.round}`;
    if (phaseKey !== this.lastPhaseKey) {
      this.selected.clear();
      this.lastPhaseKey = phaseKey;
    }

    const oview: PlayerView = { ...view, hand: this.applyHandOrder(view.hand) };
    // ツモ検出（R4項目4）: 同一プレイヤー・同一ラウンドで山札が1枚減り手札が1枚増えた＝ツモ。
    this.detectDraw(oview);
    this.lastView = oview;
    this.renderScene(oview);
    this.handleEvents(view); // 演出イベント検出（メルド/鳴き/手番交代/上がり）はビュー差分から判定
    this.renderHud(oview);
    this.updateBottom(oview);
    this.syncClaimTimer(oview);
  }

  // ビュー差分からゲームイベントを検出し、3D エフェクト・コールアウト・SFX を発火する。
  // アクションの発生源（自分/他家/スナップショット）に依存しない横断的検出（E2: 進行を阻害しない）。
  private handleEvents(view: PlayerView): void {
    if (!this.scene) return;
    const seatIndexById = new Map(view.seats.map((s) => [s.id, s.index] as const));
    const curSeat = view.seats.find((s) => s.isCurrent)?.index ?? view.youIndex;

    // ラウンドが変わったら検出基準をリセット（前ラウンドのメルドIDや手番で誤発火しないように）
    if (view.round !== this.evRound) {
      this.evRound = view.round;
      this.prevMeldIds = new Set(view.melds.map((m) => m.id));
      this.prevCurrentSeat = curSeat;
      this.prevDiscardCount = view.discardPile.length;
      this.lastClaimCard = null;
    }

    // 鳴きウィンドウ中は対象の捨て札を控えておく（新メルドがポン/チーか公開かの判別に使う）
    if (view.phase === 'meldWindow' && view.claimWindow) {
      this.lastClaimCard = view.claimWindow.card;
    }

    // 新規メルド → 鳴き（ポン/チー）か自主公開かを判別して決め演出
    for (const m of view.melds) {
      if (this.prevMeldIds.has(m.id)) continue;
      const seat = seatIndexById.get(m.owner) ?? curSeat;
      const claimCard = this.lastClaimCard;
      const isClaim = claimCard != null && m.cards.some((c) => cardId(c) === cardId(claimCard));
      if (isClaim) {
        const kind: 'pon' | 'chi' = m.kind === 'sequence' ? 'chi' : 'pon';
        this.scene.claimEffect(seat, kind);
        this.callouts?.show(kind === 'pon' ? 'ポン！' : 'チー！', kind);
        if (kind === 'pon') this.audio?.pon();
        else this.audio?.chi();
      } else {
        this.scene.publishEffect(seat);
        this.callouts?.show('メルド！', 'meld');
        this.audio?.meld();
      }
    }
    this.prevMeldIds = new Set(view.melds.map((m) => m.id));
    if (view.phase !== 'meldWindow') this.lastClaimCard = null;

    // 捨て札が増えた → 捨て音
    if (this.prevDiscardCount >= 0 && view.discardPile.length > this.prevDiscardCount) {
      this.audio?.discard();
    }
    this.prevDiscardCount = view.discardPile.length;

    // 手番交代バナー（通常プレイ中のみ・鳴き受付や配札待ちでは出さない）
    if (
      this.prevCurrentSeat >= 0 &&
      curSeat !== this.prevCurrentSeat &&
      (view.phase === 'awaitingDraw' || view.phase === 'awaitingDiscard')
    ) {
      const name = view.seats.find((s) => s.index === curSeat)?.name ?? '';
      this.callouts?.showBanner(`${name} さんの手番`);
      this.audio?.turn();
    }
    this.prevCurrentSeat = curSeat;

    // 上がり / 流局（ラウンド終了）のセレブレーション（ラウンドごとに1回）
    if (view.phase === 'roundOver' && this.celebratedRound !== view.round) {
      this.celebratedRound = view.round;
      if (view.lastWinner) {
        const seat = seatIndexById.get(view.lastWinner) ?? curSeat;
        this.scene.celebrate(seat);
        this.callouts?.show('上がり！', 'win');
        this.audio?.win();
      } else {
        this.callouts?.show('流局', 'draw-round');
      }
    }
    // ゲーム終了の大団円（1回）
    if (view.phase === 'gameOver' && !this.celebratedGameOver) {
      this.celebratedGameOver = true;
      this.scene.celebrate(view.youIndex);
      this.callouts?.show('ゲーム終了！', 'go');
      this.audio?.win();
    }
  }

  // overlay（上部HUD・メルド・鳴き・モーダル）のみを作り直す。手札は永続コンテナで別管理（項目3）。
  private renderHud(view: PlayerView): void {
    clear(this.overlay);
    // 永続コントロールはゲーム終了の結果画面では隠す（結果画面が全面を占めるため）。
    if (this.controlsEl) this.controlsEl.style.display = view.phase === 'gameOver' ? 'none' : '';
    if (view.phase === 'gameOver') {
      this.overlay.append(this.buildResult(view));
      return;
    }
    this.overlay.append(this.buildTopbar(view));
    this.overlay.append(this.buildMelds(view));
    // 鳴き選択UI・カウントダウンは鳴ける本人にのみ表示（項目3・秘匿）。非対象者にはパネルを出さない。
    // 満了確定（closeWindow）はパネルとは独立に syncClaimTimer/tickClaim が権威側で駆動する（E2）。
    this.timerBar = null; // 前 render のバー参照を破棄（非対象者はバーを持たない）
    if (view.phase === 'meldWindow' && this.amClaimant(view)) {
      this.overlay.append(this.buildClaimPanel(view));
    }
    if (view.phase === 'roundOver') {
      this.overlay.append(this.buildRoundOver(view));
    }
  }

  // 永続コントロール（スコア票/ミュート/視点リセット）を一度だけ構築する（項目8）。overlay の
  // 作り直し（renderHud）から独立した controlsEl 内に置くため、ボタン要素とハンドラは全 render を
  // 通じて同一のまま生き続ける＝タップ/クリックが render のタイミングで取りこぼされない。
  private buildControls(): void {
    const host = this.controlsEl;
    if (!host) return;
    clear(host);
    // スコア票: 常に最新ビューで開く（openScoreModal を this.currentView() で呼ぶため、HUD を
    // 作り直さなくても表示内容は最新になる）。
    const scoreBtn = el('button', { text: 'スコア票' });
    scoreBtn.onclick = () => {
      this.audio?.click();
      this.openScoreModal(this.currentView());
    };
    const muteBtn = el('button', {
      class: 'icon',
      text: this.audio?.isMuted() ? '🔇' : '🔊',
      title: '効果音のオン/オフ',
    });
    muteBtn.onclick = () => {
      const m = this.audio?.toggleMute();
      muteBtn.textContent = m ? '🔇' : '🔊';
    };
    // 視点リセット（契約07項目1）: ピンチ/スワイプで動かしたカメラを自席の既定視点へ戻す。
    const resetBtn = el('button', { class: 'icon', text: '🎯', title: '視点を自席へ戻す' });
    resetBtn.onclick = () => {
      this.scene?.resetView();
      this.audio?.click();
    };
    host.append(resetBtn, muteBtn, scoreBtn);
  }

  private buildTopbar(view: PlayerView): HTMLElement {
    const current = view.seats.find((s) => s.isCurrent);
    // 鳴き受付中の表示は「鳴ける本人」にのみ出す。非対象者は通常の手番待ち表示のまま（項目3・秘匿）。
    const turnText =
      view.phase === 'meldWindow' && this.amClaimant(view)
        ? '鳴き受付中…'
        : view.phase === 'awaitingStart'
          ? '配札待ち…'
          : `${current?.name ?? '-'} さんの手番`;
    // 操作ボタン群は controlsEl（永続）へ分離済み。topbar は手番表示とピルのみ。右上は controls の
    // ためにあける（pill を左寄せ→spacer で右を空ける）。
    return el('div', { class: 'topbar' }, [
      el('span', { class: 'turn', text: turnText }),
      el('span', { class: 'pill', text: `ラウンド ${view.round}/${view.totalRounds}` }),
      el('span', { class: 'pill', text: `山札 ${view.deckCount}` }),
      el('span', { class: 'spacer' }),
    ]);
  }

  // メルドは 3D 卓が一次情報。2D は画面右上のコンパクトなトグル式ミニリストに退避し、3D の視界を確保する
  // （契約05項目3）。展開時は付け札の 2D タップ/ドロップ導線も残す（3D 直接D&Dの補助）。
  private buildMelds(view: PlayerView): HTMLElement {
    const list = el('div', { class: 'melds' });
    const nameOf = (id: string): string => view.seats.find((s) => s.id === id)?.name ?? '?';
    const sel = this.selectedCards(view);
    const attachCard = sel.length === 1 ? sel[0]! : null;
    const meId = this.driver!.currentPlayerId();
    const hasOwnMeld = view.melds.some((m) => m.owner === meId);
    const myTurn = this.isMyTurn(view);

    for (const meld of view.melds) {
      const attachable =
        myTurn && hasOwnMeld && attachCard != null && view.phase === 'awaitingDiscard' && canAttach(meld, attachCard);
      const kindLabel = meld.kind === 'lone7' ? '単独7' : meld.kind === 'group' ? '組' : '列';
      const node = el('div', { class: 'meld' + (attachable ? ' attachable' : '') }, [
        el('span', { class: 'owner', text: `${nameOf(meld.owner)}·${kindLabel}` }),
      ]);
      node.dataset.meldId = String(meld.id);
      // 表示順に整列（連番はランク順・組はスート順）。core のメルドは不変に保つ（E8）。
      for (const c of orderedMeldCards(meld)) node.append(this.chip(c));
      if (attachable) {
        node.onclick = () =>
          void this.dispatch({ type: 'attach', player: meId, meldId: meld.id, card: attachCard! }, () =>
            this.selected.clear(),
          );
      }
      list.append(node);
    }
    if (view.melds.length === 0) {
      list.append(el('span', { class: 'hint', text: '場にメルドはまだありません' }));
    }

    const panel = el('div', { class: 'meldpanel' + (this.meldPanelOpen ? ' open' : '') });
    const chev = el('span', { class: 'chev', text: this.meldPanelOpen ? '▾' : '▸' });
    const header = el('button', { class: 'meldtoggle' }, [
      el('span', { text: `場のメルド ${view.melds.length}` }),
      chev,
    ]);
    header.onclick = () => {
      this.meldPanelOpen = !this.meldPanelOpen;
      panel.classList.toggle('open', this.meldPanelOpen);
      chev.textContent = this.meldPanelOpen ? '▾' : '▸';
    };
    panel.append(header, list);
    return panel;
  }

  private chip(c: Card): HTMLElement {
    const e = el('span', { class: 'chip', text: `${rankText(c)}${SUIT_GLYPH[c.suit]}` });
    e.style.color = SUIT_COLOR[c.suit]; // 4色デッキ（項目2）
    return e;
  }

  private selectedCards(view: PlayerView): Card[] {
    return view.hand.filter((c) => this.selected.has(cardId(c)));
  }

  // 永続の手札コンテナ（beginWithDriver 生成）に対し、カード要素の追加/削除のみ差分適用し、
  // 並び順・選択・フォーカス・フッター（ヒント/ボタン）を更新する（R4項目3: 作り直さない）。
  private updateBottom(view: PlayerView): void {
    if (!this.bottomEl || !this.handEl || !this.footerEl) return;
    const hideHand = view.phase === 'roundOver' || view.phase === 'gameOver';
    this.bottomEl.style.display = hideHand ? 'none' : '';
    if (hideHand) {
      for (const [, e] of this.cardEls) e.remove();
      this.cardEls.clear();
      this.handCards = [];
      clear(this.footerEl);
      return;
    }
    const newIds = this.reconcileHand(view);
    this.buildFooter(view);
    this.layoutFan();
    if (newIds.length) {
      // 入場: transition を戻してから entering(opacity:0) を解除し、フェードインさせる。
      // 位置はすでに layoutFan で確定済みなので「隅から配り直す」動きにはならない（項目3）。
      requestAnimationFrame(() => {
        for (const id of newIds) {
          const e = this.cardEls.get(id);
          if (!e) continue;
          void e.offsetWidth; // reflow を確定
          e.style.transition = '';
          e.classList.remove('entering');
        }
      });
    }
    if (this.drawnId) {
      this.cardEls.get(this.drawnId)?.classList.add('drawn');
      this.layoutFan();
    }
  }

  private createCardEl(c: Card): HTMLElement {
    const e = el('div', { class: 'card' });
    e.style.color = SUIT_COLOR[c.suit]; // 4色デッキ（項目2）
    e.dataset.cardId = cardId(c);
    e.append(el('div', { class: 'big', text: rankText(c) }));
    e.append(el('div', { text: SUIT_GLYPH[c.suit] }));
    return e;
  }

  // カード要素を差分同期（新規は entering フェード、消えたものは除去）。handCards を表示順に再構築。
  private reconcileHand(view: PlayerView): string[] {
    const hand = this.handEl!;
    const myTurn = this.isMyTurn(view);
    const canReorder = view.hand.length > 0;
    const activeTurn = myTurn && (view.phase === 'awaitingDraw' || view.phase === 'awaitingDiscard');
    const desired = new Set(view.hand.map((c) => cardId(c)));
    for (const [id, e] of this.cardEls) {
      if (!desired.has(id)) {
        e.remove();
        this.cardEls.delete(id);
      }
    }
    const newIds: string[] = [];
    for (const c of view.hand) {
      const id = cardId(c);
      let e = this.cardEls.get(id);
      if (!e) {
        e = this.createCardEl(c);
        e.style.transition = 'none';
        e.classList.add('entering');
        hand.appendChild(e);
        this.cardEls.set(id, e);
        newIds.push(id);
      }
      e.classList.toggle('sel', this.selected.has(id));
      e.classList.toggle('draggable', canReorder);
      e.classList.toggle('dim', !activeTurn);
      e.classList.toggle('drawn', id === this.drawnId);
    }
    this.handCards = view.hand.map((c) => ({ id: cardId(c), el: this.cardEls.get(cardId(c))! }));
    return newIds;
  }

  // フッター（ヒント + アクションボタン）。D&D のフォールバックとしてボタン操作を常設（アクセシビリティ）。
  private buildFooter(view: PlayerView): void {
    const footer = this.footerEl!;
    clear(footer);
    const myTurn = this.isMyTurn(view);
    const actions = el('div', { class: 'actions' });
    const hint = el('div', { class: 'hint' });
    const me = this.driver!.currentPlayerId();
    const sel = this.selectedCards(view);
    if (!myTurn && (view.phase === 'awaitingDraw' || view.phase === 'awaitingDiscard')) {
      const current = view.seats.find((s) => s.isCurrent);
      hint.textContent = `${current?.name ?? '他のプレイヤー'} さんの手番です…`;
    } else if (myTurn && view.phase === 'awaitingDraw') {
      // ターン開始時の自動ツモ（2026-08-10 ユーザー要望）。手番キーごとに1回だけ発火し、
      // 失敗時はキーを戻して次renderで再試行する。少し間を置き手番バナーと演出順を整える。
      hint.textContent = '山札からツモっています…';
      const key = `${view.round}:${view.youIndex}:${view.deckCount}:${view.hand.length}`;
      if (this.autoDrawKey !== key) {
        this.autoDrawKey = key;
        this.fxTimers.push(
          window.setTimeout(() => {
            const v = this.lastView;
            if (!this.driver || !v || !this.isMyTurn(v) || v.phase !== 'awaitingDraw') return;
            const player = this.driver.currentPlayerId();
            void (async () => {
              const r = await this.driver!.dispatch({ type: 'draw', player });
              if (!r.ok) this.autoDrawKey = '';
            })();
          }, 450),
        );
      }
    } else if (myTurn && view.phase === 'awaitingDiscard') {
      hint.textContent =
        sel.length === 0
          ? 'カードを上へドラッグ（場=メルド公開／捨て札=捨てる）、メルドへドロップで付け札。ボタンも可。'
          : sel.length === 1
            ? '「捨てる」か、場のメルドへドラッグ/タップで付け札。'
            : '「メルド公開」または選択カードを場へドラッグで公開。';
      const canPublishSel = (sel.length === 1 && sel[0]!.rank === 7) || sel.length >= 3;
      const meldBtn = el('button', { text: 'メルド公開' }) as HTMLButtonElement;
      meldBtn.disabled = !canPublishSel;
      meldBtn.onclick = () => void this.publishMeld(sel);
      const discardBtn = el('button', { class: 'gold', text: '捨てる' }) as HTMLButtonElement;
      discardBtn.disabled = sel.length !== 1;
      discardBtn.onclick = () =>
        void this.dispatch({ type: 'discard', player: me, card: sel[0]! }, () => this.selected.clear());
      actions.append(meldBtn, discardBtn);
    }
    footer.append(hint, actions);
  }

  // ---- 手札コンテナの委譲ポインタ処理（R4項目1: フォーカスはDOM境界でなくポインタxの最寄り） ----

  private attachHandContainer(hand: HTMLElement): void {
    const THRESHOLD = 8;
    hand.addEventListener('pointerdown', (e) => {
      if (this.drag) return;
      const cardEl = (e.target as HTMLElement).closest('.card') as HTMLElement | null;
      const id = cardEl?.dataset.cardId;
      if (!id || !this.lastView || this.lastView.hand.length === 0) return;
      // ツモ演出（中央大表示）中に手札へ触れたら dwell を即キャンセルし、通常のフォーカス/ドラッグへ
      // 明け渡す（E9: 演出がユーザー操作を妨げない）。ハイライト（drawn グロー）は満了まで維持。
      if (this.drawnBig) this.drawnBig = false;
      this.drag = { id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, active: false };
      hand.setPointerCapture(e.pointerId);
      this.focusedId = id;
      this.layoutFan();
    });
    hand.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (d && e.pointerId === d.pointerId) {
        if (!d.active && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < THRESHOLD) return;
        if (!d.active) {
          d.active = true;
          this.dragging = true;
          this.cardEls.get(d.id)?.classList.add('dragging');
          this.scene?.setHandDragging(true); // 卓ドラッグ中はカメラ操作を止める（項目10）
          this.beginDragVisuals();
        }
        e.preventDefault();
        this.moveDrag(d.id, e.clientX, e.clientY);
        return;
      }
      if (this.dragging) return;
      this.focusNearest(e.clientX); // ホバー: ポインタx最寄りをフォーカス（振動しない）
    });
    const finish = (e: PointerEvent): void => {
      const d = this.drag;
      if (!d || e.pointerId !== d.pointerId) return;
      if (hand.hasPointerCapture(d.pointerId)) hand.releasePointerCapture(d.pointerId);
      const { id, active } = d;
      this.drag = null;
      this.scene?.setHandDragging(false); // 卓ドラッグ終了でカメラ操作を再開（項目10）
      const cardEl = this.cardEls.get(id);
      cardEl?.classList.remove('dragging');
      if (!active) {
        // タップ = 選択トグル（自分の捨てフェーズのみ）
        this.focusedId = null;
        const v = this.lastView;
        if (v && this.isMyTurn(v) && v.phase === 'awaitingDiscard') {
          if (this.selected.has(id)) this.selected.delete(id);
          else this.selected.add(id);
        }
        this.render();
        return;
      }
      this.dragging = false;
      this.focusedId = null;
      this.clearMeldHighlight();
      // 重要: hideDropTargets は resolveDrop の後に呼ぶ（2026-08-11 修正）。
      // hideDropTargets は attachableMelds を消すため、先に呼ぶと dropTargetAt のメルド判定
      // （メッシュゲート・ゾーンフォールバックとも）が全て素通りし「場=公開」へ化けて
      // 「有効なメルドではありません」になる（ユーザー報告の付け札不能の真因）。
      const resolved = this.resolveDrop(id, e.clientX, e.clientY);
      this.scene?.hideDropTargets();
      if (resolved) return; // 成功 dispatch → subscribe で render
      this.commitOrder();
      this.render();
    };
    hand.addEventListener('pointerup', finish);
    hand.addEventListener('pointercancel', finish);
    hand.addEventListener('pointerleave', () => {
      if (this.dragging || this.drag?.active) return;
      if (this.focusedId !== null) {
        this.focusedId = null;
        this.layoutFan();
      }
    });
  }

  // ポインタ x に最も近い扇スロット（不変の基準座標）を持つカードをフォーカスする。
  private focusNearest(clientX: number): void {
    const hand = this.handEl;
    const n = this.handCards.length;
    if (!hand || n === 0) return;
    const rect = hand.getBoundingClientRect();
    const W = hand.clientWidth || rect.width;
    const cardW = this.handCards[0]!.el.offsetWidth || 58;
    const half = (n - 1) / 2;
    const idealStep = cardW * 0.72;
    const maxSpread = Math.max(cardW, W - cardW - 12);
    const step = n > 1 ? Math.min(idealStep, maxSpread / (n - 1)) : 0;
    const relX = clientX - rect.left;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      const cx = W / 2 + (i - half) * step;
      const d = Math.abs(relX - cx);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    const id = this.handCards[best]!.id;
    if (id !== this.focusedId) {
      this.focusedId = id;
      this.layoutFan();
    }
  }

  // ドラッグ中のカードを、他カードの中心 x と比較して handCards 配列の適切な位置へ移動する。
  private reorderDuringDrag(dragId: string, clientX: number): void {
    const cards = this.handCards;
    const from = cards.findIndex((c) => c.id === dragId);
    if (from < 0) return;
    let to = 0;
    for (const { id, el: e } of cards) {
      if (id === dragId) continue;
      const r = e.getBoundingClientRect();
      if (clientX > r.left + r.width / 2) to++;
    }
    to = Math.max(0, Math.min(cards.length - 1, to));
    if (to === from) return;
    const [item] = cards.splice(from, 1);
    cards.splice(to, 0, item!);
  }

  private commitOrder(): void {
    this.handOrder = this.handCards.map((c) => c.id);
  }

  // ---- ドラッグ中の挙動・ドロップゾーン（R4項目2/5） --------------------

  // ドラッグ開始時に 3D 卓上の全ドロップ先（捨て札・場・付け札可能メルド）を同時に光らせる（E5）。
  private beginDragVisuals(): void {
    const v = this.lastView;
    if (!(v && this.isMyTurn(v) && v.phase === 'awaitingDiscard')) return;
    const card = this.drag ? v.hand.find((c) => cardId(c) === this.drag!.id) ?? null : null;
    this.scene?.showDropTargets(this.attachableMeldIds(v, card));
  }

  private canPlayNow(): boolean {
    const v = this.lastView;
    return !!v && this.isMyTurn(v) && v.phase === 'awaitingDiscard';
  }

  // 付け札できるメルドID（自メルド公開済み & canAttach）。ドラッグ中の 3D 光枠に使う。
  // 複数選択ドラッグ（card=null＝メルド公開の導線）では付け札対象は存在しないため空配列を返す
  // （以前は全メルドを光らせて誤表示していた・項目15a）。
  private attachableMeldIds(view: PlayerView, card: Card | null): number[] {
    if (!card) return [];
    const me = this.driver!.currentPlayerId();
    if (!view.melds.some((m) => m.owner === me)) return [];
    return view.melds.filter((m) => canAttach(m, card)).map((m) => m.id);
  }

  private moveDrag(id: string, x: number, y: number): void {
    const handTop = this.handEl!.getBoundingClientRect().top;
    const inBand = y >= handTop - 6;
    // 「並び替え中」= ポインタ直下が扇のカード（自分=ゴースト以外）である時のみ。手札帯へ食い込んだ
    // メルド（項目1a の配置でも起こり得る）へポインタが載っている場合は付け札標的として扱う（項目1b）。
    const overHandCard = inBand && this.pointerOverHandCard(x, y, id);
    if (this.canPlayNow() && !overHandCard) {
      // プレイ標的（付け札/公開/捨て）をホバー強調。2D メルドチップ（パネル展開時）があれば優先。
      const v = this.lastView!;
      const card = v.hand.find((c) => cardId(c) === id) ?? null;
      const dom = card ? this.domMeldAt(card, x, y) : null;
      if (dom) {
        this.highlightMeldChip(dom.id);
        this.scene?.setDropHover({ kind: 'meld', meldId: dom.id });
      } else {
        const t = this.scene?.dropTargetAt(x, y) ?? null;
        // 手札帯へ食い込む位置では付け札(meld)標的のみ受け付け、捨て/場の誤ホバーを防ぐ。
        this.clearMeldHighlight();
        this.scene?.setDropHover(inBand && t?.kind !== 'meld' ? null : t);
      }
    } else {
      this.clearMeldHighlight();
      this.scene?.setDropHover(null);
      this.reorderDuringDrag(id, x); // 手札帯内・扇の上 = 並び替え
    }
    this.layoutFan({ id, x, y });
  }

  // ポインタ直下（ドラッグ中のゴースト自身を除く）に手札扇のカードがあるか。
  // resolveDrop / moveDrag のガードで「並び替え」と「卓上標的への付け札」を区別する（項目1b）。
  // 手札帯へ食い込んだ 3D メルドへ落とした場合、ポインタ下は扇カードでない → 付け札として受理できる。
  private pointerOverHandCard(x: number, y: number, dragId: string): boolean {
    const stack = document.elementsFromPoint(x, y);
    for (const node of stack) {
      const cardEl = (node as HTMLElement).closest?.('.card') as HTMLElement | null;
      if (!cardEl) continue;
      if (cardEl.dataset.cardId === dragId) continue; // ドラッグ中ゴースト自身は無視
      return true; // 別の手札カード上 = 並び替え意図
    }
    return false;
  }

  private highlightMeldChip(meldId: number): void {
    this.clearMeldHighlight();
    for (const node of Array.from(this.overlay.querySelectorAll('.meld'))) {
      if ((node as HTMLElement).dataset.meldId === String(meldId)) node.classList.add('drop-over');
    }
  }

  private clearMeldHighlight(): void {
    this.overlay.querySelectorAll('.meld.drop-over').forEach((n) => n.classList.remove('drop-over'));
  }

  // 2D メルドチップ（右上パネル展開時のみ DOM 存在）への付け札当たり判定。
  // 項目8修正: 以前は個々のチップ矩形（30×42px と小さい）への厳密な内包判定だったため、
  // 大きなドラッグゴーストで狙ってもポインタ実座標が小チップを外れて不発になっていた
  // （ヒットテスト過敏／ドラッグ札の z が上に被る）。展開中パネル領域（+マージン）内への
  // ドロップを付け札とみなし、その中で「付け札できるメルドのうちポインタに最も近いもの」へ
  // 寄せることで、小さなチップを精密に狙わなくても確実に成立させる。折畳み時は 3D へ委譲（E9）。
  private domMeldAt(card: Card, x: number, y: number): Meld | null {
    const v = this.lastView;
    if (!v || !this.canPlayNow()) return null;
    const me = this.driver!.currentPlayerId();
    if (!v.melds.some((m) => m.owner === me)) return null;
    const panel = this.overlay.querySelector('.meldpanel.open') as HTMLElement | null;
    if (!panel) return null; // 折り畳み中は 2D 経路なし → 3D 卓へ委譲
    const pr = panel.getBoundingClientRect();
    if (pr.width === 0) return null;
    const M = 14; // 取りこぼし対策の許容マージン
    if (x < pr.left - M || x > pr.right + M || y < pr.top - M || y > pr.bottom + M) return null;
    // ポインタ直下のメルドを優先し、直下に無ければ付け札可能メルドのうち最近傍へ吸着する（項目15c）。
    // 直下優先により、複数メルドが近接していても意図したメルドを外さない。
    let under: Meld | null = null;
    let best: Meld | null = null;
    let bestD = Infinity;
    for (const node of Array.from(this.overlay.querySelectorAll('.meld'))) {
      const mid = (node as HTMLElement).dataset.meldId;
      if (!mid) continue;
      const r = (node as HTMLElement).getBoundingClientRect();
      if (r.width === 0) continue;
      const meld = v.melds.find((m) => String(m.id) === mid);
      if (!meld || !canAttach(meld, card)) continue; // 付けられないメルドは対象外
      const inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      if (inside) under = meld; // 直下ヒット（重なりは後勝ち＝手前に描かれたチップ）
      const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
      if (d < bestD) {
        bestD = d;
        best = meld;
      }
    }
    return under ?? best;
  }

  // ドロップ確定: 2Dメルドチップ > 3D標的（メルド > 捨て札 > 場）。卓外/手札帯は false（並び替え扱い・E6）。
  private resolveDrop(id: string, x: number, y: number): boolean {
    const v = this.lastView;
    if (!v || !this.canPlayNow()) return false;
    const card = v.hand.find((c) => cardId(c) === id);
    if (!card) return false;
    const me = this.driver!.currentPlayerId();
    const handTop = this.handEl!.getBoundingClientRect().top;
    const inBand = y >= handTop - 6;
    // 手札帯内でも、ポインタ直下が扇のカードでなければ並び替えではない（項目1b）。自席メルドが手札帯へ
    // 食い込む配置（項目1a）でも、メルド上へ落とせば付け札を成立させる。扇カード上のみ並び替え扱い。
    const overHand = inBand && this.pointerOverHandCard(x, y, id);
    if (overHand) return false; // 手札帯・扇の上 = 並び替え
    // 1) 2D メルドチップ（パネル展開時の付け札導線）
    const dom = this.domMeldAt(card, x, y);
    if (dom) {
      void this.dispatch({ type: 'attach', player: me, meldId: dom.id, card }, () => this.selected.clear());
      return true;
    }
    // 2) 3D 卓上の標的
    const target = this.scene?.dropTargetAt(x, y) ?? null;
    if (!target) return false; // 卓外へのドロップ = 取り消し
    if (target.kind === 'meld') {
      // 付け札可否はエンジンが検証（不可なら拒否 Result → toast）。UI は独自ルール判定を持たない（E7）。
      void this.dispatch({ type: 'attach', player: me, meldId: target.meldId, card }, () => this.selected.clear());
      return true;
    }
    // 手札帯へ食い込んだ位置での捨て/場の誤爆を防ぐ（卓中央=捨て/場は帯より上に投影される）。
    // メルド以外の標的は帯内では受け付けず並び替え/取消に倒す（項目1b・E2 既存挙動の保全）。
    if (inBand) return false;
    if (target.kind === 'discard') {
      void this.dispatch({ type: 'discard', player: me, card }, () => this.selected.clear());
      return true;
    }
    // 場 = メルド公開（選択集合があればそれを、無ければ単札。エンジンが妥当性検証）
    const sel = this.selectedCards(v);
    const cards = this.selected.has(id) && sel.length >= 1 ? sel : [card];
    void this.publishMeld(cards);
    return true;
  }

  // ツモ検出（同一プレイヤー・同一ラウンドで山札-1 & 手札+1 の1枚）→ ツモ演出を起動（項目4）。
  private detectDraw(view: PlayerView): void {
    const turnKey = `${view.round}:${view.youIndex}`;
    const ids = view.hand.map((c) => cardId(c));
    if (turnKey === this.prevTurnKey && this.prevDeckCount >= 0 && view.deckCount === this.prevDeckCount - 1) {
      const prev = new Set(this.prevHandIds);
      const added = ids.filter((i) => !prev.has(i));
      if (added.length === 1) this.playDrawAnim(added[0]!);
    }
    this.prevTurnKey = turnKey;
    this.prevDeckCount = view.deckCount;
    this.prevHandIds = ids;
  }

  // 引いた1枚を中央に大きく（~0.6s）→扇の挿入位置へスライド→数秒グロー（項目4）。
  private playDrawAnim(id: string): void {
    this.clearDrawTimers();
    this.drawnId = id;
    this.drawnBig = true;
    this.audio?.draw();
    this.drawTimers.push(
      window.setTimeout(() => {
        this.drawnBig = false;
        this.layoutFan();
      }, 620),
    );
    this.drawTimers.push(
      window.setTimeout(() => {
        if (this.drawnId === id) {
          this.drawnId = null;
          this.cardEls.get(id)?.classList.remove('drawn');
          this.layoutFan();
        }
      }, 620 + 2600),
    );
  }

  // 扇形手札の配置。フォーカス中は手前へ拡大、ドラッグ中はポインタ追従、ツモ中は中央大表示。
  private layoutFan(drag?: { id: string; x: number; y: number }): void {
    const hand = this.handEl;
    if (!hand) return;
    const cards = this.handCards;
    const n = cards.length;
    if (n === 0) return;
    const W = hand.clientWidth || hand.getBoundingClientRect().width;
    const H = hand.clientHeight || hand.getBoundingClientRect().height;
    const cardW = cards[0]!.el.offsetWidth || 58;
    const cardH = cards[0]!.el.offsetHeight || 82;
    const half = (n - 1) / 2;
    const idealStep = cardW * 0.72;
    const maxSpread = Math.max(cardW, W - cardW - 12);
    const step = n > 1 ? Math.min(idealStep, maxSpread / (n - 1)) : 0;
    const anglePer = Math.min(4, 24 / Math.max(1, n));
    const curve = 1.1;
    const maxDrop = half * half * curve;
    const baseTop = Math.max(2, H - cardH - maxDrop - 2);
    const rect = drag ? hand.getBoundingClientRect() : null;
    const fi = this.focusedId ? cards.findIndex((k) => k.id === this.focusedId) : -1;
    cards.forEach(({ id, el: c }, i) => {
      const off = i - half;
      const x = W / 2 - cardW / 2 + off * step;
      const y = baseTop + off * off * curve;
      if (this.drawnBig && id === this.drawnId && !(drag && id === drag.id)) {
        // ツモ演出: 手札帯の上（卓側）へ大きく表示
        c.style.transform = `translate(${W / 2 - cardW / 2}px, ${-cardH * 0.7}px) scale(1.85) rotate(0deg)`;
        c.style.zIndex = '70';
        return;
      }
      if (drag && id === drag.id && rect) {
        const dx = drag.x - rect.left - cardW / 2;
        const dy = drag.y - rect.top - cardH / 2;
        c.style.transform = `translate(${dx}px, ${dy}px) scale(1.14) rotate(0deg)`;
        c.style.zIndex = '60';
        return;
      }
      if (id === this.focusedId) {
        c.style.transform = `translate(${x}px, ${y - cardH * 0.55}px) scale(1.5) rotate(0deg)`;
        c.style.zIndex = '50';
        return;
      }
      const push = fi >= 0 && i !== fi ? (i < fi ? -1 : 1) * 14 : 0;
      const lift = this.selected.has(id) ? -16 : 0;
      c.style.transform = `translate(${x + push}px, ${y + lift}px) rotate(${off * anglePer}deg)`;
      c.style.zIndex = String(10 + i);
    });
  }

  private buildClaimPanel(view: PlayerView): HTMLElement {
    const claimants = this.driver!.claimants();
    const disc = view.claimWindow?.card;
    const top: ClaimOption | undefined = claimants[0];
    const panel = el('div', { class: 'claim' });
    if (!top || !disc) {
      panel.append(el('div', { class: 'who', text: '鳴き受付中…' }));
      if (disc) {
        panel.append(el('div', { class: 'disc' }, ['捨て札: ', this.chip(disc)] as unknown as (Node | string)[]));
      }
      const bar = el('div', { class: 'timer' }, [el('i', {})]);
      this.timerBar = bar.firstElementChild as HTMLElement;
      panel.append(bar);
      return panel;
    }
    panel.append(el('div', { class: 'who', text: `${top.name} さん、鳴きますか？` }));
    panel.append(
      el('div', { class: 'disc' }, [
        '捨て札: ',
        this.chip(disc),
      ] as unknown as (Node | string)[]),
    );
    const btns = el('div', { class: 'btns' });
    if (top.kinds.includes('pon')) {
      const b = el('button', { class: 'primary', text: 'ポン' });
      b.onclick = () => void this.tryClaim('pon', top, disc);
      btns.append(b);
    }
    if (top.kinds.includes('chi')) {
      const b = el('button', { class: 'primary', text: 'チー' });
      b.onclick = () => void this.tryClaim('chi', top, disc);
      btns.append(b);
    }
    const pass = el('button', { text: 'パス' });
    pass.onclick = () => void this.dispatch({ type: 'pass', player: top.playerId });
    btns.append(pass);
    panel.append(btns);

    const bar = el('div', { class: 'timer' }, [el('i', {})]);
    this.timerBar = bar.firstElementChild as HTMLElement;
    panel.append(bar);
    return panel;
  }

  private buildRoundOver(view: PlayerView): HTMLElement {
    const winnerName = view.lastWinner
      ? view.seats.find((s) => s.id === view.lastWinner)?.name
      : null;
    const modal = el('div', { class: 'modal' }, [
      el('h1', { text: `ラウンド ${view.round} 終了` }),
      el('h2', { text: winnerName ? `${winnerName} さんが上がり！` : '流局（山札切れ・全員失点）' }),
      buildScoreTable(view),
    ]);
    // 次ラウンド開始は権威者（ホットシート/ホスト）のみ。ゲストは待機表示。
    if (this.driver!.isAuthority?.() ?? true) {
      const next = el('button', {
        class: 'primary',
        text: view.round >= view.totalRounds ? '最終結果へ' : '次のラウンドへ',
      });
      next.onclick = () => void this.driver!.dispatch({ type: 'startRound' });
      modal.append(el('div', { class: 'row' }, [next]));
    } else {
      modal.append(el('p', { class: 'hint', text: 'ホストが次のラウンドを開始するまでお待ちください…' }));
    }
    return el('div', { class: 'center' }, [modal]);
  }

  private buildResult(view: PlayerView): HTMLElement {
    const seats = view.seats.slice().sort((a, b) => a.index - b.index);
    const totals = seats.map((s) => view.scores.reduce((sum, row) => sum + (row[s.index] ?? 0), 0));
    const order = seats
      .map((s, i) => ({ name: s.name, id: s.id, total: totals[i]! }))
      .sort((a, b) => a.total - b.total);

    const modal = el('div', { class: 'modal result' }, [
      el('h1', { text: '最終結果' }),
      el('h2', { text: '合計失点が少ない順' }),
    ]);
    let pos = 0;
    let prev = Number.NaN;
    order.forEach((p, i) => {
      if (p.total !== prev) {
        pos = i + 1;
        prev = p.total;
      }
      const win = view.finalWinners.includes(p.id);
      const num = el('span', { text: '0' });
      const pill = el('span', { class: 'pill' }, [num, ' 点'] as unknown as (Node | string)[]);
      countUp(num, p.total, 700 + i * 120); // 順位ごとに少し遅らせてカウントアップ（スコア票の高揚感）
      modal.append(
        el('div', { class: 'rank' + (win ? ' win' : '') }, [
          el('span', { class: 'pos', text: `${pos}位` }),
          el('span', { class: 'nm', text: p.name + (win ? ' 👑' : '') }),
          pill,
        ]),
      );
    });
    modal.append(el('div', { style: 'margin-top:14px' }, [buildScoreTable(view, view.finalWinners)]));
    const again = el('button', { class: 'primary', text: 'ロビーに戻る' });
    again.onclick = () => this.showLobby();
    modal.append(el('div', { class: 'row' }, [again]));
    return el('div', { class: 'center' }, [modal]);
  }

  private openScoreModal(view: PlayerView): void {
    // トグル動作: 既に開いていれば閉じるだけ（連打での多重スタックを防ぐ・2026-08-11）
    const existing = this.root.querySelector('.center .modal .score-wrap')?.closest('.center');
    if (existing) {
      existing.remove();
      return;
    }
    const modal = el('div', { class: 'modal' }, [
      el('h1', { text: 'スコア票' }),
      el('h2', { text: `ラウンド ${view.round}/${view.totalRounds} 時点` }),
      buildScoreTable(view),
    ]);
    const close = el('button', { text: '閉じる' });
    const overlay = el('div', { class: 'center' }, [modal]);
    close.onclick = () => overlay.remove();
    modal.append(el('div', { class: 'row' }, [close]));
    overlay.onclick = (e) => {
      if (e.target === overlay) overlay.remove();
    };
    this.root.append(overlay);
  }

  // ---- アクション --------------------------------------------------------

  private async publishMeld(sel: Card[]): Promise<void> {
    if (sel.length === 0) return;
    let kind: 'lone7' | 'group' | 'sequence';
    if (sel.length === 1 && sel[0]!.rank === 7) kind = 'lone7';
    else if (sel.every((c) => c.rank === sel[0]!.rank)) kind = 'group';
    else kind = 'sequence';
    await this.dispatch(
      { type: 'publishMeld', player: this.driver!.currentPlayerId(), cards: sel, meldKind: kind },
      () => this.selected.clear(),
    );
  }

  private async tryClaim(kind: 'pon' | 'chi', claimant: ClaimOption, disc: Card): Promise<void> {
    // 鳴きに使う手札の組を列挙し、エンジンが受理する組で確定する（UI はルール判定を持たない）。
    const hand = this.driver!.getView(claimant.playerId).hand;
    const cands = hand.filter((c) => (kind === 'pon' ? c.rank === disc.rank : c.suit === disc.suit));
    for (let i = 0; i < cands.length; i++) {
      for (let j = i + 1; j < cands.length; j++) {
        const r = await this.driver!.dispatch({
          type: kind,
          player: claimant.playerId,
          cards: [cands[i]!, cands[j]!],
        });
        if (r.ok) return;
      }
    }
    this.toast('鳴きに使える手札の組がありません');
  }

  private async dispatch(action: Action, onOk?: () => void): Promise<void> {
    this.audio?.click(); // ボタン/操作の即時フィードバック音
    const r = await this.driver!.dispatch(action);
    if (r.ok) onOk?.();
    else this.toast(this.friendlyError(action, r.error));
  }

  private friendlyError(action: Action, raw: string): string {
    switch (action.type) {
      case 'publishMeld':
        return '有効なメルドではありません（列/組/単独7）。';
      case 'attach':
        return 'このメルドには付け札できません。';
      case 'discard':
        return '捨てられません。';
      default:
        return `操作できません（${raw}）`;
    }
  }

  // ---- 鳴きカウントダウン -----------------------------------------------

  private syncClaimTimer(view: PlayerView): void {
    if (view.phase !== 'meldWindow' || !view.claimWindow) {
      this.stopClaimTimer();
      return;
    }
    // ネット実装はホスト配信の残り時間から満了時刻を得る。ホットシートは自前で 5 秒を計測。
    const provided = this.driver!.claimDeadline?.();
    if (provided != null) {
      this.claimDeadline = provided;
    } else {
      const key = `${view.round}:${view.discardPile.length}:${cardId(view.claimWindow.card)}`;
      if (key !== this.claimKey) {
        this.claimKey = key;
        this.claimDeadline = performance.now() + CLAIM_WINDOW_MS;
      }
    }
    if (!this.claimTimer) {
      this.claimTimer = window.setInterval(() => this.tickClaim(), 100);
    }
    this.tickClaim();
  }

  private tickClaim(): void {
    const remain = Math.max(0, this.claimDeadline - performance.now());
    if (this.timerBar) {
      this.timerBar.style.width = `${(remain / CLAIM_WINDOW_MS) * 100}%`;
      // 残り時間わずかで緊張演出（パネルのパルス + タイマー赤化）
      const panel = this.timerBar.closest('.claim');
      panel?.classList.toggle('urgent', remain < 1600);
    }
    // ウィンドウ満了の確定は権威者のみ（ゲストはホストの closeWindow 配信を待つ）。
    if (remain <= 0 && !this.closing && (this.driver!.isAuthority?.() ?? true)) {
      this.closing = true;
      void this.driver!.dispatch({ type: 'closeWindow' }).finally(() => {
        this.closing = false;
      });
    }
  }

  private stopClaimTimer(): void {
    if (this.claimTimer) {
      clearInterval(this.claimTimer);
      this.claimTimer = 0;
    }
    this.claimKey = null;
    this.timerBar = null;
  }

  // ---- トースト ----------------------------------------------------------

  private toast(msg: string): void {
    if (!this.toastEl) return;
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl?.classList.remove('show'), 2200);
  }
}
