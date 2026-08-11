import { describe, expect, it } from 'vitest';
import type { PlayerView, PlayerViewSeat } from '../src/core/engine';
import { seatTotals } from '../src/ui/scoreTotals';

// seatTotals は表示層の集計（契約20項目3）。seats と scores だけを持つ最小ビューで検証する。
function view(seatCount: number, scores: number[][]): PlayerView {
  const seats: PlayerViewSeat[] = Array.from({ length: seatCount }, (_, i) => ({
    id: `p${i}`,
    name: `P${i}`,
    index: i,
    handCount: 0,
    isYou: i === 0,
    isDealer: false,
    isCurrent: false,
  }));
  return { seats, scores } as unknown as PlayerView;
}

describe('seatTotals（席ごとの確定累計失点）', () => {
  it('ラウンド未消化なら全員0', () => {
    expect(seatTotals(view(4, []))).toEqual([0, 0, 0, 0]);
  });

  it('複数ラウンドを席index毎に縦合計する', () => {
    const v = view(4, [
      [5, 0, 3, 12],
      [0, 7, 1, 0],
      [2, 2, 0, 4],
    ]);
    expect(seatTotals(v)).toEqual([7, 9, 4, 16]);
  });

  it('欠損セル（null/undefined）は0として扱う', () => {
    const scores = [[3, undefined as unknown as number], [null as unknown as number, 4]];
    expect(seatTotals(view(2, scores))).toEqual([3, 4]);
  });

  it('席数に合わせた長さを返す（余剰列は無視）', () => {
    const v = view(2, [[1, 2, 99]]); // 3列目は席が無いので集計に出ない
    expect(seatTotals(v)).toEqual([1, 2]);
  });
});
