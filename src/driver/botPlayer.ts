// NPC（ボット）AI の共通モジュール（契約16）。R16 の demoTable ボットを「実用的な強さ」へ昇格し、
// 1人プレイ（LocalDriver 固定自席）と通信対戦（HostDriver 権威）の両方で共有する。
//
// 視界の公正（不変条件）: 判断関数（decideTurnAction / decideBotClaim）の入力は「そのNPC席の
// deriveViewFor 相当」= PlayerView に限定する。他家の実手札には一切触れない（yourClaims / hand /
// 公開情報のみ）。BotRunner は権威ドライバの getView(npcId)（=そのNPCの視界）だけを渡す。
//
// エンジン（src/core）は非改変。合法性判定には core の純粋関数のみ利用し、着手は必ずドライバ経由
// （applyBot=権威適用）で行う。強さは「公開できるメルドは公開・付け札できるなら付ける・妥当な鳴き・
// 失点の高い孤立カードを捨てる」ヒューリスティック。
import type { Action, ActionResult, Card, MeldKind, PlayerView } from '../core';
import { canAttach, canPublish, cardId, cardPoints } from '../core';
import type { GameDriver } from './types';

// ---- NPC 名プール（日本語・NPC と分かる表記） ----------------------------

/** 親しみやすい日本語のベース名。表示は「NPC・<名>」で NPC と分かる印を付ける。 */
export const NPC_NAME_POOL = ['ロボ太', 'カル子', 'ジャック', 'ポン太', 'チー子', 'ナナ'] as const;

/** 既存名と衝突しない NPC 表示名を選ぶ（プール枯渇時は連番でフォールバック）。 */
export function pickNpcName(taken: ReadonlySet<string>): string {
  for (const base of NPC_NAME_POOL) {
    const name = `NPC・${base}`;
    if (!taken.has(name)) return name;
  }
  for (let i = 2; ; i++) {
    const name = `NPC${i}`;
    if (!taken.has(name)) return name;
  }
}

// ---- 純粋な判断ロジック（テスト対象・視界は PlayerView に限定） ------------

interface MeldPlan {
  cards: Card[];
  kind: MeldKind;
}

/** 円環（13周期）上のランク距離。 */
function circRankDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 13;
  return Math.min(d, 13 - d);
}

/** 同スート札から最長の連続弧（循環ラップ許可・長さ3以上）を1本返す。無ければ null。 */
function longestRunCards(cards: Card[]): Card[] | null {
  const byRank = new Map<number, Card>();
  for (const c of cards) byRank.set(c.rank, c); // 同スート同ランクは重複しない（1デッキ）
  if (byRank.size === 13) return cards.slice(); // 全周（実手札では稀）
  let best: Card[] = [];
  for (const start of byRank.keys()) {
    const prev = ((start - 2 + 13) % 13) + 1; // start の1つ前のランク（1..13）
    if (byRank.has(prev)) continue; // 連続弧の先頭のみ起点にする
    const run: Card[] = [];
    let r = start;
    for (let k = 0; k < 13 && byRank.has(r); k++) {
      run.push(byRank.get(r)!);
      r = (r % 13) + 1; // 次ランク（13→1 で循環）
    }
    if (run.length > best.length) best = run;
  }
  return best.length >= 3 ? best : null;
}

