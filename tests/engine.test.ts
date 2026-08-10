import { describe, it, expect } from 'vitest';
import {
  createGame,
  applyAction,
  deriveViewFor,
  eligibleClaims,
  isWindowClosed,
  cardId,
} from '../src/core';
import type { GameState, Meld } from '../src/core';
import { c, buildState } from './helpers';

function ok(state: GameState, action: Parameters<typeof applyAction>[1]): GameState {
  const r = applyAction(state, action);
  if (!r.ok) throw new Error(`expected ok but failed: ${r.error}`);
  return r.state;
}

describe('applyAction 未知アクションの防御（契約10項目7）', () => {
  it('未知の action.type は状態を変えず fail("unknown action") を返す（undefined を返さない）', () => {
    const g = createGame({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seed: 3 });
    // 型を迂回した不正入力（将来の取りこぼしを含む）。
    const r = applyAction(g, { type: 'bogus' } as unknown as Parameters<typeof applyAction>[1]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('unknown action');
    // 元状態は不変（構造クローンのため参照も別だが、フェーズ等が変わっていないことを確認）。
    expect(g.phase).toBe('awaitingStart');
  });
});

describe('配札とディーラー移動 (E1: 2人/6人境界・最初のツモは左隣)', () => {
  it('startRound で7枚ずつ配り、山札と捨て札を作る', () => {
    const g = createGame({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seed: 7 });
    const s = ok(g, { type: 'startRound' });
    expect(s.round).toBe(1);
    expect(s.players.every((p) => p.hand.length === 7)).toBe(true);
    expect(s.discardPile.length).toBe(0); // 開始時のめくり札なし（2026-08-10 変更）
    expect(s.deck.length).toBe(52 - 14); // 38
    expect(s.dealerIndex).toBe(0);
    expect(s.currentPlayerIndex).toBe(1); // ディーラーの左隣
    expect(s.phase).toBe('awaitingDraw');
  });

  it('6人戦の山札枚数は 52-42=10', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const g = createGame({ players: ids.map((id) => ({ id, name: id })), seed: 3 });
    const s = ok(g, { type: 'startRound' });
    expect(s.deck.length).toBe(10);
    expect(s.players.every((p) => p.hand.length === 7)).toBe(true);
  });

  it('直前ラウンドの勝者が次の親になる（ユーザー指定ルール）', () => {
    const g = createGame({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], seed: 5 });
    let s = ok(g, { type: 'startRound' });
    expect(s.dealerIndex).toBe(0);
    // c が上がったことにして次ラウンドを開始
    s.phase = 'roundOver';
    s.lastWinner = 'c';
    s = ok(s, { type: 'startRound' });
    expect(s.round).toBe(2);
    expect(s.dealerIndex).toBe(2); // 勝者 c が親
    expect(s.currentPlayerIndex).toBe(0); // 親の左隣から
  });

  it('流局（lastWinner=null）では親が継続する', () => {
    const g = createGame({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], seed: 5 });
    let s = ok(g, { type: 'startRound' });
    // 2ラウンド目: b が勝者 → 親は b
    s.phase = 'roundOver';
    s.lastWinner = 'b';
    s = ok(s, { type: 'startRound' });
    expect(s.dealerIndex).toBe(1);
    // 3ラウンド目: 流局 → 親は b のまま
    s.phase = 'roundOver';
    s.lastWinner = null;
    s = ok(s, { type: 'startRound' });
    expect(s.round).toBe(3);
    expect(s.dealerIndex).toBe(1);
  });

  it('シード付きで配札は決定的 (E6)', () => {
    const mk = () => ok(createGame({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seed: 99 }), { type: 'startRound' });
    const s1 = mk();
    const s2 = mk();
    expect(s1.players[0]!.hand.map(cardId)).toEqual(s2.players[0]!.hand.map(cardId));
    expect(s1.deck.map(cardId)).toEqual(s2.deck.map(cardId));
  });
});

