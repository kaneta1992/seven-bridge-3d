// カード面/裏のプロシージャルテクスチャ生成（Canvas）。外部アセット依存なし（要件 D7）。
// 高解像度 + 異方性フィルタで文字の滲みを防ぐ（プリモーテム E5）。
import * as THREE from 'three';
import type { Card, Rank } from '../core';
import { cardId } from '../core';
import { SUIT_COLOR, SUIT_GLYPH } from './suitStyle';

const W = 512;
const H = 716; // 約 5:7（トランプ比）

const RANK_LABEL: Record<Rank, string> = {
  1: 'A', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7',
  8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K',
};

const faceCache = new Map<string, THREE.Texture>();
let backCache: THREE.Texture | null = null;
let maxAniso = 8;

/** 生成テクスチャの異方性フィルタ上限をレンダラから伝える（滲み対策）。 */
export function setMaxAnisotropy(value: number): void {
  maxAniso = Math.max(1, value);
}

/** キャッシュ済みカードテクスチャを破棄しキャッシュを空にする（シーン破棄時）。 */
export function disposeCardTextures(): void {
  for (const t of faceCache.values()) t.dispose();
  faceCache.clear();
  if (backCache) {
    backCache.dispose();
    backCache = null;
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function finalize(canvas: HTMLCanvasElement): THREE.Texture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** 指定サイズで maxW を超えるなら収まるまでフォントを縮小して中央描画する（"10" 等の2桁対策）。 */
function fitText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, px: number, maxW: number): void {
  let size = px;
  ctx.font = `bold ${size}px Georgia, "Times New Roman", serif`;
  while (size > 40 && ctx.measureText(text).width > maxW) {
    size -= 8;
    ctx.font = `bold ${size}px Georgia, "Times New Roman", serif`;
  }
  ctx.fillText(text, x, y);
}

// カード面を「大きな中央ランク + スート」構成で描く（契約07項目3: 視認性最優先）。
// 伝統的なピップ配置は卓上の遠距離で読み取りづらいため、忠実さより読み取りやすさを優先し
// 中央に巨大なランク文字とスートを配置する（画面下の 2D 手札カード＝ランク大＋スートの構成と整合）。
function drawFace(ctx: CanvasRenderingContext2D, card: Card): void {
  const color = SUIT_COLOR[card.suit]; // 4色デッキ（項目2）
  const glyph = SUIT_GLYPH[card.suit];
  const label = RANK_LABEL[card.rank];
  const twoChar = label.length > 1; // "10"

  // カード地（角丸・微グラデ・枠）
  ctx.fillStyle = '#f6f4ec';
  roundRect(ctx, 10, 10, W - 20, H - 20, 46);
  ctx.fill();
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(1, 'rgba(226,222,208,0.9)');
  ctx.fillStyle = grad;
  roundRect(ctx, 10, 10, W - 20, H - 20, 46);
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  roundRect(ctx, 12, 12, W - 24, H - 24, 44);
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.textAlign = 'center';

  // 角のランク+スート（上下2箇所・大胆に拡大）。斜めから見ても隅で読めるようにする（項目3）。
  const corner = (x: number, y: number, flip: boolean): void => {
    ctx.save();
    ctx.translate(x, y);
    if (flip) ctx.rotate(Math.PI);
    ctx.textBaseline = 'alphabetic';
    fitText(ctx, label, 0, 0, twoChar ? 104 : 146, 150);
    ctx.font = 'bold 112px Georgia, serif';
    ctx.fillText(glyph, 0, 104);
    ctx.restore();
  };
  corner(98, 138, false);
  corner(W - 98, H - 138, true);

  // 中央: 巨大なランク + スート。全ランク共通の明快な構成（数札のピップは廃止＝簡素化・項目3）。
  ctx.textBaseline = 'middle';
  fitText(ctx, label, W / 2, H * 0.42, 320, W - 176);
  ctx.font = 'bold 210px Georgia, serif';
  ctx.fillText(glyph, W / 2, H * 0.74);

  if (card.rank === 7) {
    // 単独7でメルドになり得る特別なカード: スート色の淡いハイライトリング
    ctx.save();
    ctx.globalAlpha = 0.32;
    ctx.strokeStyle = color;
    ctx.lineWidth = 8;
    roundRect(ctx, 40, 40, W - 80, H - 80, 34);
    ctx.stroke();
    ctx.restore();
  }
}

export function faceTexture(card: Card): THREE.Texture {
  const key = cardId(card);
  const hit = faceCache.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  drawFace(ctx, card);
  const tex = finalize(canvas);
  faceCache.set(key, tex);
  return tex;
}

export function backTexture(): THREE.Texture {
  if (backCache) return backCache;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#0e2a4a';
  roundRect(ctx, 10, 10, W - 20, H - 20, 46);
  ctx.fill();
  // 斜め格子模様
  ctx.strokeStyle = 'rgba(120,180,240,0.35)';
  ctx.lineWidth = 3;
  for (let d = -H; d < W; d += 26) {
    ctx.beginPath();
    ctx.moveTo(d, 0);
    ctx.lineTo(d + H, H);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(d + H, 0);
    ctx.lineTo(d, H);
    ctx.stroke();
  }
  // 中央エンブレム
  ctx.fillStyle = '#0e2a4a';
  roundRect(ctx, 70, 150, W - 140, H - 300, 40);
  ctx.fill();
  ctx.strokeStyle = 'rgba(200,220,255,0.85)';
  ctx.lineWidth = 6;
  roundRect(ctx, 70, 150, W - 140, H - 300, 40);
  ctx.stroke();
  ctx.fillStyle = 'rgba(200,220,255,0.95)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 96px Georgia, serif';
  ctx.fillText('7', W / 2, H / 2 - 10);
  ctx.font = '28px Georgia, serif';
  ctx.fillText('SEVEN BRIDGE', W / 2, H / 2 + 90);
  // 外枠
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 4;
  roundRect(ctx, 18, 18, W - 36, H - 36, 40);
  ctx.stroke();
  backCache = finalize(canvas);
  return backCache;
}