/** 手札から公開する最良のメルドを選ぶ（枚数最大→合計失点最大。単独7は最後）。無ければ null。 */
function findBestMeld(hand: Card[]): MeldPlan | null {
  const candidates: MeldPlan[] = [];

  // グループ: 同ランク・スート重複なしで最大枚数（3〜4枚）
  const byRank = new Map<number, Card[]>();
  for (const c of hand) (byRank.get(c.rank) ?? byRank.set(c.rank, []).get(c.rank)!).push(c);
  for (const cs of byRank.values()) {
    const distinct: Card[] = [];
    const seenSuit = new Set<string>();
    for (const c of cs) {
      if (seenSuit.has(c.suit)) continue;
      seenSuit.add(c.suit);
      distinct.push(c);
    }
    for (let take = Math.min(4, distinct.length); take >= 3; take--) {
      const sub = distinct.slice(0, take);
      if (canPublish(sub, 'group')) {
        candidates.push({ cards: sub, kind: 'group' });
        break;
      }
    }
  }

  // シークエンス: 同スート最長連続弧
  const bySuit = new Map<string, Card[]>();
  for (const c of hand) (bySuit.get(c.suit) ?? bySuit.set(c.suit, []).get(c.suit)!).push(c);
  for (const cs of bySuit.values()) {
    const run = longestRunCards(cs);
    if (run && canPublish(run, 'sequence')) candidates.push({ cards: run, kind: 'sequence' });
  }

  // 単独7
  const seven = hand.find((c) => c.rank === 7);
  if (seven && canPublish([seven], 'lone7')) candidates.push({ cards: [seven], kind: 'lone7' });

  if (candidates.length === 0) return null;
  const pts = (cs: Card[]): number => cs.reduce((s, c) => s + cardPoints(c), 0);
  const size = (p: MeldPlan): number => (p.kind === 'lone7' ? 0 : p.cards.length); // 単独7は最後回し
  candidates.sort((a, b) => (size(b) - size(a)) || (pts(b.cards) - pts(a.cards)));
  return candidates[0]!;
}

/** 捨てる1枚を選ぶ: 最も孤立（メルドに絡まない）で、その中で失点の高いカード。 */
function pickDiscard(hand: Card[]): Card | null {
  if (hand.length === 0) return null;
  let worst = hand[0]!;
  let worstScore = Infinity;
  hand.forEach((c, i) => {
    let sameRank = 0;
    let nearSuit = 0;
    hand.forEach((x, j) => {
      if (i === j) return;
      if (x.rank === c.rank) sameRank++;
      else if (x.suit === c.suit && circRankDist(x.rank, c.rank) <= 2) nearSuit++;
    });
    const connectivity = sameRank * 2 + nearSuit; // グループ材料を重めに評価
    const score = connectivity * 100 - cardPoints(c); // 低連結ほど、同点なら高失点ほど捨てる
    if (score < worstScore) {
      worstScore = score;
      worst = c;
    }
  });
  return worst;
}

/**
 * 手番（awaitingDraw / awaitingDiscard）の着手を1つ決める（純粋・視界=自席 view）。
 * 呼び出し側が着手のたびに再導出して呼ぶことで、公開→付け札→捨ての多段が進む。
 */
export function decideTurnAction(view: PlayerView): Action | null {
  const me = view.seats[view.youIndex];
  if (!me) return null;
  const meId = me.id;
  if (view.phase === 'awaitingDraw') return { type: 'draw', player: meId };
  if (view.phase !== 'awaitingDiscard') return null;

  // 1) 公開できるメルドは公開する
  const meld = findBestMeld(view.hand);
  if (meld) return { type: 'publishMeld', player: meId, cards: meld.cards, meldKind: meld.kind };

  // 2) 自分の公開メルドがあれば付け札で失点を減らす
  if (view.melds.some((m) => m.owner === meId)) {
    for (const m of view.melds) {
      const card = view.hand.find((c) => canAttach(m, c));
      if (card) return { type: 'attach', player: meId, meldId: m.id, card };
    }
  }

  // 3) 失点の高い孤立カードを捨てる
  const card = pickDiscard(view.hand);
  return card ? { type: 'discard', player: meId, card } : null;
}

/**
 * 鳴くか見送るかを決める（純粋・視界=自席 view の yourClaims と手札のみ）。
 * ポン優先（無条件で妥当なグループ化）・チー次点。人間らしいムラを rnd で与える。
 */
export function decideBotClaim(view: PlayerView, rnd: () => number = Math.random): 'pon' | 'chi' | null {
  const kinds = view.yourClaims;
  if (view.phase !== 'meldWindow' || kinds.length === 0) return null;
  if (kinds.includes('pon') && rnd() < 0.8) return 'pon';
  if (kinds.includes('chi') && rnd() < 0.6) return 'chi';
  return null; // 見送り（パス）
}

