import { describe, it, expect } from 'vitest';
import { nextRng, shuffle, orderedDeck, cardId } from '../src/core';

describe('シード付きRNG (E6: 決定性)', () => {
  it('同一シードは同一シーケンスを生成する', () => {
    const seqA: number[] = [];
    const seqB: number[] = [];
    let a = 42;
    let b = 42;
    for (let i = 0; i < 5; i++) {
      const sa = nextRng(a);
      a = sa.state;
      seqA.push(sa.value);
      const sb = nextRng(b);
      b = sb.state;
      seqB.push(sb.value);
    }
    expect(seqA).toEqual(seqB);
    seqA.forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    });
  });

  it('同一シードのシャッフルは同一結果、異シードは異なる', () => {
    const deck = orderedDeck();
    const s1 = shuffle(deck, 123).result.map(cardId);
    const s2 = shuffle(deck, 123).result.map(cardId);
    const s3 = shuffle(deck, 124).result.map(cardId);
    expect(s1).toEqual(s2);
    expect(s1).not.toEqual(s3);
    // シャッフルしても52枚一意を保つ（元配列は不変）
    expect(new Set(s1).size).toBe(52);
    expect(deck.map(cardId)).toEqual(orderedDeck().map(cardId));
  });
});
