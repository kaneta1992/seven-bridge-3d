// ネットワーク層（契約03）の実 WebRTC なしユニット/統合テスト。
// - ホスト権威検証（なりすまし E7 / 二重・残存接続 E8 / ホスト専用アクション）
// - 視界フィルタ配信（他家手札・山札をペイロードに含めない E5）
// - スナップショット順序保証（古い seq を破棄 E3）
// - セッション統合（名簿・開始・伝播・ホスト切断 D5 / 再接続復帰）
import { describe, expect, it } from 'vitest';
import { cardId } from '../src/core';
import type { GameDriver } from '../src/driver/types';
import { GuestDriver } from '../src/net/guestDriver';
import { HostDriver } from '../src/net/hostDriver';
import { NS, type SnapshotMsg, type StartMsg } from '../src/net/protocol';
import { NetSession } from '../src/net/session';
import { MockHub, settle } from './netHelpers';

const ROSTER = [
  { id: 'h', name: 'H' },
  { id: 'g1', name: 'G1' },
  { id: 'g2', name: 'G2' },
];

function makeHost(seed = 42) {
  const snaps: { peer: string; msg: SnapshotMsg }[] = [];
  const errs: { peer: string; reqId: number; message: string }[] = [];
  const acks: { peer: string; reqId: number }[] = [];
  const pkToPeer = new Map([
    ['g1', 'g1peer'],
    ['g2', 'g2peer'],
  ]);
  const peerToPk = new Map([
    ['g1peer', 'g1'],
    ['g2peer', 'g2'],
  ]);
  const host = new HostDriver({
    players: ROSTER,
    selfPk: 'h',
    totalRounds: 1,
    seed,
    resolvePeer: (pk) => (pk === 'h' ? null : (pkToPeer.get(pk) ?? null)),
    resolvePk: (peer) => peerToPk.get(peer) ?? null,
    sendSnap: (peer, msg) => snaps.push({ peer, msg }),
    sendErr: (peer, msg) => errs.push({ peer, reqId: msg.reqId, message: msg.message }),
    sendAck: (peer, msg) => acks.push({ peer, reqId: msg.reqId }),
  });
  return { host, snaps, errs, acks, pkToPeer, peerToPk };
}

describe('HostDriver 視界フィルタ配信', () => {
  it('E5: 配信スナップショットに他家手札・山札が一切含まれない（ペイロード漏洩なし）', () => {
    const { host, snaps } = makeHost();
    void host.dispatch({ type: 'startRound' });

    const g1 = snaps.filter((s) => s.peer === 'g1peer').at(-1)!;
    const g2 = snaps.filter((s) => s.peer === 'g2peer').at(-1)!;
    expect(g1 && g2).toBeTruthy();

    // 各自の手札は7枚。相手にだけ見えるカードは互いに素（＝自分の手札しか配られていない）。
    expect(g1.msg.view.hand.length).toBe(7);
    expect(g2.msg.view.hand.length).toBe(7);
    const g1ids = new Set(g1.msg.view.hand.map(cardId));
    const overlap = g2.msg.view.hand.filter((c) => g1ids.has(cardId(c)));
    expect(overlap).toEqual([]);

    for (const s of [g1, g2]) {
      const wire = JSON.stringify(s.msg);
      // 山札そのもの（配列）はワイヤに載らない。deckCount（数）だけが公開情報。
      expect(wire.includes('"deck"')).toBe(false);
      expect(typeof s.msg.view.deckCount).toBe('number');
      // 席には手札枚数のみ。実手札 hand プロパティは持たない。
      for (const seat of s.msg.view.seats) expect('hand' in seat).toBe(false);
    }
  });

  it('視界フィルタ: 相手には自分の hand が届き、他家分は席の handCount のみ', () => {
    const { host, snaps } = makeHost();
    void host.dispatch({ type: 'startRound' });
    const g1 = snaps.filter((s) => s.peer === 'g1peer').at(-1)!;
    const meIdx = g1.msg.view.youIndex;
    expect(g1.msg.view.seats[meIdx]!.id).toBe('g1');
    for (const seat of g1.msg.view.seats) expect(seat.handCount).toBe(7);
  });
});

