// タイトル画面の背景で回り続けるデモ対局（U4）。UI 層のボットが LocalDriver の公開APIのみを使って
// ランダムな合法手を打ち、TableScene がシネマティックカメラで眺めのよい画を作る。
// エンジン（src/core）・driver・net は非改変。合法性判定には core の純粋関数（canPublish/canAttach）のみ利用。
// 音は鳴らさない（背景演出のため・AudioKit は接続しない）。dispose で完全停止（タイマー/シーン/購読）。
import type { Card, PlayerView } from '../core';
import { canAttach, canPublish } from '../core';
import { LocalDriver } from '../driver/localDriver';
import { TableScene } from '../render/scene';

const DEMO_NAMES = ['あかり', 'はると', 'つむぎ', 'ゆうと'];

export class DemoTable {
  private scene: TableScene;
  private driver: LocalDriver;
  private unsub: () => void;
  private timer = 0;
  private disposed = false;
  private lastRound = 0;
  private celebrated = -1;
  private meldIds = new Set<number>();

  constructor(host: HTMLElement) {
    this.scene = new TableScene(host);
    this.scene.setCinematic(true); // ゆっくりした演出的カメラワーク（緩い旋回・時折の寄り引き）
    this.driver = this.newGame();
    this.unsub = this.driver.subscribe(() => this.render());
    void this.driver.dispatch({ type: 'startRound' });
    this.scheduleTick();
  }

