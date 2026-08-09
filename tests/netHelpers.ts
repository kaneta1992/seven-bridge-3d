// テスト用インメモリ・トランスポート（*.test.ts ではないので Vitest には拾われない）。
// 実 WebRTC なしで複数ピアを1プロセス内で接続し、ホスト権威ロジックとセッション配線を検証する。
// 実配信を模して、送信データは JSON ラウンドトリップし、配送は非同期（setTimeout 0）で行う。
import type { Sender, Receiver, Transport } from '../src/net/protocol';

export class MockHub {
  readonly nodes = new Map<string, MockNode>();

  create(id: string): MockNode {
    const existing = [...this.nodes.keys()].filter((k) => !this.nodes.get(k)!.left);
    const node = new MockNode(id, this);
    this.nodes.set(id, node);
    for (const other of existing) {
      const o = this.nodes.get(other)!;
      setTimeout(() => {
        o.joinFns.forEach((f) => f(id));
        node.joinFns.forEach((f) => f(other));
      }, 0);
    }
    return node;
  }

  peersOf(id: string): string[] {
    return [...this.nodes.keys()].filter((k) => k !== id && !this.nodes.get(k)!.left);
  }

  remove(id: string): void {
    this.nodes.delete(id);
    for (const o of this.nodes.values()) setTimeout(() => o.leaveFns.forEach((f) => f(id)), 0);
  }
}

export class MockNode implements Transport {
  readonly selfId: string;
  private hub: MockHub;
  private receivers = new Map<string, (data: unknown, peerId: string) => void>();
  joinFns: ((p: string) => void)[] = [];
  leaveFns: ((p: string) => void)[] = [];
  left = false;

  constructor(id: string, hub: MockHub) {
    this.selfId = id;
    this.hub = hub;
  }

  makeAction<T>(namespace: string): [Sender<T>, Receiver<T>] {
    const send: Sender<T> = (data, target) => {
      if (this.left) return;
      const targets = target == null ? this.hub.peersOf(this.selfId) : Array.isArray(target) ? target : [target];
      for (const t of targets) {
        const node = this.hub.nodes.get(t);
        if (!node || node.left) continue;
        const clone = JSON.parse(JSON.stringify(data)) as T; // 配線を模した「値渡し」（参照共有を排除）
        setTimeout(() => node.receivers.get(namespace)?.(clone, this.selfId), 0);
      }
    };
    const receive: Receiver<T> = (fn) => {
      this.receivers.set(namespace, (d, p) => fn(d as T, p));
    };
    return [send, receive];
  }

  onPeerJoin(fn: (peerId: string) => void): void {
    this.joinFns.push(fn);
  }
  onPeerLeave(fn: (peerId: string) => void): void {
    this.leaveFns.push(fn);
  }
  getPeers(): string[] {
    return this.hub.peersOf(this.selfId);
  }
  leave(): void {
    if (this.left) return;
    this.left = true;
    this.hub.remove(this.selfId);
  }
}

/** 保留中の非同期配送をすべて排出する（カスケードするため複数ティック回す）。 */
export async function settle(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}
