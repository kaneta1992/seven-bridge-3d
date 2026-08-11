// R27: Meshy 生成家具GLB群 → 1メッシュ・1マテリアル・1アトラスの room-furniture.glb へ統合（契約25）。
// - room-layout.mjs の PLACEMENTS どおりワールド座標へ頂点を焼き込む（実行時トランスフォーム不要）。
// - 各モデルのテクスチャを 4096x4096 アトラス（1024タイル×4x4）へ詰め、UVを再マップ。
// - 出力はドローコール1回分。quantize（KHR_mesh_quantization・three対応）で圧縮。
// 実行: node scripts/merge-furniture.mjs  （入力: assets-src/meshy-room/*.glb → 出力: public/models/room-furniture.glb）
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { quantize } from '@gltf-transform/functions';
import sharp from 'sharp';
import { statSync, writeFileSync } from 'node:fs';
import { MODELS, INSTANCES, FLOOR_Y } from './room-layout.mjs';

const SRC = 'assets-src/meshy-room';
const OUT = 'public/models/room-furniture.glb';
const TILE = 1024;
const GRID = 4; // 4x4 = 16 タイル（テクスチャ12 + 予備）
const ATLAS = TILE * GRID;
const PAD = 6 / TILE; // タイル内インセット（ミップでの隣タイル滲み対策）

const deg = (d) => (d * Math.PI) / 180;

// ---- 小さな行列ヘルパ（three を Node に持ち込まないため自前・列優先 mat4） ----
const applyMat4 = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];
const rotY = (a, x, y, z) => [Math.cos(a) * x + Math.sin(a) * z, y, -Math.sin(a) * x + Math.cos(a) * z];
// 法線用 3x3 逆転置（world の上位3x3から）
function invTranspose3(m) {
  const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]; // 行優先3x3へ転置格納
  const [a00, a01, a02, a10, a11, a12, a20, a21, a22] = a;
  const det = a00 * (a11 * a22 - a12 * a21) - a01 * (a10 * a22 - a12 * a20) + a02 * (a10 * a21 - a11 * a20);
  const s = 1 / (det || 1);
  // inverse の転置 = cofactor 行列 / det
  return [
    (a11 * a22 - a12 * a21) * s, (a02 * a21 - a01 * a22) * s, (a01 * a12 - a02 * a11) * s,
    (a12 * a20 - a10 * a22) * s, (a00 * a22 - a02 * a20) * s, (a02 * a10 - a00 * a12) * s,
    (a10 * a21 - a11 * a20) * s, (a01 * a20 - a00 * a21) * s, (a00 * a11 - a01 * a10) * s,
  ];
}
const applyMat3 = (m, x, y, z) => [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

// ---- 1) 各モデルを読み、fixYaw 適用済みローカル座標の頂点群 + テクスチャを収集 ----
const models = new Map(); // name -> { parts: [{pos,nrm,uv,idx,texKey}], bbox, texs: Map<texKey, {img,mime}|{rgb}> }
for (const name of Object.keys(MODELS)) {
  const cfg = MODELS[name];
  const doc = await io.read(`${SRC}/${name}.glb`);
  const parts = [];
  const texs = new Map();
  let triCount = 0;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const world = node.getWorldMatrix();
    const nrmMat = invTranspose3(world);
    for (const prim of mesh.listPrimitives()) {
      const posA = prim.getAttribute('POSITION')?.getArray();
      const uvA = prim.getAttribute('TEXCOORD_0')?.getArray();
      const nrmA = prim.getAttribute('NORMAL')?.getArray();
      const idxA = prim.getIndices()?.getArray();
      if (!posA) continue;
      const mat = prim.getMaterial();
      const bct = mat?.getBaseColorTexture();
      let texKey;
      if (bct?.getImage()) {
        texKey = `${name}#img${[...texs.keys()].length}`;
        // 同一 Texture の再登場は同キーへ（getImage の参照で同定）
        for (const [k, v] of texs) if (v.ref === bct) texKey = k;
        if (!texs.has(texKey)) texs.set(texKey, { ref: bct, img: Buffer.from(bct.getImage()), mime: bct.getMimeType() });
      } else {
        const f = mat?.getBaseColorFactor() ?? [0.8, 0.8, 0.8, 1];
        texKey = `${name}#solid_${f.map((v) => v.toFixed(2)).join('_')}`;
        if (!texs.has(texKey)) texs.set(texKey, { rgb: f.slice(0, 3).map((v) => Math.round(255 * Math.pow(v, 1 / 2.2))) });
      }
      const n = posA.length / 3;
      const pos = new Float32Array(n * 3);
      const nrm = new Float32Array(n * 3);
      const uv = new Float32Array(n * 2);
      const fix = deg(cfg.fixYaw);
      for (let i = 0; i < n; i++) {
        let [x, y, z] = applyMat4(world, posA[i * 3], posA[i * 3 + 1], posA[i * 3 + 2]);
        [x, y, z] = rotY(fix, x, y, z);
        pos.set([x, y, z], i * 3);
        if (nrmA) {
          let [nx, ny, nz] = applyMat3(nrmMat, nrmA[i * 3], nrmA[i * 3 + 1], nrmA[i * 3 + 2]);
          [nx, ny, nz] = rotY(fix, nx, ny, nz);
          const l = Math.hypot(nx, ny, nz) || 1;
          nrm.set([nx / l, ny / l, nz / l], i * 3);
        }
        if (uvA) uv.set([uvA[i * 2], uvA[i * 2 + 1]], i * 2);
      }
      const idx = idxA ? Uint32Array.from(idxA) : Uint32Array.from({ length: n }, (_, i) => i);
      triCount += idx.length / 3;
      parts.push({ pos, nrm, uv, idx, texKey });
    }
  }
  // fixYaw 適用後の bbox（スケール決定用）
  const bb = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] };
  for (const p of parts)
    for (let i = 0; i < p.pos.length; i += 3)
      for (let k = 0; k < 3; k++) {
        bb.min[k] = Math.min(bb.min[k], p.pos[i + k]);
        bb.max[k] = Math.max(bb.max[k], p.pos[i + k]);
      }
  models.set(name, { parts, bb, texs, triCount });
  const sz = bb.max.map((v, k) => (v - bb.min[k]).toFixed(2)).join(' x ');
  console.log(`${name}: tris=${triCount} bbox=${sz} texs=${texs.size}`);
}

