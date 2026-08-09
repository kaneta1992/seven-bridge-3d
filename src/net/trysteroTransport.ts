// Trystero（WebRTC P2P・公共シグナリング）を Transport 境界へ写像する唯一の場所。
// ここ以外は trystero に依存しない。デフォルト strategy（Nostr）を使い、GitHub Pages（静的HTTPS）で動作する。
// 独自シグナリングサーバーは導入しない（契約03）。
import { joinRoom, selfId } from 'trystero';
import { APP_ID, type Sender, type Receiver, type Transport } from './protocol';

/**
 * ルームコードで部屋へ参加し Transport を返す。
 * appId で名前空間を切り、roomId=コード、password=コードで E2E 暗号化する
 * （コードを知る者だけが復号でき、他ルームと混線しない）。
 */
export function createTrysteroTransport(code: string): Transport {
  const room = joinRoom({ appId: APP_ID, password: code }, code);

  return {
    selfId,
    makeAction<T>(namespace: string): [Sender<T>, Receiver<T>] {
      // trystero の makeAction は DataPayload 制約を持つが、本アプリのメッセージは JSON オブジェクト。
      // Transport 境界側（protocol.ts）が実際の型を担保するため、ここは緩く受ける。
      const [send, receive] = (room.makeAction as unknown as (
        ns: string,
      ) => [
        (data: T, target?: string | string[] | null) => Promise<unknown>,
        (fn: (data: T, peerId: string) => void) => void,
      ])(namespace);
      const sender: Sender<T> = (data, target) => {
        // 送信失敗（ピア未接続など）は致命ではない: 次スナップショット/再接続で収束する。
        void Promise.resolve(send(data, target ?? null)).catch(() => undefined);
      };
      const receiver: Receiver<T> = (fn) => receive((data, peerId) => fn(data, peerId));
      return [sender, receiver];
    },
    onPeerJoin: (fn) => room.onPeerJoin(fn),
    onPeerLeave: (fn) => room.onPeerLeave(fn),
    getPeers: () => Object.keys(room.getPeers()),
    leave: () => {
      void Promise.resolve(room.leave()).catch(() => undefined);
    },
  };
}
