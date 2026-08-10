// スコア票（ラウンド×プレイヤーの失点マトリクス＋各ラウンド合計＋累計）。要件 §2.6 / §3.3-4。
// 各セルは「そのラウンドの失点」と「その時点の累計（=そのプレイヤーの R1..r の失点合計）」を2段で併記する
// （契約09 項目3）。行末「行計」列・最下段「累計」行は従来どおり維持。横に長い表はラッパで横スクロール。
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

  const totals = new Array<number>(n).fill(0); // 各プレイヤー列の縦累積（= その時点の累計）
  view.scores.forEach((row, r) => {
    const tr = el('tr', {}, [el('th', { text: `R${r + 1}` })]);
    let rowSum = 0;
    for (let i = 0; i < n; i++) {
      const raw = row[i];
      const v = raw ?? 0;
      totals[i]! += v;
      rowSum += v;
      // 未消化/欠損セルは失点を「—」表示（累計はその時点の値を出す・E1）。
      const pt = el('span', { class: 'pt', text: raw == null ? '—' : String(v) });
      const cum = el('span', { class: 'cum', text: `計${totals[i]}` });
      tr.append(el('td', { class: 'cell' }, [pt, cum]));
    }
    tr.append(el('td', { class: 'rowsum', text: String(rowSum) }));
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

  // 横スクロールラッパ（6人×多ラウンドでもモーダル内で崩れず、はみ出し分だけ横スクロール・E1）。
  return el('div', { class: 'score-wrap' }, [table]);
}