// ---- 2) アトラスのタイル割り当て（テクスチャ単位・16タイル/枚を超えたら複数アトラス） ----
// アトラス1枚 = 1プリミティブ = 1描画コール。第2弾（R29）で26テクスチャ → 2アトラス=2コール。
const PER_ATLAS = GRID * GRID;
const tileOf = new Map(); // texKey -> グローバルタイル番号（atlas = floor(n/16), tile = n%16）
let nextTile = 0;
for (const [, m] of models) for (const key of m.texs.keys()) tileOf.set(key, nextTile++);
const N_ATLAS = Math.ceil(nextTile / PER_ATLAS);
console.log(`アトラス: ${nextTile} タイル / ${N_ATLAS} 枚（=${N_ATLAS} 描画コール）`);

// ---- 3) インスタンス焼き込み: スケール→yaw→平行移動、UV 再マップ、アトラス毎に配列連結 ----
const buckets = Array.from({ length: N_ATLAS }, () => ({ P: [], N: [], UV: [], I: [], vBase: 0 }));
const report = [];
for (const inst of INSTANCES) {
  const m = models.get(inst.model);
  const cfg = MODELS[inst.model];
  const [bw, bh, bd] = m.bb.max.map((v, k) => v - m.bb.min[k]);
  // stretch: 軸別スケール（箱物）。それ以外は均等スケールで内接（歪みゼロ）。
  // inst.scale: インスタンス毎の追加倍率（複製に大小差を付ける・R30）。
  const su = Math.min(cfg.size.w / bw, cfg.size.h / bh, cfg.size.d / bd);
  const mul = inst.scale ?? 1;
  const [sx, sy, sz] = (cfg.stretch ? [cfg.size.w / bw, cfg.size.h / bh, cfg.size.d / bd] : [su, su, su]).map((v) => v * mul);
  const cx = (m.bb.min[0] + m.bb.max[0]) / 2;
  const cz = (m.bb.min[2] + m.bb.max[2]) / 2;
  const y0 = m.bb.min[1];
  const yaw = deg(inst.yaw);
  // topY: バウンディング上面を指定高さへ（天井/梁吊り）/ snapCap: 焼き込み済み頂点から
  // 「(x,z) 半径0.18内・snapCap 未満の最高点」＝家具天面を自動検出して接地（R32: 小物カモフラージュ。
  // INSTANCES で家具より後に並べること）。それ以外は床+yOff。
  let ty;
  if (inst.snapCap !== undefined) {
    let best = FLOOR_Y;
    for (const B of buckets) {
      for (let i = 0; i < B.P.length; i += 3) {
        const dx = B.P[i] - inst.x;
        const dz = B.P[i + 2] - inst.z;
        if (dx * dx + dz * dz > 0.0324) continue;
        const vy = B.P[i + 1];
        if (vy < inst.snapCap && vy > best) best = vy;
      }
    }
    ty = best;
  } else {
    ty = inst.topY !== undefined ? inst.topY - bh * sy : FLOOR_Y + (inst.yOff ?? 0);
  }
  const wb = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] };
  for (const p of m.parts) {
    const tile = tileOf.get(p.texKey);
    const B = buckets[Math.floor(tile / PER_ATLAS)];
    const t16 = tile % PER_ATLAS;
    const tc = t16 % GRID;
    const tr = Math.floor(t16 / GRID);
    const n = p.pos.length / 3;
    for (let i = 0; i < n; i++) {
      let [x, y, z] = [(p.pos[i * 3] - cx) * sx, (p.pos[i * 3 + 1] - y0) * sy, (p.pos[i * 3 + 2] - cz) * sz];
      [x, y, z] = rotY(yaw, x, y, z);
      x += inst.x; y += ty; z += inst.z;
      B.P.push(x, y, z);
      for (let k = 0; k < 3; k++) {
        wb.min[k] = Math.min(wb.min[k], [x, y, z][k]);
        wb.max[k] = Math.max(wb.max[k], [x, y, z][k]);
      }
      // 法線: 軸別スケールは逆数スケール後に正規化（逆転置行列相当）→ yaw 回転
      let [nx, ny, nz] = [p.nrm[i * 3] / sx, p.nrm[i * 3 + 1] / sy, p.nrm[i * 3 + 2] / sz];
      const nl = Math.hypot(nx, ny, nz) || 1;
      [nx, ny, nz] = rotY(yaw, nx / nl, ny / nl, nz / nl);
      B.N.push(nx, ny, nz);
      const u = Math.min(1, Math.max(0, p.uv[i * 2]));
      const v = Math.min(1, Math.max(0, p.uv[i * 2 + 1]));
      B.UV.push((u * (1 - 2 * PAD) + PAD + tc) / GRID, (v * (1 - 2 * PAD) + PAD + tr) / GRID);
    }
    for (const ix of p.idx) B.I.push(ix + B.vBase);
    B.vBase += n;
  }
  report.push({ model: inst.model, x: inst.x, z: inst.z, yaw: inst.yaw, scale: [sx, sy, sz].map((v) => +v.toFixed(3)), bbox: { min: wb.min.map((v) => +v.toFixed(2)), max: wb.max.map((v) => +v.toFixed(2)) } });
}
const totV = buckets.reduce((a, b) => a + b.vBase, 0);
console.log(`統合: verts=${totV} tris=${buckets.reduce((a, b) => a + b.I.length, 0) / 3} instances=${INSTANCES.length}`);

