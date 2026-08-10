// P2P セッション（契約03）: トランスポートの生成・全メッセージ配線・待機ルーム名簿・
// 開始ハンドシェイク・再接続・ホスト切断検知を1か所に集約する。
// ドライバ（HostDriver/GuestDriver）はここから注入された送信関数だけで通信し、
// 受信ルーティングと peerId↔playerKey 束縛（E7/E8）はこのセッションが担う。
import type { GameDriver } from '../driver/types';
import { HostDriver } from './hostDriver';
import { GuestDriver } from './guestDriver';
import {
  JOIN_TIMEOUT_MS,
  loadOrCreateRebindToken,
  NS,
  sanitizeHello,
  type AckMsg,
  type ActionMsg,
  type ErrMsg,
  type HelloMsg,
  type RejectMsg,
  type RosterMember,
  type RosterMsg,
  type SnapshotMsg,
  type StartMsg,
  type Transport,
} from './protocol';

export interface SessionEvents {
  /** 待機ルーム名簿の更新（開始前）。 */
  roster: (members: RosterMember[], amHost: boolean, info: { code: string; maxPlayers: number; totalRounds: number }) => void;
  /** 対局開始（ドライバ準備完了）。 */
  started: (driver: GameDriver) => void;
  /** 接続失敗など（開始前・リトライ可能）。 */
  error: (message: string) => void;
  /** 続行不能（ホスト切断など・D5）。 */
  fatal: (message: string) => void;
}

interface HostOpts {
  maxPlayers: number;
  totalRounds: number;
}

export class NetSession {
  readonly role: 'host' | 'guest';
  readonly code: string;
  private readonly selfPk: string;
  /** 秘匿再束縛トークン（席乗っ取り対策・契約10項目1）。Hello にのみ載せ、公開メッセージには載せない。 */
  private readonly selfToken: string;
  private readonly name: string;
  private transport: Transport;
  /** 復帰時の再join用トランスポート生成器（本番のみ注入。テストは省略＝再announceのみ）。 */
  private readonly reconnect: (() => Transport) | null;
  private lastRecoverAt = 0;
  private handlers: Partial<SessionEvents> = {};

  // 送信関数（namespace ごとに1回だけ生成）
  private sendHello!: (m: HelloMsg, t?: string | null) => void;
  private sendRoster!: (m: RosterMsg, t?: string | null) => void;
  private sendStart!: (m: StartMsg, t?: string | null) => void;
  private sendSnap!: (m: SnapshotMsg, t?: string | null) => void;
  private sendAct!: (m: ActionMsg, t?: string | null) => void;
  private sendErr!: (m: ErrMsg, t?: string | null) => void;
  private sendAck!: (m: AckMsg, t?: string | null) => void;
  private sendReject!: (m: RejectMsg, t?: string | null) => void;

  // ホスト状態
  private hostOpts: HostOpts | null = null;
  private roster: RosterMember[] = [];
  private peerToPk = new Map<string, string>();
  private pkToPeer = new Map<string, string>();
  /** pk → 初回束縛時に記録した秘匿トークン。既知 pk の再束縛はこの値と一致する Hello のみ許可（項目1）。 */
  private pkToToken = new Map<string, string>();
  private started = false;
  private hostDriver: HostDriver | null = null;

  // ゲスト状態
  private hostPeerId: string | null = null;
  private guestDriver: GuestDriver | null = null;
  private snapBuffer: SnapshotMsg[] = [];
  private joinTimer = 0;
  private done = false;

  private constructor(
    role: 'host' | 'guest',
    code: string,
    selfPk: string,
    selfToken: string,
    name: string,
    transport: Transport,
    reconnect: (() => Transport) | null,
  ) {
    this.role = role;
    this.code = code;
    this.selfPk = selfPk;
    this.selfToken = selfToken;
    this.name = name;
    this.transport = transport;
    this.reconnect = reconnect;
    this.wire();
  }

  static host(
    code: string,
    selfPk: string,
    name: string,
    transport: Transport,
    opts: HostOpts,
    reconnect: (() => Transport) | null = null,
    selfToken: string = loadOrCreateRebindToken(code),
  ): NetSession {
    const s = new NetSession('host', code, selfPk, selfToken, name, transport, reconnect);
    s.hostOpts = opts;
    s.roster = [{ pk: selfPk, name }];
    // ホスト自身の pk は自トークンで初回束縛済みとみなす（自席は誰にも再束縛させない）。
    s.pkToToken.set(selfPk, selfToken);
    return s;
  }

