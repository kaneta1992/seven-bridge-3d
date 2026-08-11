// タイトル/ロビー画面（要件 §3.3-1）。3導線: ホットシート / ルーム作成（通信対戦）/ ルーム参加。
// モダンなカードUI + タブ + ブランドマーク（すべてシステムフォント/プロシージャル・外部アセットなし）。
// 名前・人数・ラウンド数は localStorage に永続化し、次回起動時に自動復元する（項目6/7）。
import { pickNpcName } from '../driver/botPlayer';
import { normalizeRoomCode, SEAT_CAP, type RoomAd } from '../net/protocol';
import { relayStatus } from '../net/trysteroTransport';
import { clear, el } from './dom';
import { loadPrefs, savePrefs } from './settings';

export interface LobbyResult {
  players: { id: string; name: string }[];
  totalRounds: number;
  /** 1人プレイの固定自席 id（人間席）。未指定はホットシート。 */
  selfId?: string;
  /** NPC が担当する席 id（1人プレイ）。 */
  npcIds?: string[];
}

export interface CreateRoomConfig {
  name: string;
  totalRounds: number;
  isPublic: boolean;
}

export interface LobbyCallbacks {
  onHotseat: (r: LobbyResult) => void;
  /** 1人プレイ（人間1+NPC n）で開始（契約16）。 */
  onSolo: (r: LobbyResult) => void;
  onCreateRoom: (cfg: CreateRoomConfig) => void;
  onJoinRoom: (code: string, name: string) => void;
  /** 公開ルーム一覧の購読（未提供なら公開タブは空表示・E4）。戻り値は解除関数。 */
  watchPublicRooms?: (cb: (rooms: RoomAd[]) => void) => () => void;
}

const DEFAULT_NAMES = ['あかり', 'はると', 'つむぎ', 'ゆうと', 'さくら', 'そうた'];
const ROUND_CHOICES = [1, 2, 3, 4, 6, 8, 12, 20];
type Mode = 'solo' | 'hotseat' | 'create' | 'join' | 'public';

// 画面内で共有する設定状態（名前はモード切替をまたいで引き継ぎ、submit で永続化する）。
interface LobbyState {
  name: string;
  rounds: number;
  hotseatCount: number;
  isPublic: boolean;
}

