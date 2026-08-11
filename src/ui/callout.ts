// 大型コールアウト（「ポン！」等）・手番交代バナー・数値カウントアップ。DOM オーバーレイのみで完結し、
// ゲーム進行はブロックしない（pointer-events:none・E2）。縦画面でも中央に成立する（clamp フォント・E3）。
import { el } from './dom';

export type CalloutVariant = 'pon' | 'chi' | 'win' | 'meld' | 'draw-round' | 'go';

export class Callouts {
  private layer: HTMLElement;
  private queue: { text: string; variant: CalloutVariant }[] = [];
  private active = false;
  private banner: HTMLElement | null = null;
  private bannerTimer = 0;
  private timers: number[] = [];

  constructor(container: HTMLElement) {
    this.layer = el('div', { class: 'callout-layer' });
    container.append(this.layer);
  }

  /** 大型コールアウトを表示。連続発火はキューで間引き、重なって読めなくなるのを防ぐ（E9）。 */
  show(text: string, variant: CalloutVariant): void {
    this.queue.push({ text, variant });
    if (!this.active) this.next();
  }

  private next(): void {
    const item = this.queue.shift();
    if (!item) {
      this.active = false;
      return;
    }
    this.active = true;
    // NieR 風の抑制的な意匠（契約21項目8）: 細罫線を上下に走らせ、字間を広げた墨/生成りの文字を
    // マスクワイプで出す。派手さは色ベタでなく「罫線アニメ・字間トラッキング・マスクワイプ」で表す。
    const node = el('div', { class: `callout ${item.variant}` }, [
      el('span', { class: 'rule top' }),
      el('span', { class: 'txt', text: item.text }),
      el('span', { class: 'rule bot' }),
    ]);
    this.layer.append(node);
    // アニメーション終了で除去し、次をわずかな間を置いて表示
    const life = item.variant === 'win' || item.variant === 'go' ? 1700 : 1200;
    this.timers.push(
      window.setTimeout(() => node.classList.add('leaving'), life - 300),
    );
    this.timers.push(
      window.setTimeout(() => {
        node.remove();
        this.timers.push(window.setTimeout(() => this.next(), 140));
      }, life),
    );
  }

  /** 手番交代バナー: 上部から滑り込み、数秒で消える。 */
  showBanner(text: string): void {
    if (!this.banner) {
      this.banner = el('div', { class: 'turn-banner' });
      this.layer.append(this.banner);
    }
    this.banner.textContent = text;
    this.banner.classList.remove('show');
    void this.banner.offsetWidth; // reflow でアニメ再起動
    this.banner.classList.add('show');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => this.banner?.classList.remove('show'), 1800);
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
    clearTimeout(this.bannerTimer);
    this.timers = [];
    this.queue = [];
    this.active = false;
    this.layer.remove();
  }
}

/** 数値のカウントアップ（0→to）。整数表示・easeOutCubic。既存要素の textContent を上書きする。 */
export function countUp(node: HTMLElement, to: number, ms = 900): void {
  const start = performance.now();
  const from = 0;
  const tick = (now: number): void => {
    const t = Math.min(1, (now - start) / ms);
    const e = 1 - Math.pow(1 - t, 3);
    node.textContent = String(Math.round(from + (to - from) * e));
    if (t < 1) requestAnimationFrame(tick);
    else node.textContent = String(to);
  };
  requestAnimationFrame(tick);
}