describe('HostDriver ホスト権威検証', () => {
  it('正当なゲスト要求は適用され、全ゲストへ新スナップショットが配信される', () => {
    const { host, snaps, errs } = makeHost();
    void host.dispatch({ type: 'startRound' }); // dealer=0(h), 手番= index1 = g1
    const before = snaps.length;
    host.handleAction({ reqId: 1, action: { type: 'draw', player: 'g1' } }, 'g1peer');
    expect(errs).toEqual([]);
    expect(snaps.length).toBeGreaterThan(before);
    // ツモ後 g1 の手札は8枚
    const g1 = snaps.filter((s) => s.peer === 'g1peer').at(-1)!;
    expect(g1.msg.view.hand.length).toBe(8);
  });

  it('E7: peerId と食い違う player 指定（なりすまし）は要求元にのみ拒否通知', () => {
    const { host, snaps, errs } = makeHost();
    void host.dispatch({ type: 'startRound' });
    const before = snaps.length;
    // g1peer が player:'h'（ホスト）を騙る
    host.handleAction({ reqId: 9, action: { type: 'draw', player: 'h' } }, 'g1peer');
    expect(snaps.length).toBe(before); // 状態は不変（配信なし）
    expect(errs).toEqual([{ peer: 'g1peer', reqId: 9, message: '不正なプレイヤー指定です' }]);
  });

  it('ホスト専用アクション（startRound/closeWindow）はゲストから受け付けない', () => {
    const { host, errs } = makeHost();
    void host.dispatch({ type: 'startRound' });
    host.handleAction({ reqId: 3, action: { type: 'closeWindow' } }, 'g1peer');
    host.handleAction({ reqId: 4, action: { type: 'startRound' } }, 'g2peer');
    expect(errs.map((e) => e.reqId)).toEqual([3, 4]);
    expect(errs.every((e) => e.message.includes('ホスト'))).toBe(true);
  });

  it('二重アクション要求はエンジン検証で拒否され、要求元のみへ通知', () => {
    const { host, errs } = makeHost();
    void host.dispatch({ type: 'startRound' });
    host.handleAction({ reqId: 1, action: { type: 'draw', player: 'g1' } }, 'g1peer'); // 1回目OK
    host.handleAction({ reqId: 2, action: { type: 'draw', player: 'g1' } }, 'g1peer'); // 2回目NG
    expect(errs.length).toBe(1);
    expect(errs[0]!.reqId).toBe(2);
  });

  it('E8: 残存/古い peerId からの要求は最新束縛でないため無視（エラーも状態変化もなし）', () => {
    const { host, snaps, errs, pkToPeer } = makeHost();
    void host.dispatch({ type: 'startRound' });
    // g1 が新しい接続 g1peer2 に張り替わった（session.onHello 相当）
    pkToPeer.set('g1', 'g1peer2');
    const before = snaps.length;
    host.handleAction({ reqId: 7, action: { type: 'draw', player: 'g1' } }, 'g1peer'); // 古い接続
    expect(snaps.length).toBe(before);
    expect(errs).toEqual([]); // 黙って無視（残存接続へエラーを返さない）
  });

  it('未知のピア（名簿外）からの要求は無視', () => {
    const { host, snaps, errs } = makeHost();
    void host.dispatch({ type: 'startRound' });
    const before = snaps.length;
    host.handleAction({ reqId: 5, action: { type: 'draw', player: 'x' } }, 'strangerPeer');
    expect(snaps.length).toBe(before);
    expect(errs).toEqual([]);
  });
});

describe('GuestDriver スナップショット順序保証', () => {
  it('E3: 古い seq のスナップショットは破棄され、最新ビューが保持される', () => {
    const { host, snaps } = makeHost();
    void host.dispatch({ type: 'startRound' }); // seqA, g1 手札7
    const snapA = snaps.filter((s) => s.peer === 'g1peer').at(-1)!.msg;
    host.handleAction({ reqId: 1, action: { type: 'draw', player: 'g1' } }, 'g1peer'); // seqB, g1 手札8
    const snapB = snaps.filter((s) => s.peer === 'g1peer').at(-1)!.msg;
    expect(snapB.seq).toBeGreaterThan(snapA.seq);

    const guest = new GuestDriver({ selfPk: 'g1', players: ROSTER, totalRounds: 1, sendAct: () => {} });
    guest.applySnapshot(snapB); // 新しい方を先に
    guest.applySnapshot(snapA); // 古い方が後着 → 破棄
    expect(guest.getView('g1').hand.length).toBe(8);
  });
});

