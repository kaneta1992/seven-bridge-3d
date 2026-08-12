// Trystero（WebRTC P2P・公共シグナリング）を Transport 境界へ写像する唯一の場所。
// ここ以外は trystero に依存しない。デフォルト strategy（Nostr）を使い、GitHub Pages（静的HTTPS）で動作する。
// 独自シグナリングサーバーは導入しない（契約03）。
// 'trystero' の既定 strategy は nostr（index.js は nostr.js の再export）。型定義が完全な
// サブパス 'trystero/nostr' から import する（getRelaySockets の型は index.d.ts に無いため）。
import { getRelaySockets, joinRoom, selfId } from 'trystero/nostr';
import { APP_ID, type Sender, type Receiver, type Transport } from './protocol';

/**
 * Nostr リレーの明示指定（2026-08-10 障害対応）。
 * trystero デフォルトのリレー群に有料化(nfdb.noswhere.com)・I/O障害(nostr.huszonegy.world)が
 * 発生しピア発見が不安定になったため、ブラウザから実測して生存確認済みの無料リレーを指定する。
 * 冗長度5で部分障害に耐える。リレーが劣化したらここを実測し直して更新すること。
 */
const RELAY_URLS = [
  'wss://offchain.pub',
  'wss://nos.lol',
  'wss://relay.snort.social',
  'wss://relay.primal.net',
  'wss://nostr-pub.wellorder.net',
  'wss://nostr.wine',
  'wss://relay.nostr.net',
  'wss://nostr.mom',
];

/**
 * ICE サーバー設定（契約35・2026-08-12 公開ルーム可視性の端末ペア差の根本対応）。
 * - STUN のみだと CGNAT/対称NAT のモバイル同士は WebRTC を確立できず、「ある端末には広告が届き
 *   別の端末には届かない」ペア依存の症状になる。TURN（中継）を最終経路として加える。
 * - TURN は無料公開の Open Relay（Metered）をベストエフォートで指定。死んでいても単に候補が
 *   増えるだけで害はない。
 * - 注入経路の罠: trystero の rtcConfig は simple-peer(@thaunknown) のコンストラクタ opts へ
 *   スプレッドされるが、simple-peer が RTCPeerConnection に渡すのは opts.config のみ。
 *   したがって { config: {...} } の形で包んで渡す必要がある（トップレベル iceServers は無視される）。
 */
const ICE_CONFIG: RTCConfiguration = {
  iceServers: [
    {
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:global.stun.twilio.com:3478',
        'stun:stun.cloudflare.com:3478',
      ],
    },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
        'turns:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
};

/**
 * ルームコードで部屋へ参加し Transport を返す。
 * appId で名前空間を切り、roomId=コード、password=コードで E2E 暗号化する
 * （コードを知る者だけが復号でき、他ルームと混線しない）。
 */
export function createTrysteroTransport(code: string): Transport {
  const room = joinRoom(
    // 冗長度は全リレー: ネットワークごとの到達性差（企業/モバイル網のブロック等）に対する
    // 生存率を最大化する（2026-08-11 公開ルーム不可視の環境差対応）。
    {
      appId: APP_ID,
      password: code,
      relayUrls: RELAY_URLS,
      relayRedundancy: RELAY_URLS.length,
      // simple-peer の opts.config へ届く形で ICE を注入（上の ICE_CONFIG コメント参照）
      rtcConfig: { config: ICE_CONFIG } as unknown as RTCConfiguration,
    },
    code,
  );

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

/**
 * リレー接続状況（診断用・2026-08-11）。接続済み/総数を返す。
 * ロビー画面の診断表示に使い、「リレー0/8」ならネットワークがリレーをブロックしていると判る。
 */
export function relayStatus(): { connected: number; total: number } {
  try {
    const sockets = getRelaySockets();
    const urls = Object.keys(sockets);
    const connected = urls.filter((u) => sockets[u]?.readyState === 1).length;
    return { connected, total: RELAY_URLS.length };
  } catch {
    return { connected: 0, total: RELAY_URLS.length };
  }
}
