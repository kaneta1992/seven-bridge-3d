// セブンブリッジ ルールエンジン: 決定的な (state, action) => 結果 の遷移。
// DOM / Three.js / 通信ライブラリに一切依存しない純粋TS。
import type { Card } from './cards';
import { handScore, orderedDeck, sameCard } from './cards';
import type { Meld } from './melds';
import { attachResult, canAttach, canPublish, isValidGroup, isValidSequence } from './melds';
import { shuffle } from './rng';

export type Phase =
  | 'awaitingStart' // ゲーム作成直後 / 各ラウンド開始待ち
  | 'awaitingDraw' // 手番プレイヤーのツモ待ち
  | 'awaitingDiscard' // ツモ後・鳴き後: メルド/付け札の後に捨て札
  | 'meldWindow' // 捨て札直後の鳴き受付ウィンドウ
  | 'roundOver' // ラウンド確定（次ラウンド開始待ち）
  | 'gameOver'; // 全ラウンド消化

export interface Player {
  readonly id: string;
  readonly name: string;
  hand: Card[];
}

/** 鳴き受付ウィンドウの内部状態（タイマー自体はエンジン外＝ホストの責務）。 */
export interface MeldWindow {
  discarder: number; // 捨てたプレイヤーの席index
  card: Card; // 捨て札
  passed: string[]; // パス済みプレイヤーID
}

export interface GameState {
  players: Player[]; // 席順（時計回り＝index昇順）
  dealerIndex: number;
  currentPlayerIndex: number;
  phase: Phase;
  deck: Card[]; // 山札（top = 末尾）
  discardPile: Card[]; // 捨て札の場（top = 末尾）
  melds: Meld[];
  meldCounter: number;
  round: number; // 1始まり。0 は未開始
  totalRounds: number;
  scores: number[][]; // scores[roundIndex][playerIndex] = そのラウンドの失点
  rng: number; // シード付きRNG状態
  claimWindow: MeldWindow | null;
  lastWinner: string | null; // 直近ラウンドの上がり者（流局は null）
  finished: boolean;
  finalWinners: string[]; // gameOver 時の勝者（同点は同着）
}

export type Claim = { playerIndex: number; kind: 'pon' | 'chi' };

export type Action =
  | { type: 'startRound' }
  | { type: 'draw'; player: string }
  | { type: 'publishMeld'; player: string; cards: Card[]; meldKind: 'sequence' | 'group' | 'lone7' }
  | { type: 'attach'; player: string; meldId: number; card: Card }
  | { type: 'discard'; player: string; card: Card }
  | { type: 'pon'; player: string; cards: [Card, Card] }
  | { type: 'chi'; player: string; cards: [Card, Card] }
  | { type: 'pass'; player: string }
  | { type: 'closeWindow' }; // ホストのタイムアウト等でウィンドウを閉じる（全員パス相当）

export type ActionResult = { ok: true; state: GameState } | { ok: false; error: string };

export interface CreateGameConfig {
  players: { id: string; name: string }[];
  totalRounds?: number; // 1〜20（デフォルト4）
  seed?: number;
}

const HAND_SIZE = 7;

export function createGame(config: CreateGameConfig): GameState {
  const n = config.players.length;
  if (n < 2 || n > 6) throw new Error('players must be 2..6');
  const totalRounds = config.totalRounds ?? 4;
  if (totalRounds < 1 || totalRounds > 20) throw new Error('totalRounds must be 1..20');
  const ids = new Set(config.players.map((p) => p.id));
  if (ids.size !== n) throw new Error('player ids must be unique');

  return {
    players: config.players.map((p) => ({ id: p.id, name: p.name, hand: [] })),
    dealerIndex: 0,
    currentPlayerIndex: 0,
    phase: 'awaitingStart',
    deck: [],
    discardPile: [],
    melds: [],
    meldCounter: 0,
    round: 0,
    totalRounds,
    scores: [],
    rng: config.seed ?? 1,
    claimWindow: null,
    lastWinner: null,
    finished: false,
    finalWinners: [],
  };
}

// ---- 参照系（純粋・stateを変更しない） ----------------------------------

/** チーで捨て札 card を取れる手札の組が存在するか（同スート連続2枚）。 */
function canChi(hand: readonly Card[], card: Card): boolean {
  const sameSuit = hand.filter((c) => c.suit === card.suit);
  for (let i = 0; i < sameSuit.length; i++) {
    for (let j = i + 1; j < sameSuit.length; j++) {
      if (isValidSequence([card, sameSuit[i]!, sameSuit[j]!])) return true;
    }
  }
  return false;
}

/**
 * 鳴き受付ウィンドウで誰が鳴き得るかを優先順位順に列挙する。
 * ポン優先・複数ポンは捨てた人から時計回りで近い順。チーは上家(次席)のみ。
 * タイマーはエンジン外。ホストはこの列挙で「鳴ける可能性のある全員」を知る。
 */
