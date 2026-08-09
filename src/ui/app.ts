// ゲーム全体のオーケストレータ。ドライバ境界（GameDriver）越しに 3D シーンと HUD を駆動する。
// エンジンには直接触れず、状態は driver.getView / claimants から受け取る（付け札の可否判定にのみ
// 純粋関数 canAttach を利用＝ UI アフォーダンス用途で、アクションは必ず driver 経由）。
import type { Action, Card, PlayerView } from '../core';
import { canAttach, cardId } from '../core';
import { LocalDriver } from '../driver/localDriver';
import type { ClaimOption, GameDriver } from '../driver/types';
import { TableScene } from '../render/scene';
import { clear, el } from './dom';
import { renderLobby, type LobbyResult } from './lobby';
import { buildScoreTable } from './scoreTable';

const SUIT_GLYPH: Record<string, string> = { C: '♣', D: '♦', H: '♥', S: '♠' };
const RANK_LABEL: Record<number, string> = {
  1: 'A', 11: 'J', 12: 'Q', 13: 'K',
};
const isRed = (c: Card): boolean => c.suit === 'D' || c.suit === 'H';
const rankText = (c: Card): string => RANK_LABEL[c.rank] ?? String(c.rank);
const CLAIM_WINDOW_MS = 5000;

export class GameUI {
  private root: HTMLElement;
  private sceneHost!: HTMLElement;
  private overlay!: HTMLElement;
  private scene: TableScene | null = null;
  private driver: GameDriver | null = null;
  private unsub: (() => void) | null = null;

