// メルドの表示用カード整列（純粋関数・DOM/three 非依存）。2D チップ（ui/app.ts）と
// 3D 卓（render/scene.ts）の両方が同じ順序で描画するため、共有する。
// core のメルド（meld.cards）は不変に保つ（付け札の cardId 対応を壊さない・契約06 E8）。
import type { Card, Meld } from '../core';
import { SUITS } from '../core';

const suitOrder = (s: Card['suit']): number => SUITS.indexOf(s);

/**
 * メルドのカードを表示順に整列した新規配列で返す（元配列は変更しない）。
 * - sequence: 循環アークとして整列（2026-08-10 ラップ許可対応）。アークの起点
 *   （循環で1つ前のランクが列に無いカード）から円環順に並べる。
 *   A-2-3 は A 先頭 / Q-K-A は A 末尾 / K-A-2 は K,A,2 の順になる。
 * - group: 同ランクなのでスート順（C→D→H→S）で安定表示。
 * - lone7 / それ以外: 元の順序のコピー（単独7は1枚なので不変）。
 */
export function orderedMeldCards(meld: Meld): Card[] {
  const cards = meld.cards.slice();
  if (meld.kind === 'group') {
    return cards.sort((a, b) => suitOrder(a.suit) - suitOrder(b.suit));
  }
  if (meld.kind === 'sequence') {
    const ranks = new Set<number>(cards.map((c) => c.rank));
    let start: number = cards[0]!.rank;
    if (ranks.size < 13) {
      for (const c of cards) {
        const prev = ((c.rank - 2 + 13) % 13) + 1; // 円環上で1つ前のランク
        if (!ranks.has(prev)) {
          start = c.rank;
          break;
        }
      }
    }
    const pos = (r: number): number => (r - start + 13) % 13;
    return cards.sort((a, b) => pos(a.rank) - pos(b.rank));
  }
  return cards;
}