export function eligibleClaims(state: GameState): Claim[] {
  if (state.phase !== 'meldWindow' || !state.claimWindow) return [];
  const { discarder, card } = state.claimWindow;
  const n = state.players.length;
  const entries: { playerIndex: number; kind: 'pon' | 'chi'; dist: number }[] = [];

  for (let off = 1; off < n; off++) {
    const idx = (discarder + off) % n;
    const hand = state.players[idx]!.hand;
    if (hand.filter((c) => c.rank === card.rank).length >= 2) {
      entries.push({ playerIndex: idx, kind: 'pon', dist: off });
    }
  }
  // チーは上家（=捨てた人の次席）のみ
  const chiIdx = (discarder + 1) % n;
  if (canChi(state.players[chiIdx]!.hand, card)) {
    entries.push({ playerIndex: chiIdx, kind: 'chi', dist: 1 });
  }

  entries.sort((a, b) => (a.kind === b.kind ? a.dist - b.dist : a.kind === 'pon' ? -1 : 1));
  return entries.map(({ playerIndex, kind }) => ({ playerIndex, kind }));
}

/** 鳴き可能者全員がパス済みか（＝ウィンドウ即終了の判定）。 */
export function isWindowClosed(state: GameState): boolean {
  if (state.phase !== 'meldWindow' || !state.claimWindow) return true;
  const indices = new Set(eligibleClaims(state).map((c) => c.playerIndex));
  for (const i of indices) {
    if (!state.claimWindow.passed.includes(state.players[i]!.id)) return false;
  }
  return true;
}

// ---- ビュー（視界フィルタ） ---------------------------------------------

export interface PlayerViewSeat {
  id: string;
  name: string;
  index: number;
  handCount: number; // 他家は枚数のみ
  isYou: boolean;
  isDealer: boolean;
  isCurrent: boolean;
}

export interface PlayerView {
  youIndex: number;
  hand: Card[]; // 自分の手札のみ実カード
  seats: PlayerViewSeat[];
  melds: Meld[];
  discardPile: Card[];
  discardTop: Card | null;
  deckCount: number;
  phase: Phase;
  round: number;
  totalRounds: number;
  scores: number[][];
  lastWinner: string | null;
  finished: boolean;
  finalWinners: string[];
  claimWindow: { discarder: number; card: Card } | null;
  yourClaims: ('pon' | 'chi')[]; // 自分が鳴き得る種類のみ（他家の鳴き可否は漏らさない）
}

/**
 * 視界フィルタ: 指定プレイヤー視点のビューを返す。
 * 自分の手札＋公開情報（場のメルド・捨て札・他家手札枚数・山札残数）のみ。
 * 他家の実手札は含めない（要件 §3.1）。
 */
export function deriveViewFor(state: GameState, playerId: string): PlayerView {
  const youIndex = state.players.findIndex((p) => p.id === playerId);
  const seats: PlayerViewSeat[] = state.players.map((p, i) => ({
    id: p.id,
    name: p.name,
    index: i,
    handCount: p.hand.length,
    isYou: i === youIndex,
    isDealer: i === state.dealerIndex,
    isCurrent: i === state.currentPlayerIndex,
  }));
  const yourClaims = eligibleClaims(state)
    .filter((c) => c.playerIndex === youIndex)
    .map((c) => c.kind);

  return {
    youIndex,
    hand: youIndex >= 0 ? state.players[youIndex]!.hand.map((c) => ({ ...c })) : [],
    seats,
    melds: state.melds.map((m) => ({ ...m, cards: m.cards.map((c) => ({ ...c })) })),
    discardPile: state.discardPile.map((c) => ({ ...c })),
    discardTop: state.discardPile.length ? { ...state.discardPile[state.discardPile.length - 1]! } : null,
    deckCount: state.deck.length,
    phase: state.phase,
    round: state.round,
    totalRounds: state.totalRounds,
    scores: state.scores.map((row) => [...row]),
    lastWinner: state.lastWinner,
    finished: state.finished,
    finalWinners: [...state.finalWinners],
    claimWindow: state.claimWindow ? { discarder: state.claimWindow.discarder, card: { ...state.claimWindow.card } } : null,
    yourClaims,
  };
}

// ---- 内部ヘルパ（cloneした state を破壊的に更新する） --------------------

export function computeTotals(state: GameState): number[] {
  const totals = new Array<number>(state.players.length).fill(0);
  for (const row of state.scores) {
    for (let i = 0; i < row.length; i++) totals[i]! += row[i]!;
  }
  return totals;
}

function computeWinners(state: GameState): string[] {
  const totals = computeTotals(state);
  const min = Math.min(...totals);
  return state.players.filter((_, i) => totals[i] === min).map((p) => p.id);
}