  static guest(
    code: string,
    selfPk: string,
    name: string,
    transport: Transport,
    reconnect: (() => Transport) | null = null,
    selfToken: string = loadOrCreateRebindToken(code),
  ): NetSession {
    const s = new NetSession('guest', code, selfPk, selfToken, name, transport, reconnect);
    s.armJoinTimeout();
    // ホストがいつ接続しても identity を拾えるよう、参加時と各ピア接続時に hello を送る。
    s.sendHello({ pk: selfPk, name, token: selfToken });
    return s;
  }

  on<K extends keyof SessionEvents>(event: K, fn: SessionEvents[K]): void {
    this.handlers[event] = fn;
  }

  /** ホスト: 対局を開始する（待機ルームの名簿で席を確定して配る）。 */
  startGame(): HostDriver {
    if (this.role !== 'host' || !this.hostOpts) throw new Error('startGame: host only');
    if (this.hostDriver) return this.hostDriver;
    // 人数ガード（項目5）: 2人未満での開始を拒否する。UI の活性制御だけに依存しない防御。
    // 呼び出し側（app.ts）は開始前にトーストで理由を提示するため、ここに到達するのは誤用のみ。
    if (this.roster.length < 2) throw new Error('startGame: need at least 2 players');
    const players = this.roster.map((m) => ({ id: m.pk, name: m.name }));
    this.started = true;
    this.hostDriver = new HostDriver({
      players,
      selfPk: this.selfPk,
      totalRounds: this.hostOpts.totalRounds,
      resolvePeer: (pk) => (pk === this.selfPk ? null : (this.pkToPeer.get(pk) ?? null)),
      resolvePk: (peerId) => this.peerToPk.get(peerId) ?? null,
      sendSnap: (peerId, msg) => this.sendSnap(msg, peerId),
      sendErr: (peerId, msg) => this.sendErr(msg, peerId),
      sendAck: (peerId, msg) => this.sendAck(msg, peerId),
    });
    this.sendStart({ players, totalRounds: this.hostOpts.totalRounds });
    this.handlers.started?.(this.hostDriver);
    return this.hostDriver;
  }

  /**
   * バックグラウンド復帰時の接続自動回復（契約08項目1）。
   * document.visibilitychange / pageshow / online から呼ぶ。冪等（E3）:
   *   - 接続生存（ピア有）: 再アナウンスのみ（二重joinしない）
   *   - 接続喪失（ピア無）かつ再join生成器あり: トランスポートを張り替えて再配線し再アナウンス
   * 連打（フォーカス往復）はデバウンスで抑制する（E9追補）。
   */
  recover(): void {
    if (this.done) return;
    const now = Date.now();
    if (now - this.lastRecoverAt < 1500) return;
    this.lastRecoverAt = now;
    const alive = this.transport.getPeers().length > 0;
    if (!alive && this.reconnect) this.rejoin();
    else this.reannounce();
  }

  /** トランスポートを新規生成に張り替え、受信/送信を再配線する（旧接続は leave）。 */
  private rejoin(): void {
    const old = this.transport;
    this.transport = this.reconnect!();
    this.wire(); // 新トランスポートで sendXxx/受信/onPeerJoin を貼り直す（ハンドシェイクが束縛を再構築）
    old.leave();
    this.reannounce();
  }

  /** 名簿/identity を再送し、ホストは最新スナップショットを再配信する。 */
  private reannounce(): void {
    if (this.role === 'guest') {
      this.sendHello({ pk: this.selfPk, name: this.name, token: this.selfToken });
    } else {
      this.broadcastRoster();
      if (this.started) this.hostDriver?.resendAll();
    }
  }

  /** リソース解放（対局終了/退室時・E9）。 */
  dispose(): void {
    if (this.done) return;
    this.done = true;
    if (this.joinTimer) clearTimeout(this.joinTimer);
    this.hostDriver?.dispose();
    this.guestDriver?.dispose();
    this.transport.leave();
  }

  // ---- 配線 -------------------------------------------------------------