/** 鳴きに使う手札の組を列挙した pon/chi アクション（エンジンが妥当な組を受理する）。 */
export function claimActions(view: PlayerView, kind: 'pon' | 'chi'): Action[] {
  const me = view.seats[view.youIndex];
  if (!me || !view.claimWindow) return [];
  const disc = view.claimWindow.card;
  const cand = view.hand.filter((c) => (kind === 'pon' ? c.rank === disc.rank : c.suit === disc.suit));
  const acts: Action[] = [];
  for (let i = 0; i < cand.length; i++) {
    for (let j = i + 1; j < cand.length; j++) {
      acts.push({ type: kind, player: me.id, cards: [cand[i]!, cand[j]!] });
    }
  }
  return acts;
}

// ---- 実行ドライバ（権威側で NPC を自動着手させる） -------------------------

const POLL_MS = 350;
export const THINK_MIN_MS = 800;
export const THINK_MAX_MS = 1600;

/**
 * 権威ドライバ（LocalDriver 固定自席 / HostDriver）上で NPC 席を自動進行させるループ。
 * - 単一の自己スケジュール setタイマー + busy ガードで、タブ非表示からの復帰でも多重着手しない（E3）。
 * - 着手ごとに 0.8〜1.6s の思考待ち（鳴きは1ウィンドウ1回の思考でまとめて確定＝10s 満了前に必ず収束・E4）。
 * - 判断入力は driver.getView(npcId)（=その席の視界）に限定。着手は driver.applyBot（権威適用）で行う。
 */
export class BotRunner {
  private readonly driver: GameDriver;
  private readonly npcIds: Set<string>;
  private readonly rnd: () => number;
  private timer: ReturnType<typeof setTimeout> | 0 = 0;
  private disposed = false;
  private busy = false;
  // 現在の鳴きウィンドウの決定状態（ウィンドウキーが変わったらリセット）。
  private windowKey = '';
  private thoughtWindow = ''; // このウィンドウで思考待ちを一度適用済みか
  private passed = new Set<string>(); // パス発行済みの NPC
  private wants = new Map<string, 'pon' | 'chi'>(); // 鳴き希望中の NPC とその種類

  constructor(driver: GameDriver, npcIds: Iterable<string>, opts?: { rnd?: () => number }) {
    this.driver = driver;
    this.npcIds = new Set(npcIds);
    this.rnd = opts?.rnd ?? Math.random;
  }