/** ラウンド確定: 失点を計上し、全ラウンド消化なら gameOver、そうでなければ roundOver。 */
function endRound(state: GameState, winnerIndex: number | null): void {
  const row = state.players.map((p, i) => (i === winnerIndex ? 0 : handScore(p.hand)));
  state.scores.push(row);
  state.lastWinner = winnerIndex === null ? null : state.players[winnerIndex]!.id;
  state.claimWindow = null;
  if (state.round >= state.totalRounds) {
    state.phase = 'gameOver';
    state.finished = true;
    state.finalWinners = computeWinners(state);
  } else {
    state.phase = 'roundOver';
  }
}

/** 次の手番を開始。山札が尽きていれば流局（全員手札失点）。 */
function beginTurn(state: GameState, index: number): void {
  state.currentPlayerIndex = index;
  state.claimWindow = null;
  if (state.deck.length === 0) {
    endRound(state, null); // 流局
  } else {
    state.phase = 'awaitingDraw';
  }
}

/** 手札を出し切ったら上がり確定にして true を返す。 */
function checkWin(state: GameState, index: number): boolean {
  if (state.players[index]!.hand.length === 0) {
    endRound(state, index);
    return true;
  }
  return false;
}

function removeFromHand(player: Player, card: Card): boolean {
  const i = player.hand.findIndex((c) => sameCard(c, card));
  if (i < 0) return false;
  player.hand.splice(i, 1);
  return true;
}

function hasAllInHand(player: Player, cards: readonly Card[]): boolean {
  const pool = player.hand.map((c) => `${c.suit}${c.rank}`);
  for (const c of cards) {
    const idx = pool.indexOf(`${c.suit}${c.rank}`);
    if (idx < 0) return false;
    pool.splice(idx, 1);
  }
  return true;
}

// ---- リデューサ本体 ------------------------------------------------------

const fail = (error: string): ActionResult => ({ ok: false, error });