// ---- 4) アトラス合成（sharp）: テクスチャは 1024 タイルへリサイズ、単色はベタ塗り ----
const atlasComps = Array.from({ length: N_ATLAS }, () => []);
for (const [, m] of models)
  for (const [key, t] of m.texs) {
    const tile = tileOf.get(key);
    const t16 = tile % PER_ATLAS;
    const left = (t16 % GRID) * TILE;
    const top = Math.floor(t16 / GRID) * TILE;
    const input = t.img
      ? await sharp(t.img).resize(TILE, TILE, { fit: 'fill' }).removeAlpha().png().toBuffer()
      : await sharp({ create: { width: TILE, height: TILE, channels: 3, background: { r: t.rgb[0], g: t.rgb[1], b: t.rgb[2] } } }).png().toBuffer();
    atlasComps[Math.floor(tile / PER_ATLAS)].push({ input, left, top });
  }
const atlases = [];
for (let a = 0; a < N_ATLAS; a++) {
  const buf = await sharp({ create: { width: ATLAS, height: ATLAS, channels: 3, background: { r: 120, g: 110, b: 100 } } })
    .composite(atlasComps[a]).jpeg({ quality: 82 }).toBuffer();
  atlases.push(buf);
  console.log(`アトラス${a}: ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
}

// ---- 5) 出力 GLB 構築（1 mesh / アトラス毎に 1 primitive+1 material） ----
const out = new Document();
const buffer = out.createBuffer();
const acc = (type, arr) => out.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
const mesh = out.createMesh('roomFurniture');
for (let a = 0; a < N_ATLAS; a++) {
  const B = buckets[a];
  if (!B.vBase) continue;
  const tex = out.createTexture(`roomAtlas${a}`).setImage(atlases[a]).setMimeType('image/jpeg');
  const material = out.createMaterial(`roomFurniture${a}`)
    .setBaseColorTexture(tex).setMetallicFactor(0).setRoughnessFactor(0.95).setDoubleSided(true);
  mesh.addPrimitive(
    out.createPrimitive()
      .setAttribute('POSITION', acc('VEC3', new Float32Array(B.P)))
      .setAttribute('NORMAL', acc('VEC3', new Float32Array(B.N)))
      .setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array(B.UV)))
      .setIndices(out.createAccessor().setType('SCALAR').setArray(new Uint32Array(B.I)).setBuffer(buffer))
      .setMaterial(material),
  );
}
out.createScene('room').addChild(out.createNode('roomFurniture').setMesh(mesh));
await out.transform(quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }));
await io.write(OUT, out);
writeFileSync(`${SRC}/merge-report.json`, JSON.stringify(report, null, 2));
console.log(`出力: ${OUT} = ${(statSync(OUT).size / 1024 / 1024).toFixed(2)} MB（レポート: ${SRC}/merge-report.json）`);
