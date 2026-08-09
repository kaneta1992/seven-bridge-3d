// 待機ルーム/接続中/致命通知の画面（要件 §3.3-2）。純粋な描画関数群。
// ネットワークのライフサイクルは app.ts（GameUI）が NetSession 経由で管理し、ここは表示だけを担う。
import type { RosterMember } from '../net/protocol';
import { clear, el } from './dom';

export interface WaitingRoomProps {
  code: string;
  members: RosterMember[];
  amHost: boolean;
  maxPlayers: number;
  totalRounds: number;
  canStart: boolean;
  onStart: () => void;
  onLeave: () => void;
}

/** 接続中（ホスト応答待ち）画面。 */
export function renderConnecting(root: HTMLElement, code: string, onCancel: () => void): void {
  clear(root);
  const cancel = el('button', { text: 'キャンセル' });
  cancel.onclick = onCancel;
  const modal = el('div', { class: 'modal' }, [
    el('h1', { text: '接続中…' }),
    el('h2', { text: `ルーム ${code} に接続しています` }),
    el('p', { class: 'hint', text: 'P2P の確立には数秒かかることがあります。' }),
    el('div', { class: 'row' }, [cancel]),
  ]);
  root.append(el('div', { class: 'center' }, [modal]));
}

/** 待機ルーム画面（名簿・コード共有・ホストの開始）。 */
export function renderWaitingRoom(root: HTMLElement, p: WaitingRoomProps): void {
  clear(root);
  const list = el('div', { class: 'melds' });
  p.members.forEach((m, i) => {
    const tag = i === 0 ? '（ホスト）' : '';
    list.append(el('div', { class: 'meld' }, [el('span', { class: 'owner', text: `${i + 1}. ${m.name}${tag}` })]));
  });
  for (let i = p.members.length; i < p.maxPlayers; i++) {
    list.append(el('div', { class: 'meld' }, [el('span', { class: 'hint', text: `${i + 1}. 空席` })]));
  }

  const codeBox = el('div', { class: 'pill', text: p.code });
  (codeBox as HTMLElement).style.fontSize = '28px';
  (codeBox as HTMLElement).style.letterSpacing = '6px';
  (codeBox as HTMLElement).style.fontWeight = '800';

  const copyBtn = el('button', { text: 'コードをコピー' });
  copyBtn.onclick = () => {
    void navigator.clipboard?.writeText(p.code).catch(() => undefined);
    copyBtn.textContent = 'コピーしました';
  };

  const actions = el('div', { class: 'row' });
  if (p.amHost) {
    const start = el('button', { class: 'primary', text: '対局開始' }) as HTMLButtonElement;
    start.disabled = !p.canStart;
    start.onclick = p.onStart;
    actions.append(start);
    if (!p.canStart) actions.append(el('span', { class: 'hint', text: '2人以上そろうと開始できます。' }));
  } else {
    actions.append(el('span', { class: 'hint', text: 'ホストの開始をお待ちください…' }));
  }
  const leave = el('button', { text: '退室' });
  leave.onclick = p.onLeave;
  actions.append(leave);

  const modal = el('div', { class: 'modal' }, [
    el('h1', { text: '待機ルーム' }),
    el('div', { class: 'row' }, [el('label', { text: 'ルームコード' }), codeBox, copyBtn]),
    el('h2', { text: `参加者 ${p.members.length}/${p.maxPlayers}・${p.totalRounds}ラウンド` }),
    list,
    actions,
  ]);
  root.append(el('div', { class: 'center' }, [modal]));
}

/** 致命通知（ホスト切断・接続失敗など）画面。 */
export function renderNotice(root: HTMLElement, title: string, message: string, onBack: () => void): void {
  clear(root);
  const back = el('button', { class: 'primary', text: 'ロビーに戻る' });
  back.onclick = onBack;
  const modal = el('div', { class: 'modal' }, [
    el('h1', { text: title }),
    el('h2', { text: message }),
    el('div', { class: 'row' }, [back]),
  ]);
  root.append(el('div', { class: 'center' }, [modal]));
}
