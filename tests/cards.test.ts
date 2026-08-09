import { describe, it, expect } from 'vitest';
import { CARD_POINTS, cardPoints, handScore, orderedDeck, cardId } from '../src/core';
import { c } from './helpers';

describe('失点テーブル (E5: A=1 / 2..10=額面 / J=11 / Q=12 / K=13)', () => {
  it('テーブル値を固定する', () => {
    expect(CARD_POINTS[1]).toBe(1); // A
    expect(CARD_POINTS[2]).toBe(2);
    expect(CARD_POINTS[10]).toBe(10);
    expect(CARD_POINTS[11]).toBe(11); // J
    expect(CARD_POINTS[12]).toBe(12); // Q
    expect(CARD_POINTS[13]).toBe(13); // K
  });

  it('cardPoints と handScore が合計を返す', () => {
    expect(cardPoints(c('S', 1))).toBe(1);
    expect(cardPoints(c('H', 13))).toBe(13);
    // A(1) + K(13) + 5 = 19
    expect(handScore([c('S', 1), c('H', 13), c('D', 5)])).toBe(19);
    expect(handScore([])).toBe(0);
  });
});

describe('デッキ', () => {
  it('ジョーカーなし52枚・全て一意', () => {
    const deck = orderedDeck();
    expect(deck.length).toBe(52);
    expect(new Set(deck.map(cardId)).size).toBe(52);
  });
});
