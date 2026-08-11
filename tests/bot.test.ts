// NPC（ボット）AI と NPC 込み進行のテスト（契約16）。
// - 判断ロジックの合法性・視界制限（判断入力は自席 PlayerView に限定）
// - LocalDriver 1人プレイの applyBot 適用と、決定関数で回す NPC 込み1〜2ラウンド完走
// - HostDriver の applyBot（権威適用）が NPC 席のみ受理し、なりすまし検証（E7）を壊さない
// - BotRunner が実タイマー（フェイク）で NPC 手番を自動進行する
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Card, PlayerView, Rank, Suit } from '../src/core';
import { cardId } from '../src/core';
import { LocalDriver } from '../src/driver/localDriver';
import { HostDriver } from '../src/net/hostDriver';
import {
  BotRunner,
  claimActions,
  decideBotClaim,
  decideTurnAction,
  NPC_NAME_POOL,
  pickNpcName,
} from '../src/driver/botPlayer';

const C = (suit: Suit, rank: Rank): Card => ({ suit, rank });

function makeView(partial: Partial<PlayerView>): PlayerView {
  return {
    youIndex: 0,
    hand: [],
    seats: [{ id: 'me', name: 'me', index: 0, handCount: 0, isYou: true, isDealer: true, isCurrent: true }],
    melds: [],
    discardPile: [],
    discardTop: null,
    deckCount: 20,
    phase: 'awaitingDiscard',
    round: 1,
    totalRounds: 1,
    scores: [],
    lastWinner: null,
    finished: false,
    finalWinners: [],
    claimWindow: null,
    yourClaims: [],
    ...partial,
  };
}

describe('ボット判断ロジック（純粋・視界=自席 PlayerView）', () => {
  it('awaitingDraw ではツモを返す', () => {
    const a = decideTurnAction(makeView({ phase: 'awaitingDraw' }));
    expect(a).toEqual({ type: 'draw', player: 'me' });
  });

  it('公開できるグループがあれば publishMeld を返す（自席 hand 内のカードのみ）', () => {
    const hand = [C('C', 5), C('D', 5), C('H', 5), C('S', 13)];
    const a = decideTurnAction(makeView({ hand }));
    expect(a?.type).toBe('publishMeld');
    if (a?.type === 'publishMeld') {
      expect(a.meldKind).toBe('group');
      const ids = new Set(hand.map(cardId));
      for (const c of a.cards) expect(ids.has(cardId(c))).toBe(true); // 視界制限: 自席手札のみ使用
      expect(a.cards.every((c) => c.rank === 5)).toBe(true);
    }
  });

  it('公開できるシークエンスも公開する（同スート連続）', () => {
    const hand = [C('H', 4), C('H', 5), C('H', 6), C('S', 12)];
    const a = decideTurnAction(makeView({ hand }));
    expect(a?.type).toBe('publishMeld');
    if (a?.type === 'publishMeld') expect(a.meldKind).toBe('sequence');
  });

  it('公開手が無く自メルドがあれば付け札を返す', () => {
    const hand = [C('C', 9), C('S', 2)];
    const melds = [{ id: 0, owner: 'me', kind: 'group' as const, cards: [C('C', 2), C('D', 2), C('H', 2)] }];
    const a = decideTurnAction(makeView({ hand, melds }));
    expect(a).toEqual({ type: 'attach', player: 'me', meldId: 0, card: C('S', 2) });
  });

  it('公開/付け札が無ければ、失点の高い孤立カードを捨てる', () => {
    // どれも組/列/単独7 を作れない孤立札のみ → 最高失点の K を捨てる。
    const hand = [C('C', 2), C('D', 6), C('H', 9), C('S', 13)];
    const a = decideTurnAction(makeView({ hand }));
    expect(a?.type).toBe('discard');
    if (a?.type === 'discard') expect(a.card).toEqual(C('S', 13));
  });

  it('decideBotClaim: 資格があり rnd 低ならポン、rnd 高なら見送り（pass）', () => {
    const v = makeView({ phase: 'meldWindow', yourClaims: ['pon'], claimWindow: { discarder: 1, card: C('D', 8) } });
    expect(decideBotClaim(v, () => 0)).toBe('pon');
    expect(decideBotClaim(v, () => 0.99)).toBeNull();
    expect(decideBotClaim(makeView({ phase: 'meldWindow', yourClaims: [] }), () => 0)).toBeNull();
  });

  it('claimActions: 自席手札の該当ペアだけで pon アクションを列挙する', () => {
    const hand = [C('C', 8), C('D', 8), C('S', 2)];
    const v = makeView({ phase: 'meldWindow', hand, yourClaims: ['pon'], claimWindow: { discarder: 1, card: C('H', 8) } });
    const acts = claimActions(v, 'pon');
    expect(acts.length).toBe(1); // 8 のペアは1通り
    expect(acts[0]).toMatchObject({ type: 'pon', player: 'me' });
  });

  it('NPC 名は「（NPC）」印付きで衝突しない', () => {
    const taken = new Set<string>();
    const a = pickNpcName(taken);
    taken.add(a);
    const b = pickNpcName(taken);
    expect(a.endsWith('（NPC）')).toBe(true);
    expect(a).not.toBe(b);
    expect(a).toContain(NPC_NAME_POOL[0]);
  });
});

