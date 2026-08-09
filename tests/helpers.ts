// テスト用ヘルパ（*.test.ts ではないので Vitest には拾われない）。
import type { Card, Suit, Rank } from '../src/core';
import { createGame } from '../src/core';
import type { GameState, Meld, Phase } from '../src/core';

/** カード生成の短縮記法。例: c('S', 7) */
export function c(suit: Suit, rank: Rank): Card {
  return { suit, rank };
}

export interface BuildOpts {
  phase?: Phase;
  current?: number;
  dealer?: number;
  round?: number;
  totalRounds?: number;
  deck?: Card[];
  discardPile?: Card[];
  melds?: Meld[];
  meldCounter?: number;
}

/**
 * 決められた手札で任意の局面を組み立てる（配札のシャッフルに依存しない決定的テスト用）。
 * hands のキー順が席順（index 0,1,2,...）。
 */
export function buildState(hands: Record<string, Card[]>, opts: BuildOpts = {}): GameState {
  const ids = Object.keys(hands);
  const state = createGame({
    players: ids.map((id) => ({ id, name: id })),
    totalRounds: opts.totalRounds ?? 4,
    seed: 1,
  });
  state.round = opts.round ?? 1;
  state.dealerIndex = opts.dealer ?? 0;
  state.currentPlayerIndex = opts.current ?? 1;
  state.phase = opts.phase ?? 'awaitingDiscard';
  ids.forEach((id, i) => {
    state.players[i]!.hand = hands[id]!.map((card) => ({ ...card }));
  });
  state.deck = (opts.deck ?? [c('C', 2), c('C', 3)]).map((card) => ({ ...card }));
  state.discardPile = (opts.discardPile ?? []).map((card) => ({ ...card }));
  state.melds = opts.melds ?? [];
  state.meldCounter = opts.meldCounter ?? state.melds.length;
  return state;
}
