// カードの基本型と失点テーブル（純粋TS・DOM/three/trystero 非依存）

export type Suit = 'C' | 'D' | 'H' | 'S';
export type Rank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;

export interface Card {
  readonly suit: Suit;
  readonly rank: Rank;
}

export const SUITS: readonly Suit[] = ['C', 'D', 'H', 'S'];
export const RANKS: readonly Rank[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

/** 一意なカードID（スート+ランク）。52枚は suit+rank で一意に定まる。 */
export function cardId(c: Card): string {
  return `${c.suit}${c.rank}`;
}

export function sameCard(a: Card, b: Card): boolean {
  return a.suit === b.suit && a.rank === b.rank;
}

/** 決定的な順序で並んだ 52 枚（ジョーカーなし）。シャッフル前の基準列。 */
export function orderedDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank });
    }
  }
  return deck;
}

/**
 * 失点テーブル（ローカルルール確定値・要件 §2.5 / D2）。
 * A=1, 2〜10=額面, J=11, Q=12, K=13。テストで固定する。
 */
export const CARD_POINTS: Record<Rank, number> = {
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
  8: 8,
  9: 9,
  10: 10,
  11: 11,
  12: 12,
  13: 13,
};

export function cardPoints(card: Card): number {
  return CARD_POINTS[card.rank];
}

/** 手札の合計失点。 */
export function handScore(hand: readonly Card[]): number {
  return hand.reduce((sum, c) => sum + cardPoints(c), 0);
}