  private wire(): void {
    const [sHello, rHello] = this.transport.makeAction<HelloMsg>(NS.hello);
    const [sRoster, rRoster] = this.transport.makeAction<RosterMsg>(NS.roster);
    const [sStart, rStart] = this.transport.makeAction<StartMsg>(NS.start);
    const [sSnap, rSnap] = this.transport.makeAction<SnapshotMsg>(NS.snap);
    const [sAct, rAct] = this.transport.makeAction<ActionMsg>(NS.act);
    const [sErr, rErr] = this.transport.makeAction<ErrMsg>(NS.err);
    const [sAck, rAck] = this.transport.makeAction<AckMsg>(NS.ack);
    const [sReject, rReject] = this.transport.makeAction<RejectMsg>(NS.reject);
    this.sendHello = sHello;
    this.sendRoster = sRoster;
    this.sendStart = sStart;
    this.sendSnap = sSnap;
    this.sendAct = sAct;
    this.sendErr = sErr;
    this.sendAck = sAck;
    this.sendReject = sReject;

    if (this.role === 'host') {
      rHello((m, peer) => this.onHello(m, peer));
      rAct((m, peer) => this.hostDriver?.handleAction(m, peer));
      this.transport.onPeerJoin((peer) => this.onHostPeerJoin(peer));
      this.transport.onPeerLeave((peer) => this.onHostPeerLeave(peer));
    } else {
      rRoster((m, peer) => this.onRoster(m, peer));
      rStart((m, peer) => this.onStart(m, peer));
      rSnap((m, peer) => this.onSnap(m, peer));
      rErr((m, peer) => this.onErr(m, peer));
      rAck((m, peer) => this.onAck(m, peer));
      rReject((m, peer) => this.onReject(m, peer));
      this.transport.onPeerJoin(() => this.sendHello({ pk: this.selfPk, name: this.name, token: this.selfToken }));
      this.transport.onPeerLeave((peer) => this.onGuestPeerLeave(peer));
    }
  }

  // ---- ホスト側 ---------------------------------------------------------

  private onHostPeerJoin(_peer: string): void {
    // 新規ピアへ現在の名簿を送る（相手はまだ hello 未送信でも公開情報なので可）。
    this.broadcastRoster();
  }

  private onHello(raw: HelloMsg, peer: string): void {
    // 入力検証（項目3）: 書式不正・トークン欠落の Hello は黙殺。
    const m = sanitizeHello(raw);
    if (!m) return;

    // 秘匿トークン照合（席乗っ取り対策・項目1）:
    //   - 未束縛の pk: 初回束縛としてトークンを記録する。
    //   - 既知の pk: 記録済みトークンと一致する Hello のみ再束縛を許可し、不一致は黙殺する
    //     （公開される pk を盗んでも、Hello にしか載らないトークンが無ければ席を奪えない）。
    const knownToken = this.pkToToken.get(m.pk);
    if (knownToken === undefined) {
      this.pkToToken.set(m.pk, m.token);
    } else if (knownToken !== m.token) {
      return; // なりすまし: 束縛・名簿・スナップショットのいずれも変更しない
    }

    // peerId↔playerKey を最新束縛に更新（残存/二重接続は最新へ張り替え・E8）。トークン照合を通過済み。
    const prevPeer = this.pkToPeer.get(m.pk);
    if (prevPeer && prevPeer !== peer) this.peerToPk.delete(prevPeer);
    this.peerToPk.set(peer, m.pk);
    this.pkToPeer.set(m.pk, peer);

    const known = this.roster.some((r) => r.pk === m.pk);
    if (this.started) {
      if (known) {
        // 再接続: 席を確定させる start を送り直し、最新スナップショットで復帰（要件§3.1）。
        this.sendStart(
          { players: this.roster.map((r) => ({ id: r.pk, name: r.name })), totalRounds: this.hostOpts!.totalRounds },
          peer,
        );
        this.hostDriver?.resend(peer, m.pk);
      } else {
        this.sendReject({ reason: '対局はすでに開始しています（途中参加はできません）' }, peer);
      }
      return;
    }
    // 待機ルーム
    if (!known) {
      if (this.roster.length >= this.hostOpts!.maxPlayers) {
        this.sendReject({ reason: 'ルームは満員です' }, peer);
        return;
      }
      this.roster.push({ pk: m.pk, name: m.name });
    } else {
      // 名前更新（再入室）
      const r = this.roster.find((x) => x.pk === m.pk);
      if (r) r.name = m.name;
    }
    this.broadcastRoster();
    this.emitRoster();
  }

  private onHostPeerLeave(peer: string): void {
    const pk = this.peerToPk.get(peer);
    this.peerToPk.delete(peer);
    if (pk && this.pkToPeer.get(pk) === peer) this.pkToPeer.delete(pk);
    if (!pk) return;
    if (!this.started) {
      // 開始前の離脱: 名簿から外して更新（E2）。
      this.roster = this.roster.filter((r) => r.pk !== pk);
      this.broadcastRoster();
      this.emitRoster();
    }
    // 開始後の離脱: 席は維持（復帰待ち）。手番は進めず、鳴きタイマーのみホストが進める（E2）。
  }

