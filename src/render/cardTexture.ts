// カード面/裏のプロシージャルテクスチャ生成（Canvas）。外部アセット依存なし（要件 D7）。
// 高解像度 + 異方性フィルタで文字の滲みを防ぐ（プリモーテム E5）。
import * as THREE from 'three';
import type { Card, Rank, Suit } from '../core';
import { cardId } from '../core';

const W = 512;
const H = 716; // 約 5:7（トランプ比）

const SUIT_GLYPH: Record<Suit, string> = { C: '♣', D: '♦', H: '♥', S: '♠' };
const RED: Suit[] = ['D', 'H'];
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

/** ピップの座標（相対 0..1）をランクごとに返す。数札は伝統的配置に近い簡略版。 */
function pipLayout(rank: Rank): [number, number][] {
  const col = { l: 0.3, c: 0.5, r: 0.7 };
  const row = { a: 0.2, b: 0.34, c: 0.42, d: 0.5, e: 0.58, f: 0.66, g: 0.8 };
  const P = (x: number, y: number): [number, number] => [x, y];
  switch (rank) {
    case 1: return [P(col.c, col.c ? 0.5 : 0.5)];
    case 2: return [P(col.c, row.a), P(col.c, row.g)];
    case 3: return [P(col.c, row.a), P(col.c, row.d), P(col.c, row.g)];
    case 4: return [P(col.l, row.a), P(col.r, row.a), P(col.l, row.g), P(col.r, row.g)];
    case 5: return [P(col.l, row.a), P(col.r, row.a), P(col.c, row.d), P(col.l, row.g), P(col.r, row.g)];
    case 6: return [P(col.l, row.a), P(col.r, row.a), P(col.l, row.d), P(col.r, row.d), P(col.l, row.g), P(col.r, row.g)];
    case 7: return [P(col.l, row.a), P(col.r, row.a), P(col.c, row.b + 0.04), P(col.l, row.d), P(col.r, row.d), P(col.l, row.g), P(col.r, row.g)];
    case 8: return [P(col.l, row.a), P(col.r, row.a), P(col.c, row.b + 0.04), P(col.l, row.d), P(col.r, row.d), P(col.c, row.f - 0.04), P(col.l, row.g), P(col.r, row.g)];
    case 9: return [P(col.l, row.a), P(col.r, row.a), P(col.l, 0.38), P(col.r, 0.38), P(col.c, row.d), P(col.l, 0.62), P(col.r, 0.62), P(col.l, row.g), P(col.r, row.g)];
    case 10: return [P(col.l, row.a), P(col.r, row.a), P(col.l, 0.33), P(col.r, 0.33), P(col.l, row.d), P(col.r, row.d), P(col.l, 0.67), P(col.r, 0.67), P(col.l, row.g), P(col.r, row.g)];
    default: return [];
  }
}

function drawFace(ctx: CanvasRenderingContext2D, card: Card): void {
  const red = RED.includes(card.suit);
  const color = red ? '#c0212f' : '#1b1b22';
  const glyph = SUIT_GLYPH[card.suit];
  const label = RANK_LABEL[card.rank];

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

  // 角のランク+スート（上下2箇所）。卓上での視認性を優先し大きめに描く（項目2）。
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  const corner = (x: number, y: number, flip: boolean): void => {
    ctx.save();
    ctx.translate(x, y);
    if (flip) ctx.rotate(Math.PI);
    ctx.textBaseline = 'alphabetic';
    ctx.font = 'bold 108px Georgia, "Times New Roman", serif';
    ctx.fillText(label, 0, 0);
    ctx.font = 'bold 88px Georgia, serif';
    ctx.fillText(glyph, 0, 90);
    ctx.restore();
  };
  corner(78, 120, false);
  corner(W - 78, H - 66, true);

  // 中央: 絵札は大きな文字+スート、数札はピップ、7は強調（いずれも拡大・項目2）。
  if (card.rank >= 11) {
    ctx.font = 'bold 236px Georgia, serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, W / 2, H / 2 - 24);
    ctx.font = 'bold 138px Georgia, serif';
    ctx.fillText(glyph, W / 2, H / 2 + 156);
  } else if (card.rank === 1) {
    ctx.font = 'bold 336px Georgia, serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(glyph, W / 2, H / 2);
  } else {
    ctx.textBaseline = 'middle';
    for (const [px, py] of pipLayout(card.rank)) {
      const flip = py > 0.5;
      ctx.save();
      ctx.translate(px * W, py * H);
      if (flip) ctx.rotate(Math.PI);
      ctx.font = 'bold 104px Georgia, serif';
      ctx.fillText(glyph, 0, 0);
      ctx.restore();
    }
    if (card.rank === 7) {
      // 単独7でメルドになり得る特別なカード: 淡いハイライトリング
      ctx.strokeStyle = red ? 'rgba(192,33,47,0.35)' : 'rgba(27,27,34,0.28)';
      ctx.lineWidth = 8;
      roundRect(ctx, 40, 40, W - 80, H - 80, 34);
      ctx.stroke();
    }
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