describe('手番の流れ', () => {
  it('ツモ→捨て札で次の手番へ（鳴き無しの場合）', () => {
    const s0 = buildState(
      { p0: [c('C', 2), c('C', 5)], p1: [c('H', 9)], p2: [c('D', 11)] },
      { current: 0, phase: 'awaitingDraw', deck: [c('S', 4), c('S', 8)], discardPile: [c('C', 3)] },
    );
    const drawn = ok(s0, { type: 'draw', player: 'p0' });
    expect(drawn.phase).toBe('awaitingDiscard');
    expect(drawn.players[0]!.hand.length).toBe(3);
    const after = ok(drawn, { type: 'discard', player: 'p0', card: c('C', 2) });
    // 誰も鳴けない → 次席へ
    expect(after.phase).toBe('awaitingDraw');
    expect(after.currentPlayerIndex).toBe(1);
    expect(after.discardPile[after.discardPile.length - 1]).toEqual(c('C', 2));
  });

  it('捨て札から通常ツモはできない（山札からのみ） / 山札空でツモ不可', () => {
    const s0 = buildState({ p0: [c('C', 2)], p1: [c('H', 9)] }, { current: 0, phase: 'awaitingDraw', deck: [] });
    const r = applyAction(s0, { type: 'draw', player: 'p0' });
    expect(r.ok).toBe(false);
  });
});

describe('上がり判定 (E1/E10: 捨て札あり/なしの両経路)', () => {
  it('最後の1枚を捨てて上がり', () => {
    const s0 = buildState({ p0: [c('C', 2)], p1: [c('H', 13), c('S', 5)] }, { current: 0, phase: 'awaitingDiscard', deck: [c('D', 3)] });
    const s = ok(s0, { type: 'discard', player: 'p0', card: c('C', 2) });
    expect(s.phase).toBe('roundOver');
    expect(s.lastWinner).toBe('p0');
    expect(s.scores[0]).toEqual([0, 13 + 5]);
  });

  it('メルド公開で出し切って上がり（捨て札なし）', () => {
    const s0 = buildState({ p0: [c('C', 4), c('C', 5), c('C', 6)], p1: [c('H', 9)] }, { current: 0, phase: 'awaitingDiscard', deck: [c('D', 3)] });
    const s = ok(s0, { type: 'publishMeld', player: 'p0', cards: [c('C', 4), c('C', 5), c('C', 6)], meldKind: 'sequence' });
    expect(s.phase).toBe('roundOver');
    expect(s.lastWinner).toBe('p0');
    expect(s.players[0]!.hand.length).toBe(0);
  });

  it('付け札で出し切って上がり（捨て札なし）', () => {
    const meld: Meld = { id: 0, owner: 'p0', kind: 'sequence', cards: [c('C', 4), c('C', 5), c('C', 6)] };
    const s0 = buildState({ p0: [c('C', 7)], p1: [c('H', 9)] }, { current: 0, phase: 'awaitingDiscard', melds: [meld], meldCounter: 1, deck: [c('D', 3)] });
    const s = ok(s0, { type: 'attach', player: 'p0', meldId: 0, card: c('C', 7) });
    expect(s.phase).toBe('roundOver');
    expect(s.lastWinner).toBe('p0');
  });
});

describe('流局 (E1/D4: 山札切れで全員手札失点)', () => {
  it('山札が尽きたら上がり者なしで全員計上', () => {
    const s0 = buildState(
      { p0: [c('C', 2), c('C', 3)], p1: [c('H', 5), c('S', 9)] },
      { current: 0, phase: 'awaitingDiscard', deck: [] },
    );
    const s = ok(s0, { type: 'discard', player: 'p0', card: c('C', 2) });
    expect(s.phase).toBe('roundOver');
    expect(s.lastWinner).toBe(null);
    expect(s.scores[0]).toEqual([3, 5 + 9]); // 全員が残り手札を失点
  });
});

