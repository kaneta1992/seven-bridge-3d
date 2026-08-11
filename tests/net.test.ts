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
import { LobbyLink } from '../src/net/lobbyChannel';
import {
  NS,
  sanitizeHello,
  sanitizeRoomAd,
  type HelloMsg,
  type Receiver,
  type RoomAd,
  type Sender,
  type SnapshotMsg,
  type StartMsg,
  type Transport,
} from '../src/net/protocol';
import { NetSession } from '../src/net/session';
import { MockHub, MockNode, settle } from './netHelpers';

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
    // 再束縛トークンを明示注入（同一ブラウザの再接続を模す。localStorage 非依存で決定的にする・項目1）。
    const g1S = NetSession.guest('ABC237', 'g1', 'G1', g1T, null, 'tokG1');
    let g1Driver: GameDriver | null = null;
    g1S.on('started', (d) => (g1Driver = d));

    await settle();
    const hostDriver = hostS.startGame();
    await settle();
    void hostDriver.dispatch({ type: 'startRound' });
    await settle();
    expect(g1Driver).not.toBeNull();

    // g1 が別 peerId で再入室（playerKey も再束縛トークンも同じ 'g1'/'tokG1'）
    const g1b = hub.create('g1bPeer');
    const [, onStart2] = g1b.makeAction<StartMsg>(NS.start);
    const [, onSnap2] = g1b.makeAction<SnapshotMsg>(NS.snap);
    const [sHello2] = g1b.makeAction<HelloMsg>(NS.hello);
    let gotStart = false;
    let snap2: SnapshotMsg | null = null;
    onStart2(() => (gotStart = true));
    onSnap2((m) => (snap2 = m));
    sHello2({ pk: 'g1', name: 'G1', token: 'tokG1' });
    await settle();

    expect(gotStart).toBe(true); // 席確定のため start を再送
    expect(snap2).not.toBeNull();
    expect((snap2 as unknown as SnapshotMsg).view.hand.length).toBe(7); // 最新スナップショットで復帰

    hostS.dispose();
    g1S.dispose();
  });

  it('席乗っ取り拒否: 盗んだ pk でも再束縛トークンが不一致な Hello はホストに黙殺される（項目1）', async () => {
    const hub = new MockHub();
    const hostT = hub.create('hostPeer');
    const g1T = hub.create('g1Peer');
    const hostS = NetSession.host('ABC239', 'h', 'H', hostT, { maxPlayers: 4, totalRounds: 1 });
    const g1S = NetSession.guest('ABC239', 'g1', 'G1', g1T, null, 'tokG1');
    let g1Driver: GameDriver | null = null;
    g1S.on('started', (d) => (g1Driver = d));

    await settle();
    const hostDriver = hostS.startGame();
    await settle();
    void hostDriver.dispatch({ type: 'startRound' });
    await settle();
    expect(g1Driver).not.toBeNull();

    // 攻撃者が g1 の公開 pk を盗み、別 peer から誤ったトークンで席の再束縛を試みる。
    const evil = hub.create('evilPeer');
    const [, onEvilStart] = evil.makeAction<StartMsg>(NS.start);
    const [, onEvilSnap] = evil.makeAction<SnapshotMsg>(NS.snap);
    const [sEvilHello] = evil.makeAction<HelloMsg>(NS.hello);
    let evilStart = false;
    let evilSnap: SnapshotMsg | null = null;
    onEvilStart(() => (evilStart = true));
    onEvilSnap((m) => (evilSnap = m));
    sEvilHello({ pk: 'g1', name: 'EVIL', token: 'WRONG' });
    await settle();

    // トークン不一致 → 束縛・start 再送・スナップショットのいずれも起きない（黙殺）。
    expect(evilStart).toBe(false);
    expect(evilSnap).toBeNull();

    // 正規 g1 は同トークンでの再接続なら引き続き復帰できる（対照）。
    const g1b = hub.create('g1bPeer');
    const [, onStart2] = g1b.makeAction<StartMsg>(NS.start);
    const [sHello2] = g1b.makeAction<HelloMsg>(NS.hello);
    let gotStart = false;
    onStart2(() => (gotStart = true));
    sHello2({ pk: 'g1', name: 'G1', token: 'tokG1' });
    await settle();
    expect(gotStart).toBe(true);

    hostS.dispose();
    g1S.dispose();
  });

  it('復帰: recover は接続生存中なら再アナウンスのみで冪等（二重join/名簿重複なし・E3/E9）', async () => {
    const hub = new MockHub();
    const hostT = hub.create('hostPeer');
    const g1T = hub.create('g1Peer');
    const hostS = NetSession.host('ABC238', 'h', 'H', hostT, { maxPlayers: 6, totalRounds: 1 });
    const g1S = NetSession.guest('ABC238', 'g1', 'G1', g1T);
    let roster: { pk: string }[] = [];
    hostS.on('roster', (m) => (roster = m));

    await settle();
    expect(roster.map((m) => m.pk).sort()).toEqual(['g1', 'h']);

    // 接続生存中（ピア有）の復帰: 別セッションを個別に一度だけ recover → 再announceのみ。
    g1S.recover();
    hostS.recover();
    await settle();
    // 名簿は重複せず 2 人のまま（冪等）。reconnect 未注入なのでトランスポートは張り替わらない。
    expect(roster.map((m) => m.pk).sort()).toEqual(['g1', 'h']);
    expect((hostT as MockNode).left).toBe(false);
    expect((g1T as MockNode).left).toBe(false);

    hostS.dispose();
    g1S.dispose();
  });

  it('遅延参加: ゲストが先に待機し、ホストが後から現れると参加が成立する（モバイルURL共有・契約22項目2）', async () => {
    const hub = new MockHub();
    // ゲストが先に部屋へ入る（ホストは共有URL送信中でまだ不在＝バックグラウンド相当）。
    const g1T = hub.create('g1Peer');
    let joined = false;
    let err = '';
    const g1S = NetSession.guest('ABC241', 'g1', 'G1', g1T, null, 'tokG1', { intervalMs: 5, maxMs: 5000 });
    g1S.on('roster', () => (joined = true));
    g1S.on('error', (m) => (err = m));

    await settle();
    expect(joined).toBe(false); // ホスト不在では参加できないが、エラーにもしない（待機継続）
    expect(err).toBe('');

    // ホストが後から現れる（共有シート/バックグラウンドからの復帰相当）。
    const hostT = hub.create('hostPeer');
    const hostS = NetSession.host('ABC241', 'h', 'H', hostT, { maxPlayers: 4, totalRounds: 1 });
    await settle();
    expect(joined).toBe(true); // ホスト出現の瞬間に名簿を受信＝遅延参加が成立
    expect(err).toBe('');

    hostS.dispose();
    g1S.dispose();
  });

  it('リトライ待機: ホスト不在でも Hello を再送しつつ待ち、最大待機を超えて初めてエラー（15秒一発ではない・契約22項目2）', async () => {
    const hub = new MockHub();
    const g1T = hub.create('g1Peer');
    // Hello を観測する受け身のピア（ホストではない＝roster/start を送らないので latch されない）。
    const spyT = hub.create('spyPeer');
    const [, onHello] = spyT.makeAction<HelloMsg>(NS.hello);
    let hellos = 0;
    onHello(() => hellos++);

    let err = '';
    // maxMs は settle() が消費する実時間より十分大きく取る（wall-clock 基準の締切のため）。
    const g1S = NetSession.guest('ABC242', 'g1', 'G1', g1T, null, 'tokG1', { intervalMs: 8, maxMs: 1000 });
    g1S.on('error', (m) => (err = m));

    // 初期 Hello + 複数回の再送が観測ピアへ届く（待機を継続している証拠）。締切前なのでエラーは出ない。
    await new Promise((r) => setTimeout(r, 80));
    await settle(6);
    expect(hellos).toBeGreaterThanOrEqual(2);
    expect(err).toBe(''); // まだ待機中（旧15秒一発では諦めていた）

    // 最大待機（1000ms）を超えると最終エラー（ルーム不在/誤コードの最終文言）。
    await new Promise((r) => setTimeout(r, 1050));
    await settle(6);
    expect(err).toContain('ホスト');

    g1S.dispose();
  });
});

