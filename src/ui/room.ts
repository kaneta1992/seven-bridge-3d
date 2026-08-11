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
  /** ホスト: NPC（ボット）席を追加（契約16）。満席時は呼び出し側で拒否/トースト。 */
  onAddNpc?: () => void;
  /** ホスト: NPC 席を削除。 */
  onRemoveNpc?: (pk: string) => void;
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
    const tag = i === 0 ? '（ホスト）' : m.npc ? '（NPC）' : '';
    const row = el('div', { class: 'meld' }, [el('span', { class: 'owner', text: `${i + 1}. ${m.name}${tag}` })]);
    // ホストは NPC 席に削除ボタンを出す（人間席は削除不可）。
    if (p.amHost && m.npc && p.onRemoveNpc) {
      const rm = el('button', { class: 'icon', text: '✕', title: 'NPCを削除' }) as HTMLButtonElement;
      rm.onclick = () => p.onRemoveNpc!(m.pk);
      row.append(rm);
    }
    list.append(row);
  });
  for (let i = p.members.length; i < p.maxPlayers; i++) {
    list.append(el('div', { class: 'meld' }, [el('span', { class: 'hint', text: `${i + 1}. 空席` })]));
  }
  // ホスト: NPC 追加（満席では非活性）。
  if (p.amHost && p.onAddNpc) {
    const addNpc = el('button', { text: '＋ NPCを追加' }) as HTMLButtonElement;
    addNpc.disabled = p.members.length >= p.maxPlayers;
    addNpc.onclick = () => p.onAddNpc!();
    list.append(el('div', { class: 'row' }, [addNpc]));
  }

  const codeBox = el('div', { class: 'pill', text: p.code });
  (codeBox as HTMLElement).style.fontSize = '28px';
  (codeBox as HTMLElement).style.letterSpacing = '6px';
  (codeBox as HTMLElement).style.fontWeight = '800';

  // 一時トースト（共有/コピーのフィードバック。待機ルームは GameUI のトーストを持たないため自前で出す）。
  const toastEl = el('div', { class: 'toast' });
  let toastTimer = 0;
  const toast = (msg: string): void => {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2200);
  };

  const copyBtn = el('button', { text: 'コードをコピー' });
  copyBtn.onclick = () => {
    void navigator.clipboard?.writeText(p.code).catch(() => undefined);
    toast('コードをコピーしました');
  };

  // 共有導線（契約08項目4）: 招待URL `origin/path?room=CODE` を Web Share、非対応はクリップボード。
  const shareUrl = `${location.origin}${location.pathname}?room=${p.code}`;
  const shareText = `セブンブリッジ3D で対戦しよう！ ルームコード: ${p.code}`;
  const shareBtn = el('button', { class: 'gold', text: '共有' });
  shareBtn.onclick = () => {
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (typeof nav.share === 'function') {
      void nav.share({ title: 'セブンブリッジ 3D', text: shareText, url: shareUrl }).catch(() => undefined);
      return;
    }
    void navigator.clipboard
      ?.writeText(shareUrl)
      .then(() => toast('招待リンクをコピーしました'))
      .catch(() => toast('コピーできませんでした'));
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
    el('div', { class: 'row' }, [el('label', { text: 'ルームコード' }), codeBox, copyBtn, shareBtn]),
    el('h2', { text: `参加者 ${p.members.length}/${p.maxPlayers}・${p.totalRounds}ラウンド` }),
    list,
    actions,
    el('p', {
      class: 'hint',
      text: 'モバイルで画面を切り替えると一時的に部屋が見えなくなることがあります。戻れば自動で復帰します。',
    }),
  ]);
  root.append(el('div', { class: 'center' }, [modal, toastEl]));
}

/** URL（?room=CODE）参加で保存名が無いときの名前入力（契約08項目4・E2）。 */
export function renderJoinPrompt(
  root: HTMLElement,
  code: string,
  defaultName: string,
  onJoin: (name: string) => void,
  onCancel: () => void,
): void {
  clear(root);
  const input = el('input', { type: 'text', maxlength: '10', value: defaultName, placeholder: 'あなたの名前' }) as HTMLInputElement;
  const join = el('button', { class: 'primary', text: '参加' });
  join.onclick = () => onJoin((input.value.trim() || 'ゲスト').slice(0, 10));
  const cancel = el('button', { text: 'キャンセル' });
  cancel.onclick = onCancel;
  const modal = el('div', { class: 'modal' }, [
    el('h1', { text: 'ルームに参加' }),
    el('h2', { text: `ルームコード ${code}` }),
    el('div', { class: 'field' }, [el('label', { text: 'あなたの名前' }), input]),
    el('div', { class: 'row' }, [join, cancel]),
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