  resize(): void {
    this.scene.resize();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = 0;
    }
    this.unsub();
    this.scene.dispose();
  }

  private newGame(): LocalDriver {
    // 4人・最大ラウンド数（エンジン上限20）。gameOver は restart で新規対局を作り直すため実質無限に回る。
    // 以前は 99 を渡していたが、エンジンの totalRounds 1..20 検証で DemoTable コンストラクタが例外を投げ、
    // showLobby の try/catch に握り潰されてデモが起動しない（背景卓が空回り）不具合になっていた（契約19項目4）。
    return new LocalDriver({
      players: DEMO_NAMES.map((n, i) => ({ id: `demo${i}`, name: n })),
      totalRounds: 20,
    });
  }

  // ---- 描画/演出（状態変化のたび・購読から） ----
  private render(): void {
    if (this.disposed) return;
    const view = this.driver.getView(this.driver.currentPlayerId());
    if (view.round !== this.lastRound && view.round > 0) {
      this.scene.clearCards(); // ラウンド遷移の掃引→配札演出（Q1 の掃引も背景で見える）
      this.lastRound = view.round;
      this.meldIds = new Set(view.melds.map((m) => m.id));
    }
    // 全席の実手札を表向きで見せる（契約20項目2）。デモは LocalDriver の公開API getView(席id) で各席の
    // 自視点手札を引くだけ＝実対局の秘匿（他家は枚数のみ）には無関係。表示層だけの全公開。
    const reveal = new Map<number, Card[]>();
    for (const s of view.seats) reveal.set(s.index, this.driver.getView(s.id).hand);
    this.scene.setDemoReveal(reveal);
    this.scene.update(view);
    const seatById = new Map(view.seats.map((s) => [s.id, s.index] as const));
    for (const m of view.melds) {
      if (!this.meldIds.has(m.id)) this.scene.publishEffect(seatById.get(m.owner) ?? 0);
    }
    this.meldIds = new Set(view.melds.map((m) => m.id));
    if (view.phase === 'roundOver' && this.celebrated !== view.round) {
      this.celebrated = view.round;
      if (view.lastWinner) this.scene.celebrate(seatById.get(view.lastWinner) ?? 0);
    }
  }

  // ---- ボットの手番進行（自己スケジュールのループ・購読とは独立で確実に前進） ----
  private scheduleTick(): void {
    if (this.disposed) return;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.tick();
    }, 650 + Math.random() * 800); // ゆったりしたテンポ
  }

  private tick(): void {
    if (this.disposed) return;
    void this.step().finally(() => this.scheduleTick());
  }

  private async step(): Promise<void> {
    const d = this.driver;
    const pid = d.currentPlayerId();
    const view = d.getView(pid);
    switch (view.phase) {
      case 'awaitingStart':
        await d.dispatch({ type: 'startRound' });
        break;
      case 'awaitingDraw':
        await d.dispatch({ type: 'draw', player: pid });
        break;
      case 'awaitingDiscard':
        await this.playTurn(view, pid);
        break;
      case 'meldWindow':
        await this.playClaim(view);
        break;
      case 'roundOver':
        await d.dispatch({ type: 'startRound' });
        break;
      case 'gameOver':
        this.restart();
        break;
    }
  }

  private async playTurn(view: PlayerView, pid: string): Promise<void> {
    const d = this.driver;
    const hand = view.hand;
    // 30%: 自然なメルドがあれば公開（見栄えの決め演出）。
    if (Math.random() < 0.3) {
      const meld = findMeld(hand);
      if (meld) {
        const r = await d.dispatch({ type: 'publishMeld', player: pid, cards: meld.cards, meldKind: meld.kind });
        if (r.ok) return;
      }
    }
    // 40%: 公開済み自メルドがあれば付け札（エンジンが可否を検証・失敗なら捨てへ）。
    if (Math.random() < 0.4) {
      for (const m of view.melds) {
        const card = hand.find((c) => canAttach(m, c));
        if (card) {
          const r = await d.dispatch({ type: 'attach', player: pid, meldId: m.id, card });
          if (r.ok) return;
        }
      }
    }
    // それ以外はランダムに1枚捨てる（必ず前進する）。
    const card = hand[(Math.random() * hand.length) | 0];
    if (card) await d.dispatch({ type: 'discard', player: pid, card });
  }

  private async playClaim(view: PlayerView): Promise<void> {
    const d = this.driver;
    const claimants = d.claimants();
    const disc = view.claimWindow?.card;
    // 40%: 先頭の鳴き可能者が実際に鳴く（ポン/チーの演出）。組が無ければ closeWindow で進める。
    if (disc && claimants.length && Math.random() < 0.4) {
      const c = claimants[0]!;
      const kind: 'pon' | 'chi' = c.kinds.includes('pon') ? 'pon' : 'chi';
      const cands = d
        .getView(c.playerId)
        .hand.filter((x) => (kind === 'pon' ? x.rank === disc.rank : x.suit === disc.suit));
      for (let i = 0; i < cands.length; i++) {
        for (let j = i + 1; j < cands.length; j++) {
          const r = await d.dispatch({ type: kind, player: c.playerId, cards: [cands[i]!, cands[j]!] });
          if (r.ok) return;
        }
      }
    }
    await d.dispatch({ type: 'closeWindow' });
  }

  private restart(): void {
    this.unsub();
    this.driver = this.newGame();
    this.unsub = this.driver.subscribe(() => this.render());
    this.scene.clearCards();
    this.lastRound = 0;
    this.celebrated = -1;
    this.meldIds = new Set();
    void this.driver.dispatch({ type: 'startRound' });
  }
}

/** 手札から公開可能なメルドを1つ探す（組→列→単独7 の順）。core の canPublish で妥当性を確定する。 */
function findMeld(hand: Card[]): { cards: Card[]; kind: 'group' | 'sequence' | 'lone7' } | null {
  const byRank = new Map<number, Card[]>();
  for (const c of hand) {
    const a = byRank.get(c.rank) ?? [];
    a.push(c);
    byRank.set(c.rank, a);
  }
  for (const cs of byRank.values()) {
    if (cs.length >= 3 && canPublish(cs.slice(0, 3), 'group')) return { cards: cs.slice(0, 3), kind: 'group' };
  }
  const bySuit = new Map<string, Card[]>();
  for (const c of hand) {
    const a = bySuit.get(c.suit) ?? [];
    a.push(c);
    bySuit.set(c.suit, a);
  }
  for (const cs of bySuit.values()) {
    if (cs.length < 3) continue;
    const sorted = [...cs].sort((a, b) => a.rank - b.rank);
    for (let i = 0; i + 3 <= sorted.length; i++) {
      const tri = sorted.slice(i, i + 3);
      if (canPublish(tri, 'sequence')) return { cards: tri, kind: 'sequence' };
    }
  }
  const seven = hand.find((c) => c.rank === 7);
  if (seven && canPublish([seven], 'lone7')) return { cards: [seven], kind: 'lone7' };
  return null;
}
