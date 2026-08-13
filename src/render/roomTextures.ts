// 契約27(R29): 部屋の躯体（床・壁・天井）とラグの情報量を上げるプロシージャルテクスチャ。
// すべて Canvas 生成（外部URL禁止・D7）。生成は起動時1回・CanvasTexture を返す。
// 呼び出し側（scene.buildRoom）が dispose() を保持し、シーン破棄時に解放すること（E3）。
import * as THREE from 'three';

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  return [c, g];
}

// 再描画レジストリ（契約37・白カード対策の横展開）: モバイルのメモリ圧で Canvas バッキングストアが
// パージされた後、復帰時に中身を再生できるよう「この Canvas をどう描くか」を対で覚えておく。
// テクスチャの needsUpdate は呼び出し側（scene が clone 含む全テクスチャを把握している）が立てる。
const redrawRegistry: (() => void)[] = [];

/** 登録済みの部屋テクスチャ Canvas を全再描画する（パージ復旧・冪等）。戻り値は枚数。 */
export function refreshRoomTextures(): number {
  for (const redraw of redrawRegistry) redraw();
  return redrawRegistry.length;
}

/** レジストリを空にする（シーン破棄時。テクスチャ自体の dispose は scene 側）。 */
export function clearRoomTextureRegistry(): void {
  redrawRegistry.length = 0;
}

// 決定的な擬似乱数（毎回同じ見た目・テストや再訪で変化しない）
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * 床: 木目フローリングのフルセット（カラー + 法線 + 粗さ）。契約29(R31)「のっぺり解消」。
 * 同一シードで板割りを2回描く（カラー用 / 高さ用）→ 高さマップの Sobel から法線を作るため、
 * 目地の溝・板ごとの微妙な反り・木目の起伏が照明で立体に見える。
 */
