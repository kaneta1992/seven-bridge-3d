// ゲーム全体のオーケストレータ。ドライバ境界（GameDriver）越しに 3D シーンと HUD を駆動する。
// ホットシート（LocalDriver）と通信対戦（HostDriver/GuestDriver）を同じゲーム描画で扱い、
// 差分は driver の任意メソッド（isAuthority / claimDeadline）で吸収する。
// エンジンには直接触れず、状態は driver.getView / claimants から受け取る（付け札の可否判定にのみ
// 純粋関数 canAttach を利用＝ UI アフォーダンス用途で、アクションは必ず driver 経由）。
import type { Action, Card, PlayerView } from '../core';
import { canAttach, cardId } from '../core';
import { LocalDriver } from '../driver/localDriver';
import type { ClaimOption, GameDriver } from '../driver/types';
import {
  generateRoomCode,
  loadOrCreatePlayerKey,
  type RosterMember,
} from '../net/protocol';
import { NetSession } from '../net/session';
import { createTrysteroTransport } from '../net/trysteroTransport';
import { TableScene } from '../render/scene';
import { clear, el } from './dom';
import { renderLobby, type CreateRoomConfig, type LobbyResult } from './lobby';
import { renderConnecting, renderNotice, renderWaitingRoom } from './room';
import { buildScoreTable } from './scoreTable';