describe('NetSession 統合（インメモリ・トランスポート）', () => {
  it('名簿→開始→スナップショット伝播→ゲスト要求の権威往復が成立する', async () => {
    const hub = new MockHub();
    const hostT = hub.create('hostPeer');
    const g1T = hub.create('g1Peer');
    const g2T = hub.create('g2Peer');

    const hostS = NetSession.host('ABC234', 'h', 'H', hostT, { maxPlayers: 4, totalRounds: 1 });
    const g1S = NetSession.guest('ABC234', 'g1', 'G1', g1T);
    const g2S = NetSession.guest('ABC234', 'g2', 'G2', g2T);

    let hostRoster: { pk: string; name: string }[] = [];
    hostS.on('roster', (m) => (hostRoster = m));
    let g1Driver: GameDriver | null = null;
    let g2Driver: GameDriver | null = null;
    g1S.on('started', (d) => (g1Driver = d));
    g2S.on('started', (d) => (g2Driver = d));

    await settle();
    // ホストの待機ルーム名簿に3人そろう
    expect(hostRoster.map((m) => m.pk).sort()).toEqual(['g1', 'g2', 'h']);

    const hostDriver = hostS.startGame();
    await settle();
    void hostDriver.dispatch({ type: 'startRound' }); // 権威者が配札
    await settle();

    expect(g1Driver).not.toBeNull();
    expect(g2Driver).not.toBeNull();
    // 各ゲストは自席7枚を受信、互いの手札は互いに素（E5伝播）
    const g1hand = g1Driver!.getView('g1').hand;
    const g2hand = g2Driver!.getView('g2').hand;
    expect(g1hand.length).toBe(7);
    expect(g2hand.length).toBe(7);
    const g1ids = new Set(g1hand.map(cardId));
    expect(g2hand.some((c) => g1ids.has(cardId(c)))).toBe(false);

    // 手番プレイヤー(g1)のツモは成功、非手番(g2)のツモは却下される（ホスト権威往復）
    const okP = g1Driver!.dispatch({ type: 'draw', player: 'g1' });
    const ngP = g2Driver!.dispatch({ type: 'draw', player: 'g2' });
    await settle();
    expect((await okP).ok).toBe(true);
    expect((await ngP).ok).toBe(false);
    expect(g1Driver!.getView('g1').hand.length).toBe(8);

    hostS.dispose();
    g1S.dispose();
    g2S.dispose();
  });

  it('D5: ホスト切断でゲストに続行不能を通知する', async () => {
    const hub = new MockHub();
    const hostT = hub.create('hostPeer');
    const g1T = hub.create('g1Peer');
    const hostS = NetSession.host('ABC235', 'h', 'H', hostT, { maxPlayers: 4, totalRounds: 1 });
    const g1S = NetSession.guest('ABC235', 'g1', 'G1', g1T);
    let fatal = '';
    g1S.on('fatal', (m) => (fatal = m));
    let g1Driver: GameDriver | null = null;
    g1S.on('started', (d) => (g1Driver = d));

    await settle();
    const hostDriver = hostS.startGame();
    await settle();
    void hostDriver.dispatch({ type: 'startRound' });
    await settle();
    expect(g1Driver).not.toBeNull();

    hostT.leave(); // ホストがタブを閉じた
    await settle();
    expect(fatal).toContain('ホスト');

    g1S.dispose();
  });

  it('満員ルームへの参加は拒否される（E1）', async () => {
    const hub = new MockHub();
    const hostT = hub.create('hostPeer');
    const g1T = hub.create('g1Peer');
    const g2T = hub.create('g2Peer');
    const hostS = NetSession.host('ABC236', 'h', 'H', hostT, { maxPlayers: 2, totalRounds: 1 });
    const g1S = NetSession.guest('ABC236', 'g1', 'G1', g1T);
    const g2S = NetSession.guest('ABC236', 'g2', 'G2', g2T);
    let g2Error = '';
    g2S.on('error', (m) => (g2Error = m));

    await settle();
    // maxPlayers=2 なので host+g1 で満員、g2 は拒否
    expect(g2Error).toContain('満員');

    hostS.dispose();
    g1S.dispose();
    g2S.dispose();
  });

  it('再接続: 開始後に同一 playerKey で入り直すと start と最新スナップショットが再送される', async () => {
    const hub = new MockHub();
    const hostT = hub.create('hostPeer');
    const g1T = hub.create('g1Peer');
    const hostS = NetSession.host('ABC237', 'h', 'H', hostT, { maxPlayers: 4, totalRounds: 1 });
    const g1S = NetSession.guest('ABC237', 'g1', 'G1', g1T);
    let g1Driver: GameDriver | null = null;
    g1S.on('started', (d) => (g1Driver = d));

    await settle();
    const hostDriver = hostS.startGame();
    await settle();
    void hostDriver.dispatch({ type: 'startRound' });
    await settle();
    expect(g1Driver).not.toBeNull();

    // g1 が別 peerId で再入室（localStorage の playerKey は同じ 'g1'）
    const g1b = hub.create('g1bPeer');
    const [, onStart2] = g1b.makeAction<StartMsg>(NS.start);
    const [, onSnap2] = g1b.makeAction<SnapshotMsg>(NS.snap);
    const [sHello2] = g1b.makeAction<{ pk: string; name: string }>(NS.hello);
    let gotStart = false;
    let snap2: SnapshotMsg | null = null;
    onStart2(() => (gotStart = true));
    onSnap2((m) => (snap2 = m));
    sHello2({ pk: 'g1', name: 'G1' });
    await settle();

    expect(gotStart).toBe(true); // 席確定のため start を再送
    expect(snap2).not.toBeNull();
    expect((snap2 as unknown as SnapshotMsg).view.hand.length).toBe(7); // 最新スナップショットで復帰

    hostS.dispose();
    g1S.dispose();
  });
});
