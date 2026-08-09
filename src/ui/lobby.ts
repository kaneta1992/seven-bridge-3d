// タイトル/ロビー画面（要件 §3.3-1）。3導線: ホットシート / ルーム作成（通信対戦）/ ルーム参加。
import { normalizeRoomCode } from '../net/protocol';
import { clear, el } from './dom';

export interface LobbyResult {
  players: { id: string; name: string }[];
  totalRounds: number;
}

export interface CreateRoomConfig {
  name: string;
  maxPlayers: number;
  totalRounds: number;
}

export interface LobbyCallbacks {
  onHotseat: (r: LobbyResult) => void;
  onCreateRoom: (cfg: CreateRoomConfig) => void;
  onJoinRoom: (code: string, name: string) => void;
}

const DEFAULT_NAMES = ['あかり', 'はると', 'つむぎ', 'ゆうと', 'さくら', 'そうた'];
const ROUND_CHOICES = [1, 2, 3, 4, 6, 8, 12, 20];
type Mode = 'hotseat' | 'create' | 'join';

export function renderLobby(root: HTMLElement, cb: LobbyCallbacks): void {
  clear(root);
  let mode: Mode = 'create';

  const modeSeg = el('div', { class: 'seg' });
  const body = el('div', {});
  const modeBtns: Record<Mode, HTMLButtonElement> = {} as Record<Mode, HTMLButtonElement>;
  const modes: { key: Mode; label: string }[] = [
    { key: 'create', label: 'ルーム作成' },
    { key: 'join', label: 'ルーム参加' },
    { key: 'hotseat', label: 'ホットシート' },
  ];
  for (const m of modes) {
    const b = el('button', { text: m.label }) as HTMLButtonElement;
    b.onclick = () => {
      mode = m.key;
      for (const k of modes) modeBtns[k.key].classList.toggle('on', k.key === mode);
      renderBody();
    };
    modeBtns[m.key] = b;
    modeSeg.append(b);
  }

  const renderBody = (): void => {
    clear(body);
    if (mode === 'hotseat') body.append(hotseatForm(cb));
    else if (mode === 'create') body.append(createForm(cb));
    else body.append(joinForm(cb));
  };

  const modal = el('div', { class: 'modal' }, [
    el('h1', { text: 'セブンブリッジ 3D' }),
    el('h2', { text: '友だちとルームコードで卓を囲む通信対戦（2〜6人）' }),
    el('div', { class: 'row' }, [el('label', { text: 'モード' }), modeSeg]),
    body,
  ]);
  modeBtns[mode].classList.add('on');
  renderBody();
  root.append(el('div', { class: 'center' }, [modal]));
}

// ---- 通信対戦: ルーム作成 -------------------------------------------------

function createForm(cb: LobbyCallbacks): HTMLElement {
  let maxPlayers = 4;
  let rounds = 4;
  const nameInput = textInput(DEFAULT_NAMES[0]!, 'あなたの名前');

  const countSeg = segSelect(
    Array.from({ length: 5 }, (_, i) => i + 2),
    maxPlayers,
    (n) => (maxPlayers = n),
    (n) => `${n}人`,
  );
  const roundSeg = segSelect(ROUND_CHOICES, rounds, (r) => (rounds = r), String);

  const startBtn = el('button', { class: 'primary', text: 'ルームを作成して待機' }) as HTMLButtonElement;
  startBtn.onclick = () =>
    cb.onCreateRoom({ name: cleanName(nameInput.value, 'ホスト'), maxPlayers, totalRounds: rounds });

  return el('div', {}, [
    el('div', { class: 'row' }, [el('label', { text: 'あなたの名前' }), nameInput]),
    el('div', { class: 'row' }, [el('label', { text: '人数上限' }), countSeg]),
    el('div', { class: 'row' }, [el('label', { text: 'ラウンド数' }), roundSeg]),
    el('div', { class: 'row' }, [startBtn]),
    el('p', { class: 'hint', text: '作成後、6桁のルームコードを友だちに共有してください。' }),
  ]);
}

