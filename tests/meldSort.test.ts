// メルド表示整列（render/meldSort の orderedMeldCards）の循環整列テスト（契約10項目17）。
// 純粋関数（core にのみ依存）なので three/DOM なしで検証できる。
import { describe, expect, it } from 'vitest';
import type { Meld } from '../src/core';
import { orderedMeldCards } from '../src/render/meldSort';
import { c } from './helpers';

const seq = (ranks: number[]): Meld => ({
  id: 1,
  owner: 'p0',
  kind: 'sequence',
  cards: ranks.map((r) => c('S', r as never)),
});
const ranksOf = (m: Meld): number[] => orderedMeldCards(m).map((x) => x.rank);

describe('orderedMeldCards シークェンスの循環整列（項目17）', () => {
  it('K-A-2 は K,A,2 の順（A をまたぐ弧の起点は K）', () => {
    expect(ranksOf(seq([2, 13, 1]))).toEqual([13, 1, 2]);
  });

  it('A-2-3 は A 先頭', () => {
    expect(ranksOf(seq([3, 1, 2]))).toEqual([1, 2, 3]);
  });

  it('Q-K-A は A 末尾', () => {
    expect(ranksOf(seq([1, 13, 12]))).toEqual([12, 13, 1]);
  });

  it('J-Q-K-A-2 は J 起点でラップ順に並ぶ', () => {
    expect(ranksOf(seq([2, 1, 13, 12, 11]))).toEqual([11, 12, 13, 1, 2]);
  });

  it('13枚全周は入力順を保つ（起点判定に依存せず安定・重複ギャップなし）', () => {
    const all = [5, 6, 7, 8, 9, 10, 11, 12, 13, 1, 2, 3, 4];
    // 全周では「1つ前が列に無いカード」が存在しないため起点は先頭のまま＝入力順のコピー。
    expect(ranksOf(seq(all))).toEqual(all);
    expect(orderedMeldCards(seq(all)).length).toBe(13);
  });

  it('元のメルドの cards 配列は変更しない（不変・付け札 cardId 対応を壊さない）', () => {
    const m = seq([2, 13, 1]);
    const before = m.cards.map((x) => x.rank);
    orderedMeldCards(m);
    expect(m.cards.map((x) => x.rank)).toEqual(before);
  });

  it('グループはスート順（C→D→H→S）で安定表示', () => {
    const grp: Meld = {
      id: 2,
      owner: 'p0',
      kind: 'group',
      cards: [c('S', 9), c('C', 9), c('H', 9), c('D', 9)],
    };
    expect(orderedMeldCards(grp).map((x) => x.suit)).toEqual(['C', 'D', 'H', 'S']);
  });
});
