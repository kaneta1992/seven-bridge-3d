// メルド（役）の型・判定・成長ロジック。純粋関数のみ。
import type { Card, Suit } from './cards';
import { sameCard } from './cards';

export type MeldKind = 'sequence' | 'group' | 'lone7';

export interface Meld {
  readonly id: number;
  /** 公開したプレイヤーID（付け札は誰のメルドにも可、失点は手札のみなので所有はメルド解禁判定用） */
  readonly owner: string;
  kind: MeldKind;
  cards: Card[];
  /**
   * 単独7の成長方向。lone7 のみ意味を持つ:
   * undefined=未確定 / 'sequence'=シークェンス化確定 / 'group'=グループ化確定。
   * 確定後は逆方向を拒否する（要件 §2.2）。
   */
  determined?: 'sequence' | 'group';
}

/**
 * ランク列が連続する並びか（A絡み対応）。
 * A(1) は低位(A-2-3)としてそのまま、あるいは高位(…Q-K-A → 14)として扱う。
 * K-A-2 のラップは両解釈とも不連続になり自然に false。
 */
export function isConsecutiveRun(ranks: readonly number[]): boolean {
  if (ranks.length === 0) return false;
  if (new Set(ranks).size !== ranks.length) return false; // 重複は不可
  const consec = (arr: number[]): boolean =>
    arr.every((v, i) => i === 0 || v === arr[i - 1]! + 1);
  const low = [...ranks].sort((a, b) => a - b);
  if (consec(low)) return true;
  if (ranks.includes(1)) {
    const high = ranks.map((r) => (r === 1 ? 14 : r)).sort((a, b) => a - b);
    if (consec(high)) return true;
  }
  return false;
}

function allSameSuit(cards: readonly Card[]): boolean {
  return cards.every((c) => c.suit === cards[0]!.suit);
}

function hasDuplicateCard(cards: readonly Card[]): boolean {
  const ids = new Set(cards.map((c) => `${c.suit}${c.rank}`));
  return ids.size !== cards.length;
}

/** 3枚以上・同スート・連続（A絡み対応）。 */
export function isValidSequence(cards: readonly Card[]): boolean {
  if (cards.length < 3) return false;
  if (hasDuplicateCard(cards)) return false;
  if (!allSameSuit(cards)) return false;
  return isConsecutiveRun(cards.map((c) => c.rank));
}

/** 同ランク3〜4枚・スート重複なし。 */
export function isValidGroup(cards: readonly Card[]): boolean {
  if (cards.length < 3 || cards.length > 4) return false;
  if (!cards.every((c) => c.rank === cards[0]!.rank)) return false;
  const suits = new Set<Suit>(cards.map((c) => c.suit));
  return suits.size === cards.length; // スート重複なし
}

/** 単独7: 7 の1枚。 */
export function isLone7(cards: readonly Card[]): boolean {
  return cards.length === 1 && cards[0]!.rank === 7;
}

/** メルド公開が正当か（種類別）。 */
export function canPublish(cards: readonly Card[], kind: MeldKind): boolean {
  switch (kind) {
    case 'sequence':
      return isValidSequence(cards);
    case 'group':
      return isValidGroup(cards);
    case 'lone7':
      return isLone7(cards);
  }
}

function suitPresent(cards: readonly Card[], suit: Suit): boolean {
  return cards.some((c) => c.suit === suit);
}

/** 付け札が正当か（メルドの種類・成長方向を尊重）。 */
export function canAttach(meld: Meld, card: Card): boolean {
  if (meld.cards.some((c) => sameCard(c, card))) return false; // 同一カードは不可

  switch (meld.kind) {
    case 'sequence': {
      if (card.suit !== meld.cards[0]!.suit) return false;
      return isConsecutiveRun([...meld.cards.map((c) => c.rank), card.rank]);
    }
    case 'group': {
      if (card.rank !== meld.cards[0]!.rank) return false;
      if (meld.cards.length >= 4) return false; // 最大4枚
      return !suitPresent(meld.cards, card.suit); // スート重複なし
    }
    case 'lone7': {
      const seven = meld.cards[0]!; // 起点の7（同スート判定に使用）
      if (meld.determined === undefined) {
        // 未確定: 同スート隣接(6/8)→シークェンス化 / 他スート7→グループ化
        if (card.suit === seven.suit && (card.rank === 6 || card.rank === 8)) return true;
        if (card.rank === 7 && card.suit !== seven.suit) return true;
        return false;
      }
      if (meld.determined === 'sequence') {
        if (card.suit !== seven.suit) return false;
        return isConsecutiveRun([...meld.cards.map((c) => c.rank), card.rank]);
      }
      // determined === 'group'
      if (card.rank !== 7) return false;
      if (meld.cards.length >= 4) return false;
      return !suitPresent(meld.cards, card.suit);
    }
  }
}

/** 付け札を適用した新しいメルドを返す（canAttach が真である前提）。元メルドは不変。 */
export function attachResult(meld: Meld, card: Card): Meld {
  const cards = [...meld.cards, card];
  let kind: MeldKind = meld.kind;
  let determined = meld.determined;

  if (meld.kind === 'lone7' && determined === undefined) {
    determined = card.rank === 7 ? 'group' : 'sequence';
  }
  // 表示・後続判定のため、確定した lone7 は実体の種類へ昇格させる
  if (meld.kind === 'lone7' && determined !== undefined) {
    kind = determined;
  }

  const next: Meld = { id: meld.id, owner: meld.owner, kind, cards };
  if (determined !== undefined && kind === 'lone7') next.determined = determined;
  return next;
}
