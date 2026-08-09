// スコア票（ラウンド×プレイヤーの失点マトリクス＋各ラウンド合計＋累計）。要件 §2.6 / §3.3-4。
import type { PlayerView } from '../core';
import { el } from './dom';

/** view.scores（played rounds）から集計テーブル要素を生成。winners を強調表示。 */
export function buildScoreTable(view: PlayerView, winners: string[] = []): HTMLElement {
  const names = view.seats.slice().sort((a, b) => a.index - b.index).map((s) => s.name);
  const n = names.length;
  const table = el('table', { class: 'score' });

  const head = el('tr', {}, [el('th', { text: 'ラウンド' })]);
  names.forEach((nm) => head.append(el('th', { text: nm })));
  head.append(el('th', { text: '行計' }));
  table.append(head);

  const totals = new Array<number>(n).fill(0);
  view.scores.forEach((row, r) => {
    const tr = el('tr', {}, [el('th', { text: `R${r + 1}` })]);
    let rowSum = 0;
    for (let i = 0; i < n; i++) {
      const v = row[i] ?? 0;
      totals[i]! += v;
      rowSum += v;
      tr.append(el('td', { text: String(v) }));
    }
    tr.append(el('td', { text: String(rowSum) }));
    table.append(tr);
  });

  const winSet = new Set(
    winners
      .map((id) => view.seats.find((s) => s.id === id)?.index)
      .filter((x): x is number => x != null),
  );
  const foot = el('tr', { class: 'totals' }, [el('td', { text: '累計' })]);
  let grand = 0;
  for (let i = 0; i < n; i++) {
    grand += totals[i]!;
    const td = el('td', { text: String(totals[i]) });
    if (winSet.has(i)) td.classList.add('win');
    foot.append(td);
  }
  foot.append(el('td', { text: String(grand) }));
  table.append(foot);
  return table;
}