// ---- 通信対戦: ルーム参加 -------------------------------------------------

function joinForm(cb: LobbyCallbacks): HTMLElement {
  const nameInput = textInput(DEFAULT_NAMES[1]!, 'あなたの名前');
  const codeInput = el('input', {
    type: 'text',
    maxlength: '7',
    placeholder: 'ABC123',
    autocapitalize: 'characters',
  }) as HTMLInputElement;
  codeInput.style.width = '140px';
  codeInput.style.letterSpacing = '3px';
  codeInput.style.textTransform = 'uppercase';
  codeInput.oninput = () => {
    codeInput.value = normalizeRoomCode(codeInput.value);
  };

  const joinBtn = el('button', { class: 'primary', text: '参加' }) as HTMLButtonElement;
  const err = el('p', { class: 'hint' });
  joinBtn.onclick = () => {
    const code = normalizeRoomCode(codeInput.value);
    if (code.length !== 6) {
      err.textContent = 'ルームコードは英数6桁です。';
      return;
    }
    cb.onJoinRoom(code, cleanName(nameInput.value, 'ゲスト'));
  };

  return el('div', {}, [
    el('div', { class: 'row' }, [el('label', { text: 'あなたの名前' }), nameInput]),
    el('div', { class: 'row' }, [el('label', { text: 'ルームコード' }), codeInput]),
    el('div', { class: 'row' }, [joinBtn]),
    err,
  ]);
}

// ---- ホットシート（従来） -------------------------------------------------

function hotseatForm(cb: LobbyCallbacks): HTMLElement {
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
      const input = textInput(DEFAULT_NAMES[i] ?? `席${i + 1}`);
      input.style.width = '96px';
      nameInputs.push(input);
      list.append(input);
    }
    namesWrap.append(list);
  };

  const countSeg = segSelect(
    Array.from({ length: 5 }, (_, i) => i + 2),
    count,
    (n) => {
      count = n;
      rebuildNames();
    },
    (n) => `${n}人`,
  );
  const roundSeg = segSelect(ROUND_CHOICES, rounds, (r) => (rounds = r), String);

  const startBtn = el('button', { class: 'primary', text: '対局開始（ホットシート）' }) as HTMLButtonElement;
  startBtn.onclick = () => {
    const players = nameInputs.map((inp, i) => ({ id: `p${i}`, name: cleanName(inp.value, `席${i + 1}`) }));
    cb.onHotseat({ players, totalRounds: rounds });
  };

  rebuildNames();
  return el('div', {}, [
    el('div', { class: 'row' }, [el('label', { text: '人数' }), countSeg]),
    el('div', { class: 'row' }, [el('label', { text: 'ラウンド数' }), roundSeg]),
    namesWrap,
    el('div', { class: 'row' }, [startBtn]),
    el('p', { class: 'hint', text: '1台で全員を順に操作します（デバッグ/オフライン用）。' }),
  ]);
}

// ---- 共通 -----------------------------------------------------------------

function textInput(value: string, placeholder = ''): HTMLInputElement {
  const input = el('input', { type: 'text', maxlength: '10', value, placeholder }) as HTMLInputElement;
  input.style.width = '110px';
  return input;
}

function cleanName(raw: string, fallback: string): string {
  return (raw.trim() || fallback).slice(0, 10);
}

function segSelect<T extends number>(
  values: T[],
  initial: T,
  onPick: (v: T) => void,
  label: (v: T) => string,
): HTMLElement {
  const seg = el('div', { class: 'seg' });
  const btns: HTMLButtonElement[] = [];
  values.forEach((v) => {
    const b = el('button', { text: label(v) }) as HTMLButtonElement;
    if (v === initial) b.classList.add('on');
    b.onclick = () => {
      onPick(v);
      btns.forEach((x, i) => x.classList.toggle('on', values[i] === v));
    };
    btns.push(b);
    seg.append(b);
  });
  return seg;
}