  private selected = new Set<string>();
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
    if (this.driver) this.renderScene();
  };

  private showLobby(): void {
    this.teardownGame();
    clear(this.root);
    const lobby = el('div', {});
    this.root.append(lobby);
    renderLobby(lobby, (r) => this.startGame(r));
  }

  private teardownGame(): void {
    this.unsub?.();
    this.unsub = null;
    this.scene?.dispose();
    this.scene = null;
    this.driver = null;
    this.stopClaimTimer();
    this.selected.clear();
    this.lastRound = 0;
  }

  private startGame(cfg: LobbyResult): void {
    clear(this.root);
    this.sceneHost = el('div', { id: 'scene' });
    this.overlay = el('div', { class: 'overlay' });
    this.toastEl = el('div', { class: 'toast' });
    this.root.append(this.sceneHost, this.overlay, this.toastEl);

    this.scene = new TableScene(this.sceneHost);
    this.driver = new LocalDriver({ players: cfg.players, totalRounds: cfg.totalRounds });
    this.unsub = this.driver.subscribe(() => this.render());
    // 最初のラウンドを配札（配札演出が走る）
    void this.driver.dispatch({ type: 'startRound' });
    this.render();
  }

  // ---- 描画 --------------------------------------------------------------

  private currentView(): PlayerView {
    const d = this.driver!;
    return d.getView(d.currentPlayerId());
  }

  private renderScene(): void {
    if (!this.scene || !this.driver) return;
    this.scene.update(this.currentView(), { selectedIds: this.selected });
  }

  private render(): void {
    if (!this.driver || !this.scene) return;
    const view = this.currentView();

    // ラウンドが進んだらカードを一掃して配札演出を作る
    if (view.round !== this.lastRound && view.round > 0 && view.phase !== 'gameOver') {
      this.scene.clearCards();
      this.lastRound = view.round;
      this.selected.clear();
    }
    // フェーズ/手番が変わったら選択解除
    const phaseKey = `${view.phase}:${view.youIndex}:${view.round}`;
    if (phaseKey !== this.lastPhaseKey) {
      this.selected.clear();
      this.lastPhaseKey = phaseKey;
    }

    this.renderScene();
    this.renderHud(view);
    this.syncClaimTimer(view);
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

    for (const meld of view.melds) {
      const attachable = attachCard != null && view.phase === 'awaitingDiscard' && canAttach(meld, attachCard);
      const kindLabel = meld.kind === 'lone7' ? '単独7' : meld.kind === 'group' ? '組' : '列';
      const node = el('div', { class: 'meld' + (attachable ? ' attachable' : '') }, [
        el('span', { class: 'owner', text: `${nameOf(meld.owner)}·${kindLabel}` }),
      ]);
      for (const c of meld.cards) node.append(this.chip(c));
      if (attachable) {
        node.onclick = () =>
          void this.dispatch({ type: 'attach', player: this.driver!.currentPlayerId(), meldId: meld.id, card: attachCard! }, () =>
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
    const hand = el('div', { class: 'hand' });
    const canSelect = view.phase === 'awaitingDiscard';
    for (const c of view.hand) {
      const id = cardId(c);
      const card = el('div', {
        class: 'card' + (isRed(c) ? ' red' : '') + (this.selected.has(id) ? ' sel' : ''),
      });
      card.append(el('div', { class: 'big', text: rankText(c) }));
      card.append(el('div', { text: SUIT_GLYPH[c.suit] }));
      if (canSelect) {
        card.onclick = () => {
          if (this.selected.has(id)) this.selected.delete(id);
          else this.selected.add(id);
          this.render();
        };
      } else {
        card.style.opacity = '0.85';
      }
      hand.append(card);
    }

    const actions = el('div', { class: 'actions' });
    const hint = el('div', { class: 'hint' });
    const me = this.driver!.currentPlayerId();
    const sel = this.selectedCards(view);

    if (view.phase === 'awaitingDraw') {
      hint.textContent = '山札から1枚ツモってください。';
      const draw = el('button', { class: 'primary', text: '山札からツモる' });
      draw.onclick = () => void this.dispatch({ type: 'draw', player: me });
      actions.append(draw);
    } else if (view.phase === 'awaitingDiscard') {
      hint.textContent =
        sel.length === 0
          ? 'カードを選択 → メルド公開 / 付け札（場のメルドをタップ）/ 1枚捨てて手番終了。'
          : sel.length === 1
            ? '「捨てる」で手番終了、または場のメルドをタップして付け札。'
            : '「メルド公開」で選択カードを役として公開。';
      const meldBtn = el('button', { text: 'メルド公開' }) as HTMLButtonElement;
      meldBtn.disabled = sel.length === 0;
      meldBtn.onclick = () => void this.publishMeld(sel);
      const discardBtn = el('button', { class: 'gold', text: '捨てる' }) as HTMLButtonElement;
      discardBtn.disabled = sel.length !== 1;
      discardBtn.onclick = () =>
        void this.dispatch({ type: 'discard', player: me, card: sel[0]! }, () => this.selected.clear());
      actions.append(meldBtn, discardBtn);
    }

    return el('div', { class: 'bottom' }, [hand, hint, actions]);
  }

  private buildClaimPanel(view: PlayerView): HTMLElement {
    const claimants = this.driver!.claimants();
    const disc = view.claimWindow?.card;
    const top: ClaimOption | undefined = claimants[0];
    const panel = el('div', { class: 'claim' });
    if (!top || !disc) {
      panel.append(el('div', { class: 'who', text: '鳴き受付中…' }));
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
    const next = el('button', { class: 'primary', text: view.round >= view.totalRounds ? '最終結果へ' : '次のラウンドへ' });
    next.onclick = () => void this.driver!.dispatch({ type: 'startRound' });
    modal.append(el('div', { class: 'row' }, [next]));
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
    const key = `${view.round}:${view.discardPile.length}:${cardId(view.claimWindow.card)}`;
    if (key !== this.claimKey) {
      this.claimKey = key;
      this.claimDeadline = performance.now() + CLAIM_WINDOW_MS;
    }
    if (!this.claimTimer) {
      this.claimTimer = window.setInterval(() => this.tickClaim(), 100);
    }
    this.tickClaim();
  }

  private tickClaim(): void {
    const remain = Math.max(0, this.claimDeadline - performance.now());
    if (this.timerBar) this.timerBar.style.width = `${(remain / CLAIM_WINDOW_MS) * 100}%`;
    if (remain <= 0 && !this.closing) {
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