  private broadcastRoster(): void {
    if (!this.hostOpts) return;
    this.sendRoster({
      code: this.code,
      hostPk: this.selfPk,
      maxPlayers: this.hostOpts.maxPlayers,
      totalRounds: this.hostOpts.totalRounds,
      members: this.roster,
      started: this.started,
    });
  }

  private emitRoster(): void {
    if (!this.hostOpts) return;
    this.handlers.roster?.([...this.roster], true, {
      code: this.code,
      maxPlayers: this.hostOpts.maxPlayers,
      totalRounds: this.hostOpts.totalRounds,
    });
  }

  // ---- ゲスト側 ---------------------------------------------------------

  private armJoinTimeout(): void {
    this.joinTimer = (globalThis.setTimeout ?? setTimeout)(() => {
      if (!this.hostPeerId && !this.done) {
        this.handlers.error?.('ホストに接続できませんでした。ルームコードを確認して再試行してください。');
      }
    }, JOIN_TIMEOUT_MS) as unknown as number;
  }

  /**
   * ホストの先着束縛（席乗っ取り対策・項目2）。最初に権威メッセージ（Roster/Start）を送ってきた
   * peer を hostPeerId として固定し、以後は別 peer からの権威メッセージを無視する。
   * 残余リスク: 正規ホストより先に偽ホストが最初の Roster/Start を届ける「先着レース」は、
   * P2P の到着順に依存するため本方式では防げない（この段では修正しない・契約10）。
   */
  private latchHost(peer: string): boolean {
    if (this.hostPeerId === null) {
      this.hostPeerId = peer;
      return true;
    }
    return peer === this.hostPeerId;
  }

  /** 固定済みホスト以外からの権威メッセージ（Snapshot/Err/Ack/Reject）を弾く。未固定なら受理（Roster/Start 前）。 */
  private fromHost(peer: string): boolean {
    return this.hostPeerId === null || peer === this.hostPeerId;
  }

  private onRoster(m: RosterMsg, peer: string): void {
    if (!this.latchHost(peer)) return; // 別 peer を騙る Roster は無視
    if (this.joinTimer) clearTimeout(this.joinTimer);
    if (m.started) return; // 開始後の名簿は無視（対局はスナップショットで駆動）
    this.handlers.roster?.([...m.members], false, {
      code: m.code,
      maxPlayers: m.maxPlayers,
      totalRounds: m.totalRounds,
    });
  }

  private onStart(m: StartMsg, peer: string): void {
    if (!this.latchHost(peer)) return; // 別 peer を騙る Start は無視
    if (this.joinTimer) clearTimeout(this.joinTimer);
    if (!this.guestDriver) {
      this.guestDriver = new GuestDriver({
        selfPk: this.selfPk,
        players: m.players,
        totalRounds: m.totalRounds,
        sendAct: (msg) => this.sendAct(msg, this.hostPeerId),
      });
      // 開始メッセージより先に届いたスナップショットを反映（最新1件のみ保持済み）。
      for (const s of this.snapBuffer) this.guestDriver.applySnapshot(s);
      this.snapBuffer = [];
      this.handlers.started?.(this.guestDriver);
    }
  }

  private onSnap(m: SnapshotMsg, peer: string): void {
    if (!this.fromHost(peer)) return; // 固定済みホスト以外のスナップショットは無視（項目2）
    if (this.guestDriver) this.guestDriver.applySnapshot(m);
    // start より先に来たスナップショットは最新1件（seq 最大）のみ保持（項目6・古い到着で上書きしない）。
    else if (this.snapBuffer.length === 0 || m.seq > this.snapBuffer[0]!.seq) this.snapBuffer = [m];
  }

  private onErr(m: ErrMsg, peer: string): void {
    if (!this.fromHost(peer)) return;
    this.guestDriver?.applyError(m.reqId, m.message);
  }

  private onAck(m: AckMsg, peer: string): void {
    if (!this.fromHost(peer)) return;
    this.guestDriver?.applyAck(m.reqId);
  }

  private onReject(m: RejectMsg, peer: string): void {
    if (!this.fromHost(peer)) return;
    if (this.joinTimer) clearTimeout(this.joinTimer);
    this.handlers.error?.(m.reason);
  }

  private onGuestPeerLeave(peer: string): void {
    if (peer !== this.hostPeerId) return;
    if (this.guestDriver) this.handlers.fatal?.('ホストが切断しました。ゲームを続行できません。');
    else this.handlers.error?.('ホストが切断しました。');
  }
}
