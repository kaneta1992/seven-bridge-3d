// 席ごとの確定累計失点（契約20項目3）。view.scores（消化済みラウンドの失点マトリクス）を縦に合計する。
// ヘッダの自席累計・ネームプレートの他家累計・最終結果の順位付けで同一の集計を使うための単一ソース。
// 純粋関数（DOM/three 非依存）＝ tests から直接検証できる。
import type { PlayerView } from '../core';

/** seat.index をキーにした確定累計失点の配列（長さ = 席数）。欠損セルは 0 として扱う。 */
export function seatTotals(view: PlayerView): number[] {
  const totals = new Array<number>(view.seats.length).fill(0);
  for (const row of view.scores) {
    for (let i = 0; i < totals.length; i++) totals[i]! += row[i] ?? 0;
  }
  return totals;
}