  start(): void {
    this.schedule(POLL_MS);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  // ---- スケジューリング --------------------------------------------------

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = 0;
    }
  }

  private schedule(ms: number): void {
    if (this.disposed) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = 0;
      this.tick();
    }, ms);
  }

  private scheduleAct(fn: () => Promise<void>, ms: number): void {
    if (this.disposed) return;
    this.busy = true;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = 0;
      void fn()
        .catch(() => undefined)
        .finally(() => {
          this.busy = false;
          this.schedule(POLL_MS);
        });
    }, ms);
  }

  private think(): number {
    return THINK_MIN_MS + this.rnd() * (THINK_MAX_MS - THINK_MIN_MS);
  }

  /** 進行ルーティング用の視界（先頭 NPC の視界＝公開情報 phase/seats/claimWindow は全席共通）。 */
  private anchorView(): PlayerView | null {
    const first = this.npcIds.values().next().value as string | undefined;
    if (first == null) return null;
    try {
      return this.driver.getView(first);
    } catch {
      return null;
    }
  }

  private tick(): void {
    if (this.disposed) return;
    if (this.busy) {
      this.schedule(POLL_MS);
      return;
    }
    const v = this.anchorView();
    if (!v) {
      this.schedule(POLL_MS);
      return;
    }

    if (v.phase === 'awaitingDraw' || v.phase === 'awaitingDiscard') {
      const cur = v.seats.find((s) => s.isCurrent);
      if (cur && this.npcIds.has(cur.id)) {
        this.scheduleAct(() => this.actTurn(cur.id), this.think());
        return;
      }
      this.schedule(POLL_MS);
      return;
    }

    if (v.phase === 'meldWindow' && v.claimWindow) {
      const key = this.windowKeyOf(v);
      if (key !== this.windowKey) {
        this.windowKey = key;
        this.thoughtWindow = '';
        this.passed.clear();
        this.wants.clear();
      }
      const pending = this.eligibleNpcs(v).filter((id) => !this.passed.has(id));
      if (pending.length === 0) {
        this.schedule(POLL_MS);
        return;
      }
      const firstThink = this.thoughtWindow !== key;
      this.scheduleAct(() => this.actClaims(key), firstThink ? this.think() : POLL_MS);
      return;
    }

    this.schedule(POLL_MS);
  }

  // ---- 着手 --------------------------------------------------------------

  private windowKeyOf(v: PlayerView): string {
    return v.claimWindow ? `${v.round}:${v.discardPile.length}:${cardId(v.claimWindow.card)}` : '';
  }

  /** 鳴き資格のある NPC（自席 view の yourClaims で判定＝視界公正）。 */
  private eligibleNpcs(_v: PlayerView): string[] {
    const out: string[] = [];
    for (const id of this.npcIds) {
      let nv: PlayerView;
      try {
        nv = this.driver.getView(id);
      } catch {
        continue;
      }
      if (nv.phase === 'meldWindow' && nv.yourClaims.length > 0) out.push(id);
    }
    return out;
  }

  private async apply(action: Action): Promise<ActionResult> {
    const fn = this.driver.applyBot;
    if (!fn) return { ok: false, error: 'botPlayer: driver has no applyBot' };
    return fn.call(this.driver, action);
  }

  private stillWindow(key: string): boolean {
    const v = this.anchorView();
    return !!v && v.phase === 'meldWindow' && this.windowKeyOf(v) === key;
  }

  private async actTurn(npcId: string): Promise<void> {
    if (this.disposed) return;
    const view = this.driver.getView(npcId);
    const cur = view.seats.find((s) => s.isCurrent);
    if (!cur || cur.id !== npcId) return; // 手番が移っていた
    const action = decideTurnAction(view);
    if (action) await this.apply(action);
  }

  private async actClaims(key: string): Promise<void> {
    if (this.disposed || !this.stillWindow(key)) return;
    this.thoughtWindow = key;

    // 1) 未決定の鳴き資格 NPC を判断する。見送りは即パス、鳴き希望は wants に登録。
    for (const id of this.eligibleNpcs(this.anchorView()!)) {
      if (this.passed.has(id) || this.wants.has(id)) continue;
      const nv = this.driver.getView(id);
      if (nv.phase !== 'meldWindow' || nv.yourClaims.length === 0) continue;
      const kind = decideBotClaim(nv, this.rnd);
      if (kind) {
        this.wants.set(id, kind);
      } else {
        await this.apply({ type: 'pass', player: id });
        this.passed.add(id);
        if (!this.stillWindow(key)) return; // このパスでウィンドウが閉じた
      }
    }

    // 2) 鳴き希望を試行する。エンジンが優先度最上位のみ受理するため、成立した時点で確定。
    //    優先度で下位のもの（上位=人間/他NPC が保留）は失敗し wants に残す（次ポーリングで再試行）。
    for (const [id, kind] of this.wants) {
      if (!this.stillWindow(key)) return;
      const nv = this.driver.getView(id);
      if (nv.phase !== 'meldWindow' || nv.yourClaims.length === 0) {
        this.wants.delete(id);
        this.passed.add(id);
        continue;
      }
      if (!nv.yourClaims.includes(kind)) continue;
      for (const act of claimActions(nv, kind)) {
        const r = await this.apply(act);
        if (r.ok) {
          this.wants.delete(id);
          return; // 鳴き成立＝ウィンドウ解決
        }
      }
    }
  }
}