describe('LobbyLink 公開ロビー（固定チャネル広告）', () => {
  it('広告は {code,hostName,count,rounds} の4項目のみが伝わり、余分な項目は載らない（E5-lobby）', async () => {
    const hub = new MockHub();
    const advT = hub.create('advPeer');
    const viewT = hub.create('viewPeer');
    const adv = new LobbyLink(advT);
    const view = new LobbyLink(viewT);
    // 汚染広告（手札や個人情報を模した余分フィールド）を送っても、送受信でサニタイズされる。
    adv.startAdvertising(
      () => ({ code: 'ABC234', hostName: 'H', count: 2, rounds: 4, secret: 'x', hand: [1, 2] }) as unknown as RoomAd,
    );
    await settle();
    const rooms = view.getRooms();
    expect(rooms.length).toBe(1);
    expect(Object.keys(rooms[0]!).sort()).toEqual(['code', 'count', 'hostName', 'rounds']);
    expect(rooms[0]).toEqual({ code: 'ABC234', hostName: 'H', count: 2, rounds: 4 });

    adv.dispose();
    view.dispose();
  });

  it('TTL 失効で一覧から消える（開始/解散/満員での広告停止＝自然消滅・E1）', async () => {
    const hub = new MockHub();
    const advT = hub.create('advPeer');
    const viewT = hub.create('viewPeer');
    let clock = 1000;
    const view = new LobbyLink(viewT, { now: () => clock });
    const adv = new LobbyLink(advT);
    adv.startAdvertising(() => ({ code: 'ABC234', hostName: 'H', count: 2, rounds: 4 }));
    await settle();
    expect(view.getRooms().length).toBe(1);

    // 広告停止（対局開始/解散/満員）→ 更新が止まり TTL 経過で失効。
    adv.stopAdvertising();
    clock += 9000; // AD_TTL_MS(8000) 超過
    expect(view.getRooms().length).toBe(0);

    adv.dispose();
    view.dispose();
  });

  it('sanitizeRoomAd: 不正コード/型不一致は破棄し、人数・ラウンドは範囲内へ丸める（E4）', () => {
    expect(sanitizeRoomAd({ code: 'bad', hostName: 'H', count: 2, rounds: 4 })).toBeNull();
    expect(sanitizeRoomAd({ code: 'ABC234', hostName: 'H', count: 99, rounds: 0 })).toEqual({
      code: 'ABC234',
      hostName: 'H',
      count: 6,
      rounds: 1,
    });
    expect(sanitizeRoomAd(null)).toBeNull();
  });

  it('受信広告は送信 peer ごとに最新1件・全体上限50件で管理する（溢れ防御・項目4）', () => {
    // recv を捕捉できる最小トランスポートで、任意の送信 peer から onAd を直接駆動する。
    let recvFn: ((raw: unknown, peer: string) => void) | null = null;
    const transport: Transport = {
      selfId: 'viewer',
      makeAction: <T,>(_ns: string): [Sender<T>, Receiver<T>] => [
        () => {},
        (fn) => {
          recvFn = fn as unknown as (raw: unknown, peer: string) => void;
        },
      ],
      onPeerJoin: () => {},
      onPeerLeave: () => {},
      getPeers: () => [],
      leave: () => {},
    };
    const view = new LobbyLink(transport);
    const code = (i: number) => `ROOM${String(i).padStart(2, '0')}`; // 6桁の妥当コード
    // 60 の異なる peer が各々別コードを広告 → 上限50件で頭打ち（超過10件は破棄）。
    for (let i = 0; i < 60; i++) recvFn!({ code: code(i), hostName: 'H', count: 1, rounds: 1 }, `peer${i}`);
    expect(view.getRooms().length).toBe(50);

    // 同一 peer が別コードを広告 → 件数は増えず、その peer の最新1件へ置き換わる。
    recvFn!({ code: code(0), hostName: 'H', count: 1, rounds: 1 }, 'peer0'); // peer0 の元コード
    recvFn!({ code: 'ZZZ999', hostName: 'H', count: 1, rounds: 1 }, 'peer0'); // 最新へ差し替え
    const rooms = view.getRooms();
    expect(rooms.length).toBe(50); // 件数は不変（peer 単位）
    expect(rooms.some((r) => r.code === 'ZZZ999')).toBe(true);
    expect(rooms.some((r) => r.code === code(0))).toBe(false); // 古いコードは残らない
    view.dispose();
  });
});