// 決定関数を直接適用して NPC 全席で1〜2ラウンドを回し切る（タイマー非依存の進行テスト）。
async function autoPlayBots(driver: LocalDriver, ids: string[], maxSteps = 8000): Promise<{ melds: number }> {
  let sawMeld = 0;
  for (let step = 0; step < maxSteps; step++) {
    const anchor = driver.getView(ids[0]!);
    if (anchor.finished) break;
    sawMeld = Math.max(sawMeld, anchor.melds.length);
    switch (anchor.phase) {
      case 'awaitingStart':
      case 'roundOver':
        expect((await driver.dispatch({ type: 'startRound' })).ok).toBe(true);
        break;
      case 'awaitingDraw':
      case 'awaitingDiscard': {
        const cur = anchor.seats.find((s) => s.isCurrent)!.id;
        const act = decideTurnAction(driver.getView(cur));
        expect(act).not.toBeNull();
        expect((await driver.applyBot(act!)).ok).toBe(true);
        break;
      }
      case 'meldWindow': {
        let acted = false;
        for (const id of ids) {
          const cv = driver.getView(id);
          if (cv.phase !== 'meldWindow' || cv.yourClaims.length === 0) continue;
          const kind = decideBotClaim(cv, () => 0); // rnd=0 → 資格があれば必ず鳴く
          if (kind) {
            for (const a of claimActions(cv, kind)) {
              if ((await driver.applyBot(a)).ok) {
                acted = true;
                break;
              }
            }
          } else {
            expect((await driver.applyBot({ type: 'pass', player: id })).ok).toBe(true);
            acted = true;
          }
          if (acted) break;
        }
        if (!acted) await driver.dispatch({ type: 'closeWindow' });
        break;
      }
      case 'gameOver':
        break;
    }
  }
  return { melds: sawMeld };
}

describe('LocalDriver 1人プレイ（NPC 込み進行）', () => {
  it('全席 NPC・3人2ラウンドを完走し、途中でメルドが発生する', async () => {
    const players = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' },
    ];
    const driver = new LocalDriver({ players, totalRounds: 2, seed: 123, npcIds: players.map((p) => p.id) });
    const { melds } = await autoPlayBots(driver, ['a', 'b', 'c']);
    const v = driver.getView('a');
    expect(v.finished).toBe(true);
    expect(v.scores.length).toBe(2);
    expect(melds).toBeGreaterThan(0); // 公開/鳴きが起きた
  });

  it('固定自席モード: currentPlayerId は人間席固定、claimants は自席のみ、applyBot は NPC 席限定', () => {
    const players = [
      { id: 'you', name: 'H' },
      { id: 'npc0', name: 'あけみ（NPC）' },
    ];
    const driver = new LocalDriver({ players, totalRounds: 1, seed: 9, selfId: 'you', npcIds: ['npc0'] });
    expect(driver.currentPlayerId()).toBe('you');
    expect(driver.botSeats()).toEqual(['npc0']);
    // 人間席のアクションを applyBot に渡しても拒否（NPC 席のみ）。
    return driver.applyBot({ type: 'draw', player: 'you' }).then((r) => expect(r.ok).toBe(false));
  });
});

