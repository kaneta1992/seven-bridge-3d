// セブンブリッジ ルールエンジンの公開API。純粋TS（DOM/three/trystero 非依存）。
export type { Card, Suit, Rank } from './cards';
export { SUITS, RANKS, CARD_POINTS, cardId, sameCard, cardPoints, handScore, orderedDeck } from './cards';

export type { RngStep } from './rng';
export { nextRng, shuffle } from './rng';

export type { Meld, MeldKind } from './melds';
export {
  isConsecutiveRun,
  isValidSequence,
  isValidGroup,
  isLone7,
  canPublish,
  canAttach,
  attachResult,
} from './melds';

export type {
  Phase,
  Player,
  MeldWindow,
  GameState,
  Claim,
  Action,
  ActionResult,
  CreateGameConfig,
  PlayerView,
  PlayerViewSeat,
} from './engine';
export {
  createGame,
  applyAction,
  deriveViewFor,
  eligibleClaims,
  isWindowClosed,
  computeTotals,
} from './engine';