describe('付け札の資格 (E2/§2.3: 未公開者は拒否・公開後は解禁)', () => {
  const p1Meld: Meld = { id: 0, owner: 'p1', kind: 'group', cards: [c('D', 9), c('H', 9), c('C', 9)] };

  it('自分がメルド未公開なら付け札できない', () => {
    const s0 = buildState({ p0: [c('S', 9), c('S', 2)], p1: [c('H', 1)] }, { current: 0, phase: 'awaitingDiscard', melds: [p1Meld], meldCounter: 1 });
    const r = applyAction(s0, { type: 'attach', player: 'p0', meldId: 0, card: c('S', 9) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('not published');
  });

  it('自分のメルドを公開済みなら他人のメルドにも付け札できる', () => {
    const ownMeld: Meld = { id: 1, owner: 'p0', kind: 'sequence', cards: [c('C', 4), c('C', 5), c('C', 6)] };
    const s0 = buildState({ p0: [c('S', 9), c('S', 2)], p1: [c('H', 1)] }, { current: 0, phase: 'awaitingDiscard', melds: [p1Meld, ownMeld], meldCounter: 2 });
    const s = ok(s0, { type: 'attach', player: 'p0', meldId: 0, card: c('S', 9) });
    const grp = s.melds.find((m) => m.id === 0)!;
    expect(grp.cards.map(cardId)).toContain('S9');
    expect(s.players[0]!.hand.map(cardId)).not.toContain('S9');
  });
});

describe('ポン/チーの資格 (E2/E3: チーは上家限定・ポン優先・優先順・麻雀式)', () => {
  // p0(0) が D5 を捨てる。p1(1)=上家 は D4,D6 でチー可。p2(2) は 5 二枚でポン可。
  const base = () =>
    buildState(
      { p0: [c('C', 2)], p1: [c('D', 4), c('D', 6)], p2: [c('H', 5), c('S', 5), c('C', 10)] },
      { current: 0, phase: 'meldWindow', deck: [c('C', 13)], discardPile: [c('D', 5)] },
    );
  const withWindow = (s: GameState): GameState => {
    s.claimWindow = { discarder: 0, card: c('D', 5), passed: [] };
    return s;
  };

  it('eligibleClaims はポンをチーより先に列挙する', () => {
    const s = withWindow(base());
    const claims = eligibleClaims(s);
    expect(claims[0]).toEqual({ playerIndex: 2, kind: 'pon' });
    expect(claims).toContainEqual({ playerIndex: 1, kind: 'chi' });
  });

  it('ポン保留中のチーは拒否される（ポン優先）', () => {
    const s = withWindow(base());
    const r = applyAction(s, { type: 'chi', player: 'p1', cards: [c('D', 4), c('D', 6)] });
    expect(r.ok).toBe(false);
  });

  it('ポンは手番を鳴いた人へ移し間を飛ばす（麻雀式）・取得札は手札に入れずメルドへ (E5)', () => {
    const s = ok(withWindow(base()), { type: 'pon', player: 'p2', cards: [c('H', 5), c('S', 5)] });
    expect(s.currentPlayerIndex).toBe(2); // p1 を飛ばす
    expect(s.phase).toBe('awaitingDiscard');
    const meld = s.melds.at(-1)!;
    expect(meld.owner).toBe('p2');
    expect(meld.cards.map(cardId).sort()).toEqual(['D5', 'H5', 'S5']);
    expect(s.players[2]!.hand.map(cardId)).toEqual(['C10']); // H5/S5 は消費
    expect(s.discardPile.map(cardId)).not.toContain('D5'); // 場から取り除かれた
  });

  it('鳴ける全員がパスするとウィンドウが閉じて次席へ', () => {
    let s = withWindow(base());
    s = ok(s, { type: 'pass', player: 'p2' });
    expect(isWindowClosed(s)).toBe(false);
    s = ok(s, { type: 'pass', player: 'p1' });
    expect(s.phase).toBe('awaitingDraw');
    expect(s.currentPlayerIndex).toBe(1);
  });

  it('チーは上家（捨て手の次席）以外は不可', () => {
    // p2(2) が捨てる → 上家は p0(0)。p1 は D4,D6 を持つが上家でないためチー不可。
    const s = buildState(
      { p0: [c('C', 2)], p1: [c('D', 4), c('D', 6)], p2: [c('C', 8)] },
      { current: 2, phase: 'meldWindow', discardPile: [c('D', 5)] },
    );
    s.claimWindow = { discarder: 2, card: c('D', 5), passed: [] };
    const claims = eligibleClaims(s);
    expect(claims.some((cl) => cl.kind === 'chi')).toBe(false);
  });

  it('2人戦のチーは唯一の相手（上家）が可 (E1)', () => {
    const s = buildState(
      { p0: [c('C', 2)], p1: [c('D', 4), c('D', 6)] },
      { current: 0, phase: 'meldWindow', discardPile: [c('D', 5)] },
    );
    s.claimWindow = { discarder: 0, card: c('D', 5), passed: [] };
    expect(eligibleClaims(s)).toContainEqual({ playerIndex: 1, kind: 'chi' });
  });

  it('複数ポンは捨てた人から時計回りで近い順（優先順の単体確認）', () => {
    // 注: 52枚単デッキでは同一ランクは4枚なので実局面で複数ポンは発生しないが、
    // 優先順リゾルバの並びを固定するため人工的な局面で検証する。
    const s = buildState(
      { p0: [c('C', 2)], p1: [c('H', 5), c('D', 5)], p2: [c('H', 5), c('D', 5)], p3: [c('H', 5), c('D', 5)] },
      { current: 0, phase: 'meldWindow', discardPile: [c('S', 5)] },
    );
    s.claimWindow = { discarder: 0, card: c('S', 5), passed: [] };
    const order = eligibleClaims(s).map((cl) => cl.playerIndex);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe('視界フィルタ deriveViewFor (E7: 他家手札を漏らさない)', () => {
  it('自分の手札のみ実カード、他家は枚数のみ', () => {
    const s = buildState(
      { p0: [c('S', 13), c('S', 12)], p1: [c('H', 3), c('H', 4), c('H', 5)] },
      { current: 1, phase: 'awaitingDiscard', discardPile: [c('C', 2)] },
    );
    const view = deriveViewFor(s, 'p1');
    expect(view.youIndex).toBe(1);
    expect(view.hand.map(cardId).sort()).toEqual(['H3', 'H4', 'H5']);
    expect(view.seats[0]!.handCount).toBe(2);
    expect(view.seats[1]!.handCount).toBe(3);
    // p0 の実カード(S13/S12)がビューのどこにも現れない
    const dump = JSON.stringify(view);
    expect(dump).not.toContain('"rank":13');
    expect(dump).not.toContain('"rank":12');
    expect(view.deckCount).toBe(s.deck.length);
  });

  it('鳴き可否は自分の分だけ（他家の鳴き可否は含めない）', () => {
    const s = buildState(
      { p0: [c('C', 2)], p1: [c('D', 4), c('D', 6)], p2: [c('H', 5), c('S', 5), c('C', 10)] },
      { current: 0, phase: 'meldWindow', discardPile: [c('D', 5)] },
    );
    s.claimWindow = { discarder: 0, card: c('D', 5), passed: [] };
    expect(deriveViewFor(s, 'p2').yourClaims).toEqual(['pon']);
    expect(deriveViewFor(s, 'p1').yourClaims).toEqual(['chi']);
    expect(deriveViewFor(s, 'p0').yourClaims).toEqual([]); // 捨てた本人は鳴けない
  });
});

describe('不正アクションの拒否と状態不変 (E8)', () => {
  it('手番外のツモは拒否し、元stateを破壊しない', () => {
    const s0 = buildState({ p0: [c('C', 2)], p1: [c('H', 9)] }, { current: 1, phase: 'awaitingDraw', deck: [c('D', 3)] });
    const snapshot = structuredClone(s0);
    const r = applyAction(s0, { type: 'draw', player: 'p0' });
    expect(r.ok).toBe(false);
    expect(s0).toEqual(snapshot); // 入力stateは不変
  });

  it('資格のないポンは拒否', () => {
    const s = buildState({ p0: [c('C', 2)], p1: [c('H', 9)], p2: [c('S', 8)] }, { current: 0, phase: 'meldWindow', discardPile: [c('D', 5)] });
    s.claimWindow = { discarder: 0, card: c('D', 5), passed: [] };
    const r = applyAction(s, { type: 'pon', player: 'p1', cards: [c('H', 9), c('S', 8)] });
    expect(r.ok).toBe(false);
  });
});

describe('スコア集計とゲーム終了 (§2.5/§2.6: マトリクス・累計・勝者)', () => {
  it('最終ラウンド終了で gameOver、合計最少が勝者', () => {
    const s0 = buildState(
      { p0: [c('C', 2)], p1: [c('H', 13)] },
      { current: 0, phase: 'awaitingDiscard', totalRounds: 1, round: 1, deck: [c('D', 3)] },
    );
    const s = ok(s0, { type: 'discard', player: 'p0', card: c('C', 2) });
    expect(s.phase).toBe('gameOver');
    expect(s.finished).toBe(true);
    expect(s.scores).toEqual([[0, 13]]); // ラウンド×プレイヤーのマトリクス
    expect(s.finalWinners).toEqual(['p0']);
  });

  it('同点は同着（流局で両者同点）', () => {
    const s0 = buildState(
      { p0: [c('C', 2), c('C', 3)], p1: [c('H', 3)] },
      { current: 0, phase: 'awaitingDiscard', totalRounds: 1, round: 1, deck: [] },
    );
    const s = ok(s0, { type: 'discard', player: 'p0', card: c('C', 2) });
    expect(s.phase).toBe('gameOver');
    expect(s.scores[0]).toEqual([3, 3]);
    expect(s.finalWinners.sort()).toEqual(['p0', 'p1']);
  });
});
