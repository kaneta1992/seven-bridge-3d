// メルドの表示用カード整列（純粋関数・DOM/three 非依存）。2D チップ（ui/app.ts）と
// 3D 卓（render/scene.ts）の両方が同じ順序で描画するため、共有する。
// core のメルド（meld.cards）は不変に保つ（付け札の cardId 対応を壊さない・契約06 E8）。
import type { Card, Meld } from '../core';
import { SUITS } from '../core';

const suitOrder = (s: Card['suit']): number => SUITS.indexOf(s);
const isAscending = (vals: readonly number[]): boolean =>
  vals.every((v, i) => i === 0 || v === vals[i - 1]! + 1);

/**
 * メルドのカードを表示順に整列した新規配列で返す（元配列は変更しない）。
 * - sequence: ランク昇順。低位解釈で連番にならない場合のみ A(1) を高位(14)として扱う
 *   （A-2-3 は A が先頭、Q-K-A は A が末尾）。付け札や公開時のバラ順もこれで復元される。
 * - group: 同ランクなのでスート順（C→D→H→S）で安定表示。
 * - lone7 / それ以外: 元の順序のコピー（単独7は1枚なので不変）。
 */
export function orderedMeldCards(meld: Meld): Card[] {
  const cards = meld.cards.slice();
  if (meld.kind === 'group') {
    return cards.sort((a, b) => suitOrder(a.suit) - suitOrder(b.suit));
  }
  if (meld.kind === 'sequence') {
    const low = cards.slice().sort((a, b) => a.rank - b.rank);
    if (isAscending(low.map((c) => c.rank))) return low;
    // 低位で連番にならない＝A を含む高位並び（…Q-K-A）。A を 14 とみなして昇順。
    const high = (r: number): number => (r === 1 ? 14 : r);
    return cards.sort((a, b) => high(a.rank) - high(b.rank));
  }
  return cards;
}