describe('sanitizeHello 入力検証（契約10項目3）', () => {
  it('正当な Hello は pk/name/token を通し、不正は破棄、name は10文字slice・制御文字除去', () => {
    expect(sanitizeHello({ pk: 'g1_-A9', name: 'ゲスト', token: 'tok' })).toEqual({
      pk: 'g1_-A9',
      name: 'ゲスト',
      token: 'tok',
    });
    expect(sanitizeHello({ pk: 'bad pk!', name: 'G', token: 't' })).toBeNull(); // 記号/空白は不可
    expect(sanitizeHello({ pk: 'a'.repeat(65), name: 'G', token: 't' })).toBeNull(); // 64文字超
    expect(sanitizeHello({ pk: 'g1', name: 'G' })).toBeNull(); // token 欠落
    expect(sanitizeHello({ pk: 'g1', name: 'G', token: '' })).toBeNull(); // token 空
    expect(sanitizeHello(null)).toBeNull();
    expect(sanitizeHello({ pk: 'g1', name: 'x'.repeat(30), token: 't' })!.name.length).toBe(10);
    expect(sanitizeHello({ pk: 'g1', name: 'ABC', token: 't' })!.name).toBe('ABC');
    // 制御文字（NUL / 0x1f）は除去される。
    const ctrl = 'A' + String.fromCharCode(0) + 'B' + String.fromCharCode(0x1f) + 'C';
    expect(sanitizeHello({ pk: 'g1', name: ctrl, token: 't' })!.name).toBe('ABC');
  });
});
