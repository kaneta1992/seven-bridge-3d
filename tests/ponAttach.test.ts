// ユーザー報告シナリオの回帰テスト（2026-08-11）:
// 「前のターンで別のプレイヤーが666をポン → 自分の手番で7を公開 → 手札の6を666へ付け札」
import { describe, it, expect } from 'vitest';
import { applyAction, canAttach, eligibleClaims } from '../src/core';
import type { GameState } from '../src/core';
import { c, buildState } from './helpers';

function ok(state: GameState, action: Parameters<typeof applyAction>[1]): GameState {
  const r = applyAction(state, action);
  if (!r.ok) throw new Error(`expected ok but failed: ${r.error}`);
  return r.state;
}

describe('ポンで作られたメルドへの付け札（ユーザー報告シナリオ）', () => {
  it('ポンの666に翌手番プレイヤーが7公開後、4枚目の6を付け札できる', () => {
    // p0 が C6 を捨て → p1 が H6,S6 でポン → p1 捨て → p2 → p0 手番: 7公開 → D6 付け札
    const s0 = buildState(
      {
        p0: [c('C', 7), c('D', 6), c('C', 2)],
        p1: [c('H', 6), c('S', 6), c('H', 9), c('H', 10)],
        p2: [c('D', 11), c('D', 12)],
      },
      { current: 0, phase: 'meldWindow', deck: [c('S', 4), c('S', 8), c('S', 9)], discardPile: [c('C', 6)] },
    );
    s0.claimWindow = { discarder: 0, card: c('C', 6), passed: [] } as GameState['claimWindow'];
    expect(eligibleClaims(s0)).toContainEqual({ playerIndex: 1, kind: 'pon' });

    let s = ok(s0, { type: 'pon', player: 'p1', cards: [c('H', 6), c('S', 6)] });
    const ponMeld = s.melds.find((m) => m.cards.length === 3)!;
    expect(ponMeld.kind).toBe('group');
    expect(ponMeld.owner).toBe('p1');

    s = ok(s, { type: 'discard', player: 'p1', card: c('H', 9) });
    expect(s.currentPlayerIndex).toBe(2);
    s = ok(s, { type: 'draw', player: 'p2' });
    s = ok(s, { type: 'discard', player: 'p2', card: c('D', 11) });
    expect(s.currentPlayerIndex).toBe(0);
    s = ok(s, { type: 'draw', player: 'p0' });
    s = ok(s, { type: 'publishMeld', player: 'p0', cards: [c('C', 7)], meldKind: 'lone7' });

    const target = s.melds.find((m) => m.id === ponMeld.id)!;
    expect(canAttach(target, c('D', 6))).toBe(true);
    const r = applyAction(s, { type: 'attach', player: 'p0', meldId: ponMeld.id, card: c('D', 6) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.melds.find((m) => m.id === ponMeld.id)!.cards.length).toBe(4);
  });
});
