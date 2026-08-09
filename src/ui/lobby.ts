// タイトル/ロビー画面（要件 §3.3-1）。3導線: ホットシート / ルーム作成（通信対戦）/ ルーム参加。
// モダンなカードUI + タブ + ブランドマーク（すべてシステムフォント/プロシージャル・外部アセットなし）。
// 名前・人数・ラウンド数は localStorage に永続化し、次回起動時に自動復元する（項目6/7）。
import { normalizeRoomCode } from '../net/protocol';
import { clear, el } from './dom';
import { loadPrefs, savePrefs } from './settings';

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

// 画面内で共有する設定状態（名前はモード切替をまたいで引き継ぎ、submit で永続化する）。
interface LobbyState {
  name: string;
  maxPlayers: number;
  rounds: number;
  hotseatCount: number;
}

export function renderLobby(root: HTMLElement, cb: LobbyCallbacks): void {
  clear(root);
  const prefs = loadPrefs();
  const state: LobbyState = {
    name: prefs.name,
    maxPlayers: prefs.maxPlayers,
    rounds: ROUND_CHOICES.includes(prefs.rounds) ? prefs.rounds : 4,
    hotseatCount: prefs.hotseatCount,
  };
  let mode: Mode = 'create';

  const modeSeg = el('div', { class: 'seg tabs' });
  const body = el('div', { class: 'lobby-body' });
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
    if (mode === 'hotseat') body.append(hotseatForm(cb, state));
    else if (mode === 'create') body.append(createForm(cb, state));
    else body.append(joinForm(cb, state));
  };

  const brand = el('div', { class: 'lobby-brand' }, [
    el('div', { class: 'lobby-mark' }, [
      el('span', { class: 'pip s', text: '♠' }),
      el('span', { class: 'pip h', text: '♥' }),
    ]),
    el('div', { class: 'lobby-title' }, [
      el('h1', { text: 'セブンブリッジ 3D' }),
      el('p', { class: 'lobby-sub', text: '友だちとルームコードで卓を囲む通信対戦（2〜6人）' }),
    ]),
  ]);

  const modal = el('div', { class: 'modal lobby' }, [brand, modeSeg, body]);
  modeBtns[mode].classList.add('on');
  renderBody();
  root.append(el('div', { class: 'center lobby-center' }, [modal]));
}

// ---- 通信対戦: ルーム作成 -------------------------------------------------

function createForm(cb: LobbyCallbacks, state: LobbyState): HTMLElement {
  const nameInput = nameField(state);

  const countSeg = segSelect(
    Array.from({ length: 5 }, (_, i) => i + 2),
    state.maxPlayers,
    (n) => (state.maxPlayers = n),
    (n) => `${n}人`,
  );
  const roundSeg = segSelect(ROUND_CHOICES, state.rounds, (r) => (state.rounds = r), String);

  const startBtn = el('button', { class: 'primary', text: 'ルームを作成して待機' }) as HTMLButtonElement;
  startBtn.onclick = () => {
    const name = cleanName(state.name, 'ホスト');
    savePrefs({ name, maxPlayers: state.maxPlayers, rounds: state.rounds });
    cb.onCreateRoom({ name, maxPlayers: state.maxPlayers, totalRounds: state.rounds });
  };

  return el('div', {}, [
    field('あなたの名前', nameInput),
    field('人数上限', countSeg),
    field('ラウンド数', roundSeg),
    el('div', { class: 'row actions-row' }, [startBtn]),
    el('p', { class: 'hint', text: '作成後、6桁のルームコードを友だちに共有してください。' }),
  ]);
}

// ---- 通信対戦: ルーム参加 -------------------------------------------------

function joinForm(cb: LobbyCallbacks, state: LobbyState): HTMLElement {
  const nameInput = nameField(state);
  const codeInput = el('input', {
    type: 'text',
    maxlength: '7',
    placeholder: 'ABC123',
    autocapitalize: 'characters',
    class: 'code-input',
  }) as HTMLInputElement;
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
    const name = cleanName(state.name, 'ゲスト');
    savePrefs({ name });
    cb.onJoinRoom(code, name);
  };

  return el('div', {}, [
    field('あなたの名前', nameInput),
    field('ルームコード', codeInput),
    el('div', { class: 'row actions-row' }, [joinBtn]),
    err,
  ]);
}

// ---- ホットシート（従来） -------------------------------------------------

function hotseatForm(cb: LobbyCallbacks, state: LobbyState): HTMLElement {
  let count = state.hotseatCount;
  const nameInputs: HTMLInputElement[] = [];
  const namesWrap = el('div', {});

  const rebuildNames = (): void => {
    clear(namesWrap);
    nameInputs.length = 0;
    const list = el('div', { class: 'seg names' });
    for (let i = 0; i < count; i++) {
      const input = textInput(DEFAULT_NAMES[i] ?? `席${i + 1}`);
      input.classList.add('name-slot');
      nameInputs.push(input);
      list.append(input);
    }
    namesWrap.append(field('プレイヤー名', list));
  };

  const countSeg = segSelect(
    Array.from({ length: 5 }, (_, i) => i + 2),
    count,
    (n) => {
      count = n;
      state.hotseatCount = n;
      rebuildNames();
    },
    (n) => `${n}人`,
  );
  const roundSeg = segSelect(ROUND_CHOICES, state.rounds, (r) => (state.rounds = r), String);

  const startBtn = el('button', { class: 'primary', text: '対局開始（ホットシート）' }) as HTMLButtonElement;
  startBtn.onclick = () => {
    const players = nameInputs.map((inp, i) => ({ id: `p${i}`, name: cleanName(inp.value, `席${i + 1}`) }));
    savePrefs({ hotseatCount: count, rounds: state.rounds });
    cb.onHotseat({ players, totalRounds: state.rounds });
  };

  rebuildNames();
  return el('div', {}, [
    field('人数', countSeg),
    field('ラウンド数', roundSeg),
    namesWrap,
    el('div', { class: 'row actions-row' }, [startBtn]),
    el('p', { class: 'hint', text: '1台で全員を順に操作します（デバッグ/オフライン用）。' }),
  ]);
}

// ---- 共通 -----------------------------------------------------------------

/** ラベル + コントロールの1行（モダンな縦積みフィールド）。 */
function field(label: string, control: HTMLElement): HTMLElement {
  return el('div', { class: 'field' }, [el('label', { text: label }), control]);
}

/** 名前入力（共有 state に同期し、モード切替をまたいで名前を引き継ぐ）。 */
function nameField(state: LobbyState): HTMLInputElement {
  const input = textInput(state.name || DEFAULT_NAMES[0]!, 'あなたの名前');
  state.name = input.value;
  input.oninput = () => {
    state.name = input.value;
  };
  return input;
}

function textInput(value: string, placeholder = ''): HTMLInputElement {
  return el('input', { type: 'text', maxlength: '10', value, placeholder }) as HTMLInputElement;
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