export function renderLobby(root: HTMLElement, cb: LobbyCallbacks): void {
  clear(root);
  const prefs = loadPrefs();
  const state: LobbyState = {
    name: prefs.name,
    rounds: ROUND_CHOICES.includes(prefs.rounds) ? prefs.rounds : 4,
    hotseatCount: prefs.hotseatCount,
    isPublic: false,
  };
  let mode: Mode = 'create';
  // 公開タブを離れたら一覧購読を解除する（対局中にロビー接続を残さない・E11追補）。
  let unwatch: (() => void) | null = null;

  const modeSeg = el('div', { class: 'seg tabs' });
  const body = el('div', { class: 'lobby-body' });
  const modeBtns: Record<Mode, HTMLButtonElement> = {} as Record<Mode, HTMLButtonElement>;
  const modes: { key: Mode; label: string }[] = [
    { key: 'create', label: 'ルーム作成' },
    { key: 'public', label: '公開ルーム' },
    { key: 'join', label: 'コードで参加' },
    { key: 'solo', label: '1人プレイ' },
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
    unwatch?.();
    unwatch = null;
    clear(body);
    if (mode === 'solo') body.append(soloForm(cb, state));
    else if (mode === 'hotseat') body.append(hotseatForm(cb, state));
    else if (mode === 'create') body.append(createForm(cb, state));
    else if (mode === 'public') unwatch = publicList(body, cb, state);
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

  const roundSeg = segSelect(ROUND_CHOICES, state.rounds, (r) => (state.rounds = r), String);
  const publicToggle = toggle(state.isPublic, (v) => (state.isPublic = v));

  const startBtn = el('button', { class: 'primary', text: 'ルームを作成して待機' }) as HTMLButtonElement;
  startBtn.onclick = () => {
    const name = cleanName(state.name, 'ホスト');
    savePrefs({ name, rounds: state.rounds });
    cb.onCreateRoom({ name, totalRounds: state.rounds, isPublic: state.isPublic });
  };

  // 人数はゲーム開始時に確定（要件§3.1）。作成UIから人数指定は撤去し、席上限 SEAT_CAP のみ内部で持つ。
  return el('div', {}, [
    field('あなたの名前', nameInput),
    field('ラウンド数', roundSeg),
    field('公開ルームにする', publicToggle),
    el('div', { class: 'row actions-row' }, [startBtn]),
    el('p', {
      class: 'hint',
      text: `開始時の参加者数で対局人数が決まります（2〜${SEAT_CAP}人）。公開ONで一覧に載り、コード不要で参加できます。`,
    }),
  ]);
}

// ---- 公開ルーム一覧（ワンタップ参加） ------------------------------------

function publicList(body: HTMLElement, cb: LobbyCallbacks, state: LobbyState): () => void {
  const nameInput = nameField(state);
  const listWrap = el('div', { class: 'melds public-rooms' });
  const empty = el('p', { class: 'hint', text: '公開ルームを探しています…' });

  const render = (rooms: RoomAd[]): void => {
    clear(listWrap);
    if (rooms.length === 0) {
      listWrap.append(empty);
      return;
    }
    for (const r of rooms) {
      const full = r.count >= SEAT_CAP;
      const join = el('button', { class: 'primary', text: full ? '満員' : '参加' }) as HTMLButtonElement;
      join.disabled = full;
      join.onclick = () => {
        const name = cleanName(state.name, 'ゲスト');
        savePrefs({ name });
        cb.onJoinRoom(r.code, name);
      };
      listWrap.append(
        el('div', { class: 'meld public-room' }, [
          el('span', { class: 'owner', text: `${r.hostName}さんの卓` }),
          el('span', { class: 'pill', text: `${r.count}/${SEAT_CAP}人` }),
          el('span', { class: 'pill', text: `${r.rounds}R` }),
          join,
        ]),
      );
    }
  };

  // 診断行（2026-08-11）: ビルドIDとリレー接続数。遠隔サポート時に
  // 「古いキャッシュか」「ネットワークがリレーをブロックしているか」を一目で切り分ける。
  const diag = el('p', { class: 'hint diag', text: '' });
  let diagTimer = 0;
  const paintDiag = (): void => {
    // 診断行が DOM から外れていたら自己解放する（cleanup を呼ばない画面遷移でのリーク防止・項目12）。
    if (diagTimer && !diag.isConnected) {
      window.clearInterval(diagTimer);
      diagTimer = 0;
      return;
    }
    const rs = relayStatus();
    const warn = rs.connected === 0 ? ' ⚠ リレーに接続できていません（ネットワーク制限の可能性）' : '';
    diag.textContent = `接続リレー ${rs.connected}/${rs.total} ・ build ${__BUILD_ID__}${warn}`;
  };
  paintDiag();
  diagTimer = window.setInterval(paintDiag, 2000);

  const wrap = el('div', {}, [
    field('あなたの名前', nameInput),
    el('h2', { text: '公開中のルーム' }),
    listWrap,
    diag,
  ]);
  body.append(wrap);
  render([]);
  // E4: 購読が無い（ロビーチャネル未接続）なら空表示のまま。
  const unwatch = cb.watchPublicRooms ? cb.watchPublicRooms(render) : (): void => {};
  return () => {
    window.clearInterval(diagTimer);
    unwatch();
  };
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

// ---- 1人プレイ（人間1+NPC n・契約16） -----------------------------------

function soloForm(cb: LobbyCallbacks, state: LobbyState): HTMLElement {
  const nameInput = nameField(state);
  let npcCount = 2; // 既定: 自分1+NPC2
  const namesPreview = el('div', { class: 'seg names' });
  const renderPreview = (): void => {
    clear(namesPreview);
    const taken = new Set<string>();
    for (let i = 0; i < npcCount; i++) {
      const nm = pickNpcName(taken);
      taken.add(nm);
      namesPreview.append(el('span', { class: 'pill', text: nm }));
    }
  };

  const countSeg = segSelect(
    [1, 2, 3, 4, 5],
    npcCount,
    (n) => {
      npcCount = n;
      renderPreview();
    },
    (n) => `${n}体`,
  );
  const roundSeg = segSelect(ROUND_CHOICES, state.rounds, (r) => (state.rounds = r), String);

  const startBtn = el('button', { class: 'primary', text: '1人で対局開始' }) as HTMLButtonElement;
  startBtn.onclick = () => {
    const human = cleanName(state.name, DEFAULT_NAMES[0]!);
    savePrefs({ name: human, rounds: state.rounds });
    const players = [{ id: 'you', name: human }];
    const npcIds: string[] = [];
    const taken = new Set<string>([human]);
    for (let i = 0; i < npcCount; i++) {
      const nm = pickNpcName(taken);
      taken.add(nm);
      players.push({ id: `npc${i}`, name: nm });
      npcIds.push(`npc${i}`);
    }
    cb.onSolo({ players, totalRounds: state.rounds, selfId: 'you', npcIds });
  };

  renderPreview();
  return el('div', {}, [
    field('あなたの名前', nameInput),
    field('NPCの人数', countSeg),
    field('ラウンド数', roundSeg),
    field('対戦相手（NPC）', namesPreview),
    el('div', { class: 'row actions-row' }, [startBtn]),
    el('p', {
      class: 'hint',
      text: 'NPC が自動で打ちます。あなたの手番だけ視点が自席に固定され、NPC の手札は伏せられます。',
    }),
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

/** ON/OFF トグル（公開ルーム設定用。seg と同じ見た目のピル2択で実装＝新規CSS不要）。 */
function toggle(initial: boolean, onChange: (v: boolean) => void): HTMLElement {
  const seg = el('div', { class: 'seg' });
  const off = el('button', { text: 'しない' }) as HTMLButtonElement;
  const on = el('button', { text: '公開する' }) as HTMLButtonElement;
  const paint = (v: boolean): void => {
    on.classList.toggle('on', v);
    off.classList.toggle('on', !v);
  };
  off.onclick = () => {
    onChange(false);
    paint(false);
  };
  on.onclick = () => {
    onChange(true);
    paint(true);
  };
  paint(initial);
  seg.append(off, on);
  return seg;
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