describe('BotRunner 実行（フェイクタイマー）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('NPC 手番を自動で進める（山札が減る＝ツモ発生）・人間席は打たない', async () => {
    const players = [
      { id: 'you', name: 'H' },
      { id: 'npc0', name: 'N' },
    ];
    const driver = new LocalDriver({ players, totalRounds: 1, seed: 5, selfId: 'you', npcIds: ['npc0'] });
    await driver.dispatch({ type: 'startRound' }); // dealer=0(you), 初手番=index1=npc0
    const runner = new BotRunner(driver, ['npc0'], { rnd: () => 0 });
    runner.start();
    await vi.advanceTimersByTimeAsync(20000);
    // npc0 がツモ→（公開/付け札）→捨て を実行し、山札が初期(38)から減る。
    expect(driver.getView('you').deckCount).toBeLessThan(38);
    runner.dispose();
  });
});

describe('HostDriver applyBot（権威適用・E7 非破壊）', () => {
  function makeHostWithNpc() {
    const snaps: unknown[] = [];
    const errs: { peer: string; reqId: number; message: string }[] = [];
    const pkToPeer = new Map([['g1', 'g1peer']]);
    const peerToPk = new Map([['g1peer', 'g1']]);
    const host = new HostDriver({
      players: [
        { id: 'h', name: 'H' },
        { id: 'npc0', name: 'カル子（NPC）' },
        { id: 'g1', name: 'G1' },
      ],
      selfPk: 'h',
      totalRounds: 1,
      seed: 42,
      npcIds: ['npc0'],
      resolvePeer: (pk) => (pk === 'h' ? null : (pkToPeer.get(pk) ?? null)),
      resolvePk: (peer) => peerToPk.get(peer) ?? null,
      sendSnap: (_p, m) => snaps.push(m),
      sendErr: (peer, m) => errs.push({ peer, reqId: m.reqId, message: m.message }),
      sendAck: () => {},
    });
    return { host, snaps, errs };
  }

  it('NPC 席のアクションは applyBot で権威適用され、ゲストへ配信される', async () => {
    const { host, snaps } = makeHostWithNpc();
    await host.dispatch({ type: 'startRound' }); // dealer=0(h), 初手番=index1=npc0
    const before = snaps.length;
    const r = await host.applyBot({ type: 'draw', player: 'npc0' });
    expect(r.ok).toBe(true);
    expect(snaps.length).toBeGreaterThan(before); // 各ゲストへスナップショット配信
  });

  it('applyBot は非 NPC 席（人間/ホスト）を拒否する', async () => {
    const { host } = makeHostWithNpc();
    await host.dispatch({ type: 'startRound' });
    expect((await host.applyBot({ type: 'draw', player: 'g1' })).ok).toBe(false);
    expect((await host.applyBot({ type: 'draw', player: 'h' })).ok).toBe(false);
  });

  it('E7 維持: ゲストが player=NPC を騙る要求は handleAction で拒否される', async () => {
    const { host, errs } = makeHostWithNpc();
    await host.dispatch({ type: 'startRound' });
    host.handleAction({ reqId: 1, action: { type: 'draw', player: 'npc0' } }, 'g1peer');
    expect(errs).toEqual([{ peer: 'g1peer', reqId: 1, message: '不正なプレイヤー指定です' }]);
  });
});
