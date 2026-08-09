// 卓のフェルト面テクスチャをプロシージャル生成（外部アセット依存なし・要件 D7）。
import * as THREE from 'three';

let feltCache: THREE.Texture | null = null;

export function feltTexture(): THREE.Texture {
  if (feltCache) return feltCache;
  const S = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;

  // ベースの緑グラデ
  const g = ctx.createRadialGradient(S / 2, S / 2, S * 0.1, S / 2, S / 2, S * 0.62);
  g.addColorStop(0, '#1f7a4d');
  g.addColorStop(0.7, '#155f3b');
  g.addColorStop(1, '#0c3c26');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);

  // フェルトの微ノイズ
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    d[i] = Math.max(0, Math.min(255, d[i]! + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1]! + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2]! + n));
  }
  ctx.putImageData(img, 0, 0);

  // 中央のディーラーリング装飾
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S * 0.34, 0, Math.PI * 2);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  feltCache = tex;
  return tex;
}

/** フェルトテクスチャを破棄しキャッシュを空にする（シーン破棄時）。 */
export function disposeFelt(): void {
  if (feltCache) {
    feltCache.dispose();
    feltCache = null;
  }
}
