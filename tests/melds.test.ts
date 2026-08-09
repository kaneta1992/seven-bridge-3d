import { describe, it, expect } from 'vitest';
import {
  isValidSequence,
  isValidGroup,
  isLone7,
  canPublish,
  canAttach,
  attachResult,
  isConsecutiveRun,
} from '../src/core';
import type { Meld } from '../src/core';
import { c } from './helpers';

describe('シークェンス判定 (E1: A絡み境界・ラップ不可)', () => {
  it('同スート連続3枚以上は有効', () => {
    expect(isValidSequence([c('S', 4), c('S', 5), c('S', 6)])).toBe(true);
    expect(isValidSequence([c('S', 4), c('S', 5), c('S', 6), c('S', 7)])).toBe(true);
  });
  it('A-2-3 は可', () => {
    expect(isValidSequence([c('D', 1), c('D', 2), c('D', 3)])).toBe(true);
  });
  it('Q-K-A は可', () => {
    expect(isValidSequence([c('H', 12), c('H', 13), c('H', 1)])).toBe(true);
  });
  it('K-A-2 のラップは不可', () => {
    expect(isValidSequence([c('C', 13), c('C', 1), c('C', 2)])).toBe(false);
  });
  it('異スート混在・2枚以下・不連続は無効', () => {
    expect(isValidSequence([c('S', 4), c('H', 5), c('S', 6)])).toBe(false);
    expect(isValidSequence([c('S', 4), c('S', 5)])).toBe(false);
    expect(isValidSequence([c('S', 4), c('S', 6), c('S', 7)])).toBe(false);
  });
  it('isConsecutiveRun の単体挙動', () => {
    expect(isConsecutiveRun([4, 5, 6])).toBe(true);
    expect(isConsecutiveRun([1, 2, 3])).toBe(true);
    expect(isConsecutiveRun([12, 13, 1])).toBe(true); // Q-K-A
    expect(isConsecutiveRun([13, 1, 2])).toBe(false); // K-A-2
    expect(isConsecutiveRun([4, 4, 5])).toBe(false); // 重複
  });
});

describe('グループ判定 (E9: スート重複なし・最大4枚)', () => {
  it('同ランク3〜4枚・スート重複なしは有効', () => {
    expect(isValidGroup([c('S', 9), c('H', 9), c('D', 9)])).toBe(true);
    expect(isValidGroup([c('S', 9), c('H', 9), c('D', 9), c('C', 9)])).toBe(true);
  });
  it('5枚目・スート重複・異ランクは無効', () => {
    expect(isValidGroup([c('S', 9), c('H', 9), c('D', 9), c('C', 9), c('S', 9)])).toBe(false);
    expect(isValidGroup([c('S', 9), c('S', 9), c('D', 9)])).toBe(false);
    expect(isValidGroup([c('S', 9), c('H', 9), c('D', 8)])).toBe(false);
  });
});

describe('単独7とメルド公開', () => {
  it('7一枚は lone7 として公開可', () => {
    expect(isLone7([c('S', 7)])).toBe(true);
    expect(isLone7([c('S', 8)])).toBe(false);
    expect(canPublish([c('S', 7)], 'lone7')).toBe(true);
  });
});

describe('単独7の成長 (E2: シークェンス化/グループ化/方向確定後は逆方向拒否)', () => {
  const lone = (): Meld => ({ id: 0, owner: 'p0', kind: 'lone7', cards: [c('S', 7)] });

  it('同スート6/8でシークェンス化、その後は同スート連続のみ', () => {
    const m = lone();
    expect(canAttach(m, c('S', 6))).toBe(true);
    expect(canAttach(m, c('S', 8))).toBe(true);
    const seq = attachResult(m, c('S', 6)); // -> [7,6] シークェンス確定
    expect(seq.kind).toBe('sequence');
    expect(canAttach(seq, c('S', 8))).toBe(true); // 逆端の8も連続なので可
    expect(canAttach(seq, c('S', 5))).toBe(true);
    // 逆方向(グループ化=他スート7)は拒否
    expect(canAttach(seq, c('H', 7))).toBe(false);
  });

  it('他スート7でグループ化、その後は他スート7のみ・最大4枚', () => {
    const m = lone();
    expect(canAttach(m, c('H', 7))).toBe(true);
    expect(canAttach(m, c('S', 7))).toBe(false); // 同スート7は不可（重複）
    const grp = attachResult(m, c('H', 7)); // -> [S7,H7] グループ確定
    expect(grp.kind).toBe('group');
    expect(canAttach(grp, c('D', 7))).toBe(true);
    // 逆方向(シークェンス化=同スート隣接)は拒否
    expect(canAttach(grp, c('S', 6))).toBe(false);
    const g3 = attachResult(grp, c('D', 7));
    const g4 = attachResult(g3, c('C', 7));
    expect(g4.cards.length).toBe(4);
    // 4枚を超える追加は不可（7は他に存在しないが規則上も拒否）
    expect(canAttach(g4, c('S', 7))).toBe(false);
  });

  it('未確定の7に無関係なカードは付かない', () => {
    expect(canAttach(lone(), c('S', 9))).toBe(false);
    expect(canAttach(lone(), c('H', 6))).toBe(false);
  });
});

describe('付け札の連続/グループ拡張', () => {
  it('シークェンスは両端の連続カードを追加できる', () => {
    const seq: Meld = { id: 1, owner: 'p0', kind: 'sequence', cards: [c('D', 5), c('D', 6), c('D', 7)] };
    expect(canAttach(seq, c('D', 4))).toBe(true);
    expect(canAttach(seq, c('D', 8))).toBe(true);
    expect(canAttach(seq, c('D', 10))).toBe(false); // 不連続
    expect(canAttach(seq, c('H', 8))).toBe(false); // 異スート
  });
  it('Q-K-A シークェンスに2は付かない（ラップ不可）', () => {
    const seq: Meld = { id: 2, owner: 'p0', kind: 'sequence', cards: [c('H', 12), c('H', 13), c('H', 1)] };
    expect(canAttach(seq, c('H', 11))).toBe(true); // J-Q-K-A
    expect(canAttach(seq, c('H', 2))).toBe(false);
  });
  it('グループは残スートのみ・4枚まで', () => {
    const grp: Meld = { id: 3, owner: 'p0', kind: 'group', cards: [c('S', 9), c('H', 9), c('D', 9)] };
    expect(canAttach(grp, c('C', 9))).toBe(true);
    expect(canAttach(grp, c('S', 9))).toBe(false); // スート重複
    const full = attachResult(grp, c('C', 9));
    expect(canAttach(full, c('S', 9))).toBe(false); // 5枚目
  });
});