export function makeFloorWood(): { map: THREE.CanvasTexture; normalMap: THREE.CanvasTexture; roughnessMap: THREE.CanvasTexture } {
  const S = 1024;
  const rows = 6; // 1タイル6枚 → repeat 5 で板幅 0.6m（契約31: 大きな板で床の情報が読める距離を伸ばす）
  const rh = S / rows;
  // 契約31→32: のっぺり解消 — アンビエント光だけでも板が読めるよう、壁と同等の明度まで引き上げ
  const base = ['#8a6a49', '#755839', '#997e57', '#6b5136', '#846849', '#a08a60'];
  interface Painter {
    plank(x: number, y: number, len: number, colIdx: number, r01: number): void;
    grain(x0: number, y0: number, x1: number, y1: number, w: number, k: number): void;
    knot(x: number, y: number, rx: number, ry: number, a: number): void;
    seam(x: number, y: number): void;
    row(y: number): void;
  }
  // 板割りを決定的に走査し、カラー/高さ/粗さの painter へ同じ構造を流す
  const layout = (p: Painter): void => {
    const rand = rng(20260812);
    for (let r = 0; r < rows; r++) {
      const y = r * rh;
      let x = -Math.floor(rand() * 300);
      while (x < S) {
        const len = 260 + Math.floor(rand() * 300);
        const ci = Math.floor(rand() * base.length);
        const warp = rand();
        p.plank(x, y, len, ci, warp);
        for (let k = 0; k < 9; k++) {
          const gy = y + 4 + rand() * (rh - 8);
          p.grain(Math.max(0, x), gy, Math.min(S, x + len), gy + (rand() - 0.5) * 7, 0.6 + rand() * 1.4, rand());
        }
        if (rand() < 0.35) p.knot(x + 30 + rand() * (len - 60), y + rh * (0.3 + rand() * 0.4), 3 + rand() * 5, 2 + rand() * 2.5, rand() * Math.PI);
        p.seam(x + len, y);
        x += len;
      }
      p.row(y);
    }
  };
  const [cc, cg] = canvas(S);
  const [, hg] = canvas(S); // 高さマップ用（ImageData 経由でのみ使う）
  const [nc, ng] = canvas(S);
  const [rc, rgx] = canvas(S); // 粗さ用
  const paint = (): void => {
  // ---- カラー ----
  cg.fillStyle = '#6b5136';
  cg.fillRect(0, 0, S, S);
  layout({
    plank: (x, y, len, ci, warp) => {
      cg.fillStyle = base[ci]!;
      cg.fillRect(x, y + 1, len - 2, rh - 2);
      // 板内の明暗グラデ（反り感・のっぺり解消の要。契約31でコントラスト増）
      const lg = cg.createLinearGradient(x, y, x + len, y);
      lg.addColorStop(0, `rgba(255,228,190,${0.1 + warp * 0.08})`);
      lg.addColorStop(0.5, 'rgba(20,10,5,0.12)');
      lg.addColorStop(1, `rgba(255,228,190,${0.06 + warp * 0.07})`);
      cg.fillStyle = lg;
      cg.fillRect(x, y + 1, len - 2, rh - 2);
    },
    grain: (x0, y0, x1, y1, w, k) => {
      cg.strokeStyle = k < 0.5 ? 'rgba(30,18,8,0.22)' : 'rgba(240,210,170,0.10)';
      cg.lineWidth = w;
      cg.beginPath();
      cg.moveTo(x0, y0);
      cg.bezierCurveTo(x0 + (x1 - x0) * 0.3, y0 + (y1 - y0) * 0.2, x0 + (x1 - x0) * 0.7, y1, x1, y1);
      cg.stroke();
    },
    knot: (x, y, rx, ry, a) => {
      cg.fillStyle = 'rgba(30,18,8,0.35)';
      cg.beginPath();
      cg.ellipse(x, y, rx, ry, a, 0, Math.PI * 2);
      cg.fill();
      cg.strokeStyle = 'rgba(25,14,6,0.3)';
      cg.lineWidth = 1;
      cg.beginPath();
      cg.ellipse(x, y, rx + 3, ry + 2, a, 0, Math.PI * 2);
      cg.stroke();
    },
    seam: (x, y) => {
      cg.fillStyle = 'rgba(15,9,4,0.7)';
      cg.fillRect(x - 2.5, y, 2.5, rh);
    },
    row: (y) => {
      cg.fillStyle = 'rgba(15,9,4,0.75)';
      cg.fillRect(0, y + rh - 2, S, 2);
    },
  });
  // ---- 高さ（グレースケール） → Sobel で法線へ ----
  hg.fillStyle = '#808080';
  hg.fillRect(0, 0, S, S);
  layout({
    plank: (x, y, len, _ci, warp) => {
      hg.fillStyle = `rgb(${128 + Math.round((warp - 0.5) * 14)},0,0)`.replace(/rgb\((\d+),0,0\)/, (_, v) => `rgb(${v},${v},${v})`);
      hg.fillRect(x, y + 1, len - 2, rh - 2);
    },
    grain: (x0, y0, x1, y1, w) => {
      hg.strokeStyle = 'rgba(96,96,96,0.35)';
      hg.lineWidth = w;
      hg.beginPath();
      hg.moveTo(x0, y0);
      hg.lineTo(x1, y1);
      hg.stroke();
    },
    knot: (x, y, rx, ry, a) => {
      hg.fillStyle = 'rgba(70,70,70,0.8)';
      hg.beginPath();
      hg.ellipse(x, y, rx, ry, a, 0, Math.PI * 2);
      hg.fill();
    },
    seam: (x, y) => {
      hg.fillStyle = 'rgb(40,40,40)';
      hg.fillRect(x - 2.5, y, 2.5, rh);
    },
    row: (y) => {
      hg.fillStyle = 'rgb(30,30,30)';
      hg.fillRect(0, y + rh - 2, S, 2);
    },
  });
  const hd = hg.getImageData(0, 0, S, S).data;
  const nd = ng.createImageData(S, S);
  const H = (x: number, y: number): number => hd[(((y + S) % S) * S + ((x + S) % S)) * 4]!;
  const STR = 3.2; // 法線強度（契約31: 目地・木目の起伏を強調）
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) / 255;
      const dy = (H(x, y + 1) - H(x, y - 1)) / 255;
      const inv = 1 / Math.hypot(dx * STR, dy * STR, 1);
      const i = (y * S + x) * 4;
      nd.data[i] = Math.round((-dx * STR * inv * 0.5 + 0.5) * 255);
      nd.data[i + 1] = Math.round((dy * STR * inv * 0.5 + 0.5) * 255); // three は +Y up の法線マップ
      nd.data[i + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      nd.data[i + 3] = 255;
    }
  }
  ng.putImageData(nd, 0, 0);
  // ---- 粗さ: 目地=ザラ(255)・板面=磨いた木のツヤ(130〜165)・木目でムラ（契約31: ランプの映り込みを出す） ----
  rgx.fillStyle = 'rgb(170,170,170)';
  rgx.fillRect(0, 0, S, S);
  layout({
    plank: (x, y, len, ci) => {
      const v = 128 + (ci % 3) * 14;
      rgx.fillStyle = `rgb(${v},${v},${v})`;
      rgx.fillRect(x, y + 1, len - 2, rh - 2);
    },
    grain: (x0, y0, x1, y1, w, k) => {
      const v = k < 0.5 ? 210 : 150;
      rgx.strokeStyle = `rgba(${v},${v},${v},0.5)`;
      rgx.lineWidth = w * 1.5;
      rgx.beginPath();
      rgx.moveTo(x0, y0);
      rgx.lineTo(x1, y1);
      rgx.stroke();
    },
    knot: (x, y, rx, ry, a) => {
      rgx.fillStyle = 'rgb(225,225,225)';
      rgx.beginPath();
      rgx.ellipse(x, y, rx, ry, a, 0, Math.PI * 2);
      rgx.fill();
    },
    seam: (x, y) => {
      rgx.fillStyle = 'rgb(255,255,255)';
      rgx.fillRect(x - 2.5, y, 2.5, rh);
    },
    row: (y) => {
      rgx.fillStyle = 'rgb(255,255,255)';
      rgx.fillRect(0, y + rh - 2, S, 2);
    },
  });
  };
  paint();
  redrawRegistry.push(paint); // 契約37: パージ復旧用
  const finish = (cnv: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture => {
    const t = new THREE.CanvasTexture(cnv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping ?? 1000;
    t.repeat.set(5, 5); // 板幅 0.6m（契約31）
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace ?? 'srgb';
    return t;
  };
  return { map: finish(cc, true), normalMap: finish(nc, false), roughnessMap: finish(rc, false) };
}

/** 壁: 上部=温かい壁紙（縦ストライプ+ダマスク風モチーフ+質感ノイズ）/ 下部=腰壁パネル+幅木。 */
export function makeWallPaper(): THREE.CanvasTexture {
  const S = 1024;
  const [c, g] = canvas(S);
  const paint = (): void => {
  const rand = rng(19851123);
  const wainH = 176; // 下部 ~1.1m 相当（壁高6.6m・v方向は非リピート）
  const railY = S - wainH;
  // 壁紙ベース
  g.fillStyle = '#7a6249';
  g.fillRect(0, 0, S, railY);
  // 縦ストライプ（淡い明暗交互）
  for (let x = 0; x < S; x += 64) {
    g.fillStyle = x % 128 === 0 ? 'rgba(255,240,220,0.055)' : 'rgba(30,20,10,0.05)';
    g.fillRect(x, 0, 30, railY);
  }
  // ダマスク風の小モチーフ（菱格子・淡く）
  g.fillStyle = 'rgba(45,30,16,0.10)';
  for (let gy = 0; gy < railY; gy += 96) {
    for (let gx = 0; gx < S; gx += 96) {
      const ox = (Math.floor(gy / 96) % 2) * 48;
      const mx = gx + ox + 24;
      const my = gy + 24;
      g.beginPath();
      g.moveTo(mx, my - 10);
      g.quadraticCurveTo(mx + 8, my, mx, my + 10);
      g.quadraticCurveTo(mx - 8, my, mx, my - 10);
      g.fill();
      g.fillRect(mx - 1, my + 12, 2, 6);
    }
  }
  // 質感ノイズ
  for (let i = 0; i < 2400; i++) {
    g.fillStyle = rand() < 0.5 ? 'rgba(255,235,210,0.03)' : 'rgba(20,12,6,0.035)';
    g.fillRect(rand() * S, rand() * railY, 1.6, 1.6);
  }
  // 見切り縁（レール）
  g.fillStyle = '#8a6f50';
  g.fillRect(0, railY, S, 10);
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.fillRect(0, railY + 10, S, 3);
  // 腰壁: 縦板パネル
  g.fillStyle = '#5a432e';
  g.fillRect(0, railY + 13, S, wainH - 13);
  for (let x = 0; x < S; x += 128) {
    g.fillStyle = 'rgba(255,230,200,0.06)';
    g.fillRect(x + 8, railY + 22, 112, wainH - 60);
    g.strokeStyle = 'rgba(20,12,6,0.5)';
    g.lineWidth = 2;
    g.strokeRect(x + 8, railY + 22, 112, wainH - 60);
  }
  // 幅木
  g.fillStyle = '#3a2a1a';
  g.fillRect(0, S - 26, S, 26);
  g.fillStyle = 'rgba(255,230,200,0.08)';
  g.fillRect(0, S - 26, S, 3);
  };
  paint();
  redrawRegistry.push(paint); // 契約37
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping ?? 1000;
  t.wrapT = THREE.ClampToEdgeWrapping ?? 1001;
  t.repeat.set(3, 1); // 横のみリピート（腰壁の上下構造は1枚）
  t.colorSpace = THREE.SRGBColorSpace ?? 'srgb';
  return t;
}

/** 天井: 板張り（壁より一段暗い・細めの板）。 */
export function makeCeilingWood(): THREE.CanvasTexture {
  const S = 512;
  const [c, g] = canvas(S);
  const paint = (): void => {
  const rand = rng(7777);
  const rows = 6;
  const rh = S / rows;
  const base = ['#4a3a2a', '#453626', '#4f3e2e', '#423323'];
  for (let r = 0; r < rows; r++) {
    g.fillStyle = base[Math.floor(rand() * base.length)]!;
    g.fillRect(0, r * rh, S, rh);
    g.strokeStyle = 'rgba(25,16,8,0.25)';
    for (let k = 0; k < 4; k++) {
      const gy = r * rh + 6 + rand() * (rh - 12);
      g.lineWidth = 0.8;
      g.beginPath();
      g.moveTo(0, gy);
      g.lineTo(S, gy + (rand() - 0.5) * 4);
      g.stroke();
    }
    g.fillStyle = 'rgba(15,10,5,0.5)';
    g.fillRect(0, r * rh + rh - 1.5, S, 1.5);
  }
  };
  paint();
  redrawRegistry.push(paint); // 契約37
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping ?? 1000;
  t.repeat.set(4, 4);
  t.colorSpace = THREE.SRGBColorSpace ?? 'srgb';
  return t;
}

/** 接地影: 放射グラデーションの黒ブロブ（家具の下に敷くフェイクAO・契約32）。 */
export function makeShadowBlob(): THREE.CanvasTexture {
  const S = 256;
  const [c, g] = canvas(S);
  const paint = (): void => {
  g.clearRect(0, 0, S, S);
  const grad = g.createRadialGradient(S / 2, S / 2, S * 0.08, S / 2, S / 2, S * 0.5);
  grad.addColorStop(0, 'rgba(0,0,0,0.28)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.14)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  };
  paint();
  redrawRegistry.push(paint); // 契約37
  return new THREE.CanvasTexture(c);
}

/** 長方形ラグ: ストライプ+ボーダーの北欧風（ソファゾーン用・契約32）。 */
export function makeRectRug(): THREE.CanvasTexture {
  const S = 1024;
  const [c, g] = canvas(S);
  const paint = (): void => {
  const rand = rng(4649);
  g.clearRect(0, 0, S, S);
  // 暖色照明下でも床と分離して見える、クリーム×テラコッタの高コントラスト柄（青系は泥色に転ぶ）
  g.fillStyle = '#b3a184';
  g.fillRect(0, 0, S, S);
  const stripes = ['#d9c9a8', '#8a5a44', '#e8dcc0', '#5b7a72'];
  for (let y = 60, i = 0; y < S - 60; y += 88, i++) {
    g.fillStyle = stripes[i % stripes.length]!;
    g.fillRect(60, y, S - 120, 56);
  }
  // ボーダーと房
  g.strokeStyle = '#f2ead8';
  g.lineWidth = 16;
  g.strokeRect(36, 36, S - 72, S - 72);
  g.fillStyle = '#f2ead8';
  for (let x = 24; x < S - 12; x += 40) {
    g.fillRect(x, 4, 14, 22);
    g.fillRect(x, S - 26, 14, 22);
  }
  // 織りノイズ（シード付き＝再描画でも同じ柄・契約37）
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = i % 2 ? 'rgba(255,250,240,0.05)' : 'rgba(10,15,20,0.06)';
    g.fillRect(rand() * S, rand() * S, 2, 2);
  }
  };
  paint();
  redrawRegistry.push(paint); // 契約37
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace ?? 'srgb';
  return t;
}

/** ラグ: 臙脂ベースのオリエンタル風パターン（同心リング+菱モチーフ+外周ボーダー）。 */
export function makeRugPattern(): THREE.CanvasTexture {
  const S = 1024;
  const [c, g] = canvas(S);
  const cx = S / 2;
  const paint = (): void => {
  g.clearRect(0, 0, S, S);
  g.fillStyle = '#5b2f2c';
  g.beginPath();
  g.arc(cx, cx, cx, 0, Math.PI * 2);
  g.fill();
  const ring = (r0: number, r1: number, color: string): void => {
    g.strokeStyle = color;
    g.lineWidth = r1 - r0;
    g.beginPath();
    g.arc(cx, cx, (r0 + r1) / 2, 0, Math.PI * 2);
    g.stroke();
  };
  // 外周ボーダー + ジグザグ
  ring(470, 505, '#7a4a3a');
  g.strokeStyle = '#c9a23a';
  g.lineWidth = 5;
  g.beginPath();
  for (let i = 0; i <= 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    const r = i % 2 ? 497 : 478;
    const x = cx + Math.cos(a) * r;
    const y = cx + Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
  g.stroke();
  ring(438, 450, '#6e4436');
  // 中間の菱モチーフ帯
  g.fillStyle = 'rgba(201,162,58,0.8)';
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const r = 380;
    const x = cx + Math.cos(a) * r;
    const y = cx + Math.sin(a) * r;
    g.save();
    g.translate(x, y);
    g.rotate(a + Math.PI / 4);
    g.fillRect(-13, -13, 26, 26);
    g.restore();
  }
  ring(316, 326, '#7a4a3a');
  // 内側の小花帯
  g.fillStyle = 'rgba(122,155,176,0.75)'; // くすんだ青（クッションと呼応）
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const x = cx + Math.cos(a) * 255;
    const y = cx + Math.sin(a) * 255;
    g.beginPath();
    g.arc(x, y, 11, 0, Math.PI * 2);
    g.fill();
  }
  // 中央メダリオン（8弁）
  ring(150, 158, '#c9a23a');
  g.fillStyle = '#7a4a3a';
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    g.save();
    g.translate(cx, cx);
    g.rotate(a);
    g.beginPath();
    g.ellipse(95, 0, 52, 24, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  g.fillStyle = '#c9a23a';
  g.beginPath();
  g.arc(cx, cx, 42, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#5b2f2c';
  g.beginPath();
  g.arc(cx, cx, 24, 0, Math.PI * 2);
  g.fill();
  };
  paint();
  redrawRegistry.push(paint); // 契約37
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace ?? 'srgb';
  return t;
}