const SUIT_GLYPH: Record<string, string> = { C: '♣', D: '♦', H: '♥', S: '♠' };
const RANK_LABEL: Record<number, string> = {
  1: 'A', 11: 'J', 12: 'Q', 13: 'K',
};
const isRed = (c: Card): boolean => c.suit === 'D' || c.suit === 'H';
const rankText = (c: Card): string => RANK_LABEL[c.rank] ?? String(c.rank);
const CLAIM_WINDOW_MS = 5000;

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

  private selected = new Set<string>();
  // 手札のローカル表示順（cardId の並び）。ユーザーが D&D で決めた相対順序を保持する。
  // エンジンの手札集合には影響せず（src/core 非改変）、3D と DOM の両方へ同一順序を反映する。
  private handOrder: string[] = [];
  // 手札ドラッグ中は driver 由来の再描画（他家アクションのスナップショット等）で .hand DOM が
  // 作り直されないよう render を保留し、pointerup/cancel 後の render() でまとめて反映する。
  private dragging = false;
  private lastRound = 0;
  private lastPhaseKey = '';
  private claimKey: string | null = null;
  private claimDeadline = 0;
  private claimTimer = 0;
  private timerBar: HTMLElement | null = null;
  private closing = false;
  private toastEl: HTMLElement | null = null;
  private toastTimer = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    this.showLobby();
    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', this.onResize);
  }

  private onResize = (): void => {
    this.scene?.resize();
    if (this.driver) this.renderScene(this.orderedView());
  };

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
    });
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
    this.stopClaimTimer();
    this.selected.clear();
    this.handOrder = [];
    this.dragging = false;
    this.lastRound = 0;
    this.lastPhaseKey = '';
  }

  private teardownNet(): void {
    this.session?.dispose();
    this.session = null;
    this.waitInfo = null;
  }

  // ---- ホットシート ------------------------------------------------------

  private startHotseat(cfg: LobbyResult): void {
    const driver = new LocalDriver({ players: cfg.players, totalRounds: cfg.totalRounds });
    this.beginWithDriver(driver);
  }

  // ---- 通信対戦: ルーム作成（ホスト） -----------------------------------

  private createRoom(cfg: CreateRoomConfig): void {
    this.teardownGame();
    this.teardownNet();
    const code = generateRoomCode();
    const pk = loadOrCreatePlayerKey(code);
    const transport = createTrysteroTransport(code);
    const session = NetSession.host(code, pk, cfg.name, transport, {
      maxPlayers: cfg.maxPlayers,
      totalRounds: cfg.totalRounds,
    });
    this.session = session;
    this.wireSession(session);
    this.waitInfo = {
      code,
      members: [{ pk, name: cfg.name }],
      amHost: true,
      maxPlayers: cfg.maxPlayers,
      totalRounds: cfg.totalRounds,
    };
    this.renderWaiting();
  }

  // ---- 通信対戦: ルーム参加（ゲスト） -----------------------------------

  private joinRoom(code: string, name: string): void {
    this.teardownGame();
    this.teardownNet();
    const pk = loadOrCreatePlayerKey(code);
    const transport = createTrysteroTransport(code);
    const session = NetSession.guest(code, pk, name, transport);
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
    session.on('started', (driver) => this.beginWithDriver(driver));
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
      onStart: () => this.session?.startGame(),
      onLeave: () => this.showLobby(),
    });
  }

  // ---- ゲーム開始（共通） ------------------------------------------------

  private beginWithDriver(driver: GameDriver): void {
    this.teardownGame();
    clear(this.root);
    this.sceneHost = el('div', { id: 'scene' });
    this.overlay = el('div', { class: 'overlay' });
    this.toastEl = el('div', { class: 'toast' });
    this.root.append(this.sceneHost, this.overlay, this.toastEl);

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
    this.scene.update(view, { selectedIds: this.selected });
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
    }
    // フェーズ/手番が変わったら選択解除
    const phaseKey = `${view.phase}:${view.youIndex}:${view.round}`;
    if (phaseKey !== this.lastPhaseKey) {
      this.selected.clear();
      this.lastPhaseKey = phaseKey;
    }

    const oview: PlayerView = { ...view, hand: this.applyHandOrder(view.hand) };
    this.renderScene(oview);
    this.renderHud(oview);
    this.syncClaimTimer(oview);
  }

  private renderHud(view: PlayerView): void {
    clear(this.overlay);
    if (view.phase === 'gameOver') {
      this.overlay.append(this.buildResult(view));
      return;
    }
    this.overlay.append(this.buildTopbar(view));
    this.overlay.append(this.buildMelds(view));
    if (view.phase === 'meldWindow') {
      this.overlay.append(this.buildClaimPanel(view));
    }
    if (view.phase === 'roundOver') {
      this.overlay.append(this.buildRoundOver(view));
    } else {
      this.overlay.append(this.buildBottom(view));
    }
  }

  private buildTopbar(view: PlayerView): HTMLElement {
    const current = view.seats.find((s) => s.isCurrent);
    const turnText =
      view.phase === 'meldWindow'
        ? '鳴き受付中…'
        : view.phase === 'awaitingStart'
          ? '配札待ち…'
          : `${current?.name ?? '-'} さんの手番`;
    const scoreBtn = el('button', { text: 'スコア票' });
    scoreBtn.onclick = () => this.openScoreModal(view);
    return el('div', { class: 'topbar' }, [
      el('span', { class: 'turn', text: turnText }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'pill', text: `ラウンド ${view.round}/${view.totalRounds}` }),
      el('span', { class: 'pill', text: `山札 ${view.deckCount}` }),
      scoreBtn,
    ]);
  }

  private buildMelds(view: PlayerView): HTMLElement {
    const wrap = el('div', { class: 'melds' });
    const nameOf = (id: string): string => view.seats.find((s) => s.id === id)?.name ?? '?';
    const sel = this.selectedCards(view);
    const attachCard = sel.length === 1 ? sel[0]! : null;
    // 付け札は自分がメルドを1つ以上公開済みでなければ不可（要件§2.3）。かつ自分の手番中のみ。
    // 未公開プレイヤー・他家手番には付け札UI（ハイライト・タップ受付）を出さない。
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
      for (const c of meld.cards) node.append(this.chip(c));
      if (attachable) {
        node.onclick = () =>
          void this.dispatch({ type: 'attach', player: meId, meldId: meld.id, card: attachCard! }, () =>
            this.selected.clear(),
          );
      }
      wrap.append(node);
    }
    if (view.melds.length === 0) {
      wrap.append(el('span', { class: 'hint', text: '場にメルドはまだありません' }));
    }
    return wrap;
  }

  private chip(c: Card): HTMLElement {
    return el('span', { class: 'chip' + (isRed(c) ? ' red' : ''), text: `${rankText(c)}${SUIT_GLYPH[c.suit]}` });
  }

  private selectedCards(view: PlayerView): Card[] {
    return view.hand.filter((c) => this.selected.has(cardId(c)));
  }

  private buildBottom(view: PlayerView): HTMLElement {
    const myTurn = this.isMyTurn(view);
    const hand = el('div', { class: 'hand' });
    const canSelect = view.phase === 'awaitingDiscard' && myTurn;
    // 並び替えは自分の手札が存在する間は常時可能（他家手番・鳴きウィンドウ中も含む）。
    // 手札を整理する自然な操作を待ち時間中でも許可する。タップ選択は捨てフェーズのみ。
    const canReorder = view.hand.length > 0;
    // 自分が操作できる手番（ツモ/捨て）以外は手札を淡く見せて手番でないことを示す（並び替えは可）。
    const activeTurn = myTurn && (view.phase === 'awaitingDraw' || view.phase === 'awaitingDiscard');
    // view.hand は既に applyHandOrder 済みの表示順で渡ってくる（3D と一致）。
    for (const c of view.hand) {
      const id = cardId(c);
      const card = el('div', {
        class:
          'card' +
          (isRed(c) ? ' red' : '') +
          (this.selected.has(id) ? ' sel' : '') +
          (canReorder ? ' draggable' : ''),
      });
      card.dataset.cardId = id;
      card.append(el('div', { class: 'big', text: rankText(c) }));
      card.append(el('div', { text: SUIT_GLYPH[c.suit] }));
      if (!activeTurn) card.style.opacity = '0.85';
      if (canReorder) this.attachHandPointer(card, id, hand, canSelect);
      hand.append(card);
    }

    const actions = el('div', { class: 'actions' });
    const hint = el('div', { class: 'hint' });
    const me = this.driver!.currentPlayerId();
    const sel = this.selectedCards(view);

    if (!myTurn && (view.phase === 'awaitingDraw' || view.phase === 'awaitingDiscard')) {
      const current = view.seats.find((s) => s.isCurrent);
      hint.textContent = `${current?.name ?? '他のプレイヤー'} さんの手番です…`;
    } else if (myTurn && view.phase === 'awaitingDraw') {
      hint.textContent = '山札から1枚ツモってください。';
      const draw = el('button', { class: 'primary', text: '山札からツモる' });
      draw.onclick = () => void this.dispatch({ type: 'draw', player: me });
      actions.append(draw);
    } else if (myTurn && view.phase === 'awaitingDiscard') {
      hint.textContent =
        sel.length === 0
          ? 'カードを選択 → メルド公開 / 付け札（場のメルドをタップ）/ 1枚捨てて手番終了。'
          : sel.length === 1
            ? '「捨てる」で手番終了、または場のメルドをタップして付け札。'
            : '「メルド公開」で選択カードを役として公開。';
      // 公開可能な形は「単独7の1枚」または「3枚以上」のみ（2枚選択などは無効）。
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

    return el('div', { class: 'bottom' }, [hand, hint, actions]);
  }

  // 手札カードの Pointer Events。マウス/タッチ共通で「移動閾値未満＝タップ（選択トグル）/
  // 閾値以上＝ドラッグ（並び替え）」を判別する。並び替えは兄弟カードの中点を境に DOM を
  // ライブ挿入し、確定時に DOM 順を handOrder へ取り込んで render() で 3D と DOM を再同期する。
  // canReorder が真のフェーズ（自手番）でのみ張られ、そこでは driver 由来の自発 re-render が
  // 起きないため、ドラッグ中に DOM が作り直されて競合することはない（E12/E13）。
  private attachHandPointer(
    card: HTMLElement,
    id: string,
    hand: HTMLElement,
    canSelect: boolean,
  ): void {
    const THRESHOLD = 8; // タップ/ドラッグ判別のピクセル移動閾値
    let pointerId = -1;
    let startX = 0;
    let startY = 0;
    let dragging = false;

    card.addEventListener('pointerdown', (e) => {
      if (pointerId !== -1) return; // 多重ポインタは無視
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      dragging = false;
      card.setPointerCapture(pointerId);
    });

    card.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pointerId) return;
      if (!dragging && Math.hypot(e.clientX - startX, e.clientY - startY) < THRESHOLD) return;
      if (!dragging) {
        dragging = true;
        card.classList.add('dragging');
        // ドラッグ中は driver 由来の再描画を保留させる（DOM 作り直し防止）。
        this.dragging = true;
      }
      e.preventDefault();
      this.reorderDuringDrag(hand, card, e.clientX);
    });

    const finish = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return;
      if (card.hasPointerCapture(pointerId)) card.releasePointerCapture(pointerId);
      pointerId = -1;
      if (!dragging) {
        // タップ＝選択トグル（捨てフェーズのみ意味を持つ）
        if (canSelect) {
          if (this.selected.has(id)) this.selected.delete(id);
          else this.selected.add(id);
          this.render();
        }
        return;
      }
      // ドラッグ確定：現在の DOM 並びを表示順として取り込み、3D/DOM を再構築で一致させる。
      card.classList.remove('dragging');
      this.dragging = false;
      this.handOrder = Array.from(hand.children)
        .map((n) => (n as HTMLElement).dataset.cardId)
        .filter((v): v is string => !!v);
      // ドラッグ中に保留された driver スナップショットも、この render() でまとめて反映される。
      this.render();
    };
    card.addEventListener('pointerup', finish);
    card.addEventListener('pointercancel', finish);
  }

  // ドラッグ中のカードを、兄弟カードの水平中点を基準に挿入位置へ移動する（横1列レイアウト前提）。
  private reorderDuringDrag(hand: HTMLElement, dragEl: HTMLElement, clientX: number): void {
    let ref: HTMLElement | null = null;
    for (const child of Array.from(hand.children) as HTMLElement[]) {
      if (child === dragEl) continue;
      const rect = child.getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) {
        ref = child;
        break;
      }
    }
    if (ref) {
      if (dragEl.nextSibling !== ref) hand.insertBefore(dragEl, ref);
    } else if (hand.lastElementChild !== dragEl) {
      hand.append(dragEl);
    }
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
      modal.append(
        el('div', { class: 'rank' + (win ? ' win' : '') }, [
          el('span', { class: 'pos', text: `${pos}位` }),
          el('span', { class: 'nm', text: p.name + (win ? ' 👑' : '') }),
          el('span', { class: 'pill', text: `${p.total} 点` }),
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
    if (this.timerBar) this.timerBar.style.width = `${(remain / CLAIM_WINDOW_MS) * 100}%`;
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
