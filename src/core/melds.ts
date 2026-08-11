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
}

/**
 * ランク列が循環連続する並びか（2026-08-10 ユーザー指定でラップ許可）。
 * A-2-3 / Q-K-A に加え K-A-2 のような A をまたぐ連続も有効。
 * 判定: 重複なしのランク集合が 13 周期の円環上で1本の連続弧を成すこと
 * （昇順に並べ循環ギャップを数え、距離1でないギャップがちょうど1箇所なら弧。13枚全周も可）。
 */
export function isConsecutiveRun(ranks: readonly number[]): boolean {
  const n = ranks.length;
  if (n === 0) return false;
  if (new Set(ranks).size !== n) return false; // 重複は不可
  if (n === 13) return true; // 同スート全周
  const s = [...ranks].sort((a, b) => a - b);
  let bigGaps = 0;
  for (let i = 0; i < n; i++) {
    const cur = s[i]!;
    const next = s[(i + 1) % n]!;
    const gap = (((next - cur) % 13) + 13) % 13; // 円環上の前進距離
    if (gap !== 1) bigGaps++;
  }
  return bigGaps === 1;
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
      // 単独7の成長は同スート隣接(6/8)によるシークェンス化のみ（要件§2.2）。
      // 他スート7でのグループ化経路は廃止した（単独7へ7は付かない）。
      const seven = meld.cards[0]!; // 起点の7（同スート判定に使用）
      return card.suit === seven.suit && (card.rank === 6 || card.rank === 8);
    }
  }
}

/** 付け札を適用した新しいメルドを返す（canAttach が真である前提）。元メルドは不変。 */
export function attachResult(meld: Meld, card: Card): Meld {
  // 付けるカードは防御コピーする（呼び出し側の参照を新メルドへ共有しない・publishMeld/鳴きと整合）。
  const cards = [...meld.cards, { ...card }];
  // 単独7へ同スート6/8が付いたらシークェンスへ昇格する（唯一の成長経路・要件§2.2）。
  const kind: MeldKind = meld.kind === 'lone7' ? 'sequence' : meld.kind;
  return { id: meld.id, owner: meld.owner, kind, cards };
}