export function applyAction(prev: GameState, action: Action): ActionResult {
  const state = structuredClone(prev);
  const n = state.players.length;

  const playerIndexOf = (id: string): number => state.players.findIndex((p) => p.id === id);

  switch (action.type) {
    case 'startRound': {
      if (state.phase !== 'awaitingStart' && state.phase !== 'roundOver') {
        return fail('startRound: not in a startable phase');
      }
      if (state.round >= state.totalRounds) return fail('startRound: all rounds finished');

      state.round += 1;
      // 親の決定: 初回はルーム順先頭。以降は直前ラウンドの勝者が親。流局(lastWinner=null)は親継続。
      if (state.round === 1) {
        state.dealerIndex = 0;
      } else if (state.lastWinner !== null) {
        const w = playerIndexOf(state.lastWinner);
        if (w >= 0) state.dealerIndex = w;
      }
      const { result, seed } = shuffle(orderedDeck(), state.rng);
      state.rng = seed;
      for (let i = 0; i < n; i++) {
        state.players[i]!.hand = result.slice(i * HAND_SIZE, i * HAND_SIZE + HAND_SIZE);
      }
      // 捨て札の場は空で開始（2026-08-10 ユーザー指定: 開始時のめくり札を廃止）
      state.discardPile = [];
      state.deck = result.slice(n * HAND_SIZE);
      state.melds = [];
      state.meldCounter = 0;
      state.claimWindow = null;
      state.currentPlayerIndex = (state.dealerIndex + 1) % n; // 最初のツモはディーラーの左隣
      state.phase = 'awaitingDraw';
      return { ok: true, state };
    }

    case 'draw': {
      if (state.phase !== 'awaitingDraw') return fail('draw: not awaiting draw');
      if (playerIndexOf(action.player) !== state.currentPlayerIndex) return fail('draw: not your turn');
      const card = state.deck.pop();
      if (!card) return fail('draw: deck empty');
      state.players[state.currentPlayerIndex]!.hand.push(card);
      state.phase = 'awaitingDiscard';
      return { ok: true, state };
    }

    case 'publishMeld': {
      if (state.phase !== 'awaitingDiscard') return fail('publishMeld: not in discard phase');
      const pi = playerIndexOf(action.player);
      if (pi !== state.currentPlayerIndex) return fail('publishMeld: not your turn');
      const player = state.players[pi]!;
      if (action.cards.length === 0) return fail('publishMeld: no cards');
      if (!hasAllInHand(player, action.cards)) return fail('publishMeld: cards not in hand');
      if (!canPublish(action.cards, action.meldKind)) return fail('publishMeld: invalid meld');

      for (const c of action.cards) removeFromHand(player, c);
      state.melds.push({
        id: state.meldCounter++,
        owner: player.id,
        kind: action.meldKind,
        cards: action.cards.map((c) => ({ ...c })),
      });
      checkWin(state, pi); // メルドで出し切る上がり
      return { ok: true, state };
    }

    case 'attach': {
      if (state.phase !== 'awaitingDiscard') return fail('attach: not in discard phase');
      const pi = playerIndexOf(action.player);
      if (pi !== state.currentPlayerIndex) return fail('attach: not your turn');
      const player = state.players[pi]!;
      // 付け札は自分がメルドを1つ以上公開済みでなければ不可（鳴きで公開したものも可）
      if (!state.melds.some((m) => m.owner === player.id)) {
        return fail('attach: you have not published any meld');
      }
      const meld = state.melds.find((m) => m.id === action.meldId);
      if (!meld) return fail('attach: meld not found');
      if (!hasAllInHand(player, [action.card])) return fail('attach: card not in hand');
      if (!canAttach(meld, action.card)) return fail('attach: invalid attachment');

      const updated = attachResult(meld, action.card);
      const mi = state.melds.findIndex((m) => m.id === meld.id);
      state.melds[mi] = updated;
      removeFromHand(player, action.card);
      checkWin(state, pi); // 付け札で出し切る上がり
      return { ok: true, state };
    }

    case 'discard': {
      if (state.phase !== 'awaitingDiscard') return fail('discard: not in discard phase');
      const pi = playerIndexOf(action.player);
      if (pi !== state.currentPlayerIndex) return fail('discard: not your turn');
      const player = state.players[pi]!;
      if (!hasAllInHand(player, [action.card])) return fail('discard: card not in hand');

      removeFromHand(player, action.card);
      state.discardPile.push({ ...action.card });

      if (checkWin(state, pi)) return { ok: true, state }; // 最後の1枚を捨てて上がり

      // 鳴き受付ウィンドウを開く
      state.claimWindow = { discarder: pi, card: { ...action.card }, passed: [] };
      state.phase = 'meldWindow';
      if (eligibleClaims(state).length === 0) {
        beginTurn(state, (pi + 1) % n); // 鳴ける者がいなければ即次手番
      }
      return { ok: true, state };
    }

    case 'pon':
    case 'chi': {
      if (state.phase !== 'meldWindow' || !state.claimWindow) return fail(`${action.type}: no meld window`);
      const pi = playerIndexOf(action.player);
      if (pi < 0) return fail(`${action.type}: unknown player`);
      const { card, passed } = state.claimWindow;

      const claims = eligibleClaims(state);
      const active = claims.filter((c) => !passed.includes(state.players[c.playerIndex]!.id));
      const mine = claims.find((c) => c.playerIndex === pi && c.kind === action.type);
      if (!mine) return fail(`${action.type}: not eligible`);
      if (active.length === 0 || active[0]!.playerIndex !== pi) {
        return fail(`${action.type}: a higher-priority claim is pending`);
      }

      const player = state.players[pi]!;
      const used: Card[] = [action.cards[0], action.cards[1]];
      if (!hasAllInHand(player, used)) return fail(`${action.type}: cards not in hand`);
      const meldCards = [card, ...used];
      if (action.type === 'pon' ? !isValidGroup(meldCards) : !isValidSequence(meldCards)) {
        return fail(`${action.type}: cards do not form a valid meld`);
      }

      // 取得カードは手札に入れず必ずメルドに使う。捨て札を場から取り除く。
      for (const c of used) removeFromHand(player, c);
      state.discardPile.pop();
      state.melds.push({
        id: state.meldCounter++,
        owner: player.id,
        kind: action.type === 'pon' ? 'group' : 'sequence',
        cards: meldCards.map((c) => ({ ...c })),
      });
      state.claimWindow = null;
      state.currentPlayerIndex = pi; // 手番は鳴いた人へ（間は飛ばす＝麻雀式）

      if (checkWin(state, pi)) return { ok: true, state }; // 捨て札なしの上がり
      state.phase = 'awaitingDiscard'; // ツモなしで捨て札フェーズへ
      return { ok: true, state };
    }

    case 'pass': {
      if (state.phase !== 'meldWindow' || !state.claimWindow) return fail('pass: no meld window');
      const pi = playerIndexOf(action.player);
      if (pi < 0) return fail('pass: unknown player');
      if (!eligibleClaims(state).some((c) => c.playerIndex === pi)) return fail('pass: not eligible');
      if (!state.claimWindow.passed.includes(action.player)) state.claimWindow.passed.push(action.player);
      if (isWindowClosed(state)) beginTurn(state, (state.claimWindow.discarder + 1) % n);
      return { ok: true, state };
    }

    case 'closeWindow': {
      if (state.phase !== 'meldWindow' || !state.claimWindow) return fail('closeWindow: no meld window');
      beginTurn(state, (state.claimWindow.discarder + 1) % n);
      return { ok: true, state };
    }
  }
}
