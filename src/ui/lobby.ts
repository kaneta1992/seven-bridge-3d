// タイトル/ロビー画面（要件 §3.3-1）: 人数・ラウンド数・プレイヤー名を設定してホットシート開始。
import { clear, el } from './dom';

export interface LobbyResult {
  players: { id: string; name: string }[];
  totalRounds: number;
}

const DEFAULT_NAMES = ['あかり', 'はると', 'つむぎ', 'ゆうと', 'さくら', 'そうた'];

export function renderLobby(root: HTMLElement, onStart: (r: LobbyResult) => void): void {
  clear(root);
  let count = 3;
  let rounds = 4;
  const nameInputs: HTMLInputElement[] = [];

  const namesWrap = el('div', { class: 'row' });
  const rebuildNames = (): void => {
    clear(namesWrap);
    nameInputs.length = 0;
    namesWrap.append(el('label', { text: 'プレイヤー名' }));
    const list = el('div', { class: 'seg' });
    for (let i = 0; i < count; i++) {
      const input = el('input', {
        type: 'text',
        maxlength: '10',
        value: DEFAULT_NAMES[i] ?? `席${i + 1}`,
      }) as HTMLInputElement;
      input.style.width = '110px';
      nameInputs.push(input);
      list.append(input);
    }
    namesWrap.append(list);
  };

  const countSeg = el('div', { class: 'seg' });
  const countBtns: HTMLButtonElement[] = [];
  for (let n = 2; n <= 6; n++) {
    const b = el('button', { text: `${n}人` }) as HTMLButtonElement;
    if (n === count) b.classList.add('on');
    b.onclick = () => {
      count = n;
      countBtns.forEach((x, i) => x.classList.toggle('on', i + 2 === n));
      rebuildNames();
    };
    countBtns.push(b);
    countSeg.append(b);
  }

  const roundSeg = el('div', { class: 'seg' });
  const roundBtns: HTMLButtonElement[] = [];
  [1, 2, 3, 4, 6, 8, 12, 20].forEach((r) => {
    const b = el('button', { text: `${r}` }) as HTMLButtonElement;
    if (r === rounds) b.classList.add('on');
    b.onclick = () => {
      rounds = r;
      roundBtns.forEach((x) => x.classList.toggle('on', Number(x.textContent) === r));
    };
    roundBtns.push(b);
    roundSeg.append(b);
  });

  const startBtn = el('button', { class: 'primary', text: '対局開始（ホットシート）' }) as HTMLButtonElement;
  startBtn.onclick = () => {
    const players = nameInputs.map((inp, i) => ({
      id: `p${i}`,
      name: (inp.value.trim() || `席${i + 1}`).slice(0, 10),
    }));
    onStart({ players, totalRounds: rounds });
  };

  rebuildNames();
  const modal = el('div', { class: 'modal' }, [
    el('h1', { text: 'セブンブリッジ 3D' }),
    el('h2', { text: '1台で全員を順に操作するホットシート対局' }),
    el('div', { class: 'row' }, [el('label', { text: '人数' }), countSeg]),
    el('div', { class: 'row' }, [el('label', { text: 'ラウンド数' }), roundSeg]),
    namesWrap,
    el('div', { class: 'row' }, [startBtn]),
    el('p', { class: 'hint', text: '手番ごとに操作プレイヤーが自動で切り替わります。' }),
  ]);
  root.append(el('div', { class: 'center' }, [modal]));
}
