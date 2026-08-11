// ユーザー所有の実在ぬいぐるみ2体（契約23）をプロシージャルに再現する。外部アセット禁止（要件D7）ゆえ
// 球/カプセル/円柱などの低ポリ・プリミティブを焼き込みで組み立て、居間のソファへ寄り添って座らせる。
//
// 描画コール最小化（契約23「描画コール増は最小限に」）: 家具バッファ（scene.ts の buildFurniture）と同じ
// 「単位ジオメトリを行列で焼き込み → マテリアル毎に mergeGeometries で1メッシュへ統合」方式を踏襲し、
// ぬいぐるみ2体をわずか2描画コールに畳む:
//   1) 不透明・頂点カラー（MeshStandardMaterial vertexColors）… ソリッド色の全パーツ（両ぬいぐるみ）
//   2) ダルメシアン斑点（MeshStandardMaterial map=Canvasテクスチャ）… 白パイル地＋黒まだら斑点の頭/胴
// 斑点は契約指定どおり Canvas テクスチャで表現する（E3: このテクスチャは scene の traverse dispose では
// 解放されない map なので、felt.ts と同じくモジュールキャッシュ＋ disposePlushTextures() で明示破棄する）。
//
// 全メッシュは既定レイヤ(0)・cast/receive shadow=false ＝ 選択的Bloom（レイヤ1抽出）に一切載らず（E2）、
// 部屋の光・影・フォグにそのまま馴染む（家具と同一ポリシー）。静的オブジェクトなので統合は安全。
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

let spotTexCache: THREE.Texture | null = null;

/**
 * ダルメシアンの白パイル地＋黒の不規則なまだら斑点テクスチャ（Canvas・契約23「斑点はCanvasテクスチャで」）。
 * 頭/胴の球にそのまま UV(0..1) で貼られ、大小さまざまの斑点が面を覆う。パイルの微ノイズも焼き込む。
 */
function spotTexture(): THREE.Texture {
  if (spotTexCache) return spotTexCache;
  const S = 512;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;

  // 白パイル地（ほんのり暖色オフホワイト）
  ctx.fillStyle = '#f1efe9';
  ctx.fillRect(0, 0, S, S);

  // 黒の不規則斑点。1斑点 = 数個の円を重ねて「にじんだ不定形」にする。大小をばらつかせる。
  // 決定的な疑似乱数（シード固定）で毎回同じ模様にする（テスト/検証の再現性）。
  let seed = 0x51ed;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const blob = (cx: number, cy: number, r: number): void => {
    ctx.fillStyle = '#161616';
    const lobes = 3 + Math.floor(rnd() * 4);
    for (let i = 0; i < lobes; i++) {
      const a = rnd() * Math.PI * 2;
      const d = rnd() * r * 0.6;
      const rr = r * (0.5 + rnd() * 0.6);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rr, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  // 大きめの斑点をまばらに + 小さめを散らす（顔にも数個乗るよう全面に分布）。
  for (let i = 0; i < 12; i++) blob(rnd() * S, rnd() * S, 24 + rnd() * 34);
  for (let i = 0; i < 26; i++) blob(rnd() * S, rnd() * S, 8 + rnd() * 14);

  // パイルの微ノイズ（ふわっとした質感の下地）。
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * 14;
    d[i] = Math.max(0, Math.min(255, d[i]! + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1]! + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2]! + n));
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  spotTexCache = tex;
  return tex;
}

/** ぬいぐるみの Canvas テクスチャを破棄しキャッシュを空にする（シーン破棄時・felt.ts と同じ責務分界）。 */
export function disposePlushTextures(): void {
  if (spotTexCache) {
    spotTexCache.dispose();
    spotTexCache = null;
  }
}

export interface PlushBuild {
  group: THREE.Group;
  /** このグループが増やす描画コール数（報告用・統合後）。 */
  drawCalls: number;
}

/**
 * ダルメシアンの子犬と青いパンダを、ソファ座面の上に肩が触れる距離で並べて座らせる（契約23）。
 * @param seatTopY ソファ座面の上面 Y（ぬいぐるみのお尻をここに接地させる）
 * @param seatCenterX ソファ座面の中心 X（背もたれは -X 側。ぬいぐるみは +X＝部屋の中心/卓を向く）
 * @param zCenter 2体の中心 Z（パンダを +Z 側＝正面から見て概ね左、ダルメシアンを -Z 側に配置）
 */
export function buildPlushDolls(seatTopY: number, seatCenterX: number, zCenter: number): PlushBuild {
  // 座高の目安: 契約は「カード(約9cm=1u)の2.5倍≈2.5u」を挙げるが、このソファ（背もたれ上端は座面から
  // 約0.95u）に対して2.5uは過大で不自然。DECISION: 座高 ≈ 1.4u（頭上端は座面+約1.4u＝背もたれ上端より
  // 少し上に頭が覗く）を採る。ソファに自然に凭れつつ、首振り/シネマのワイドで愛らしく視認できるサイズ。
  // 契約の「部屋との対比で自然に見えるサイズを選ぶ」を優先した。
  const s = 1.15;
  // お尻をわずかに背もたれ側へ寄せて背に凭れる姿勢に（背もたれは -X 側）。
  const backX = seatCenterX - 0.12;

  const opaque: THREE.BufferGeometry[] = []; // 頂点カラー・不透明バケット（両ぬいぐるみのソリッド色）
  const spotted: THREE.BufferGeometry[] = []; // 斑点テクスチャ・バケット（ダルメシアンの白パイル頭/胴）

  const tmpCol = new THREE.Color();
  const P = new THREE.Vector3();
  const Q = new THREE.Quaternion();
  const Eu = new THREE.Euler();
  const Sc = new THREE.Vector3();
  const M = new THREE.Matrix4();

  // 単位ジオメトリを (位置, 回転, 拡縮) で焼き込み、任意で頂点カラーを塗ってバケットへ積む。
  // color=null のときは頂点カラーを塗らず UV を温存する（斑点テクスチャ用バケット向け）。
  const bake = (
    bucket: THREE.BufferGeometry[], geom: THREE.BufferGeometry, color: string | null,
    x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0,
  ): void => {
    Eu.set(rx, ry, rz, 'YXZ');
    Q.setFromEuler(Eu);
    M.compose(P.set(x, y, z), Q, Sc.set(sx, sy, sz));
    geom.applyMatrix4(M);
    if (color !== null) {
      tmpCol.set(color).convertSRGBToLinear();
      const n = geom.attributes.position.count;
      const ca = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        ca[i * 3] = tmpCol.r;
        ca[i * 3 + 1] = tmpCol.g;
        ca[i * 3 + 2] = tmpCol.b;
      }
      geom.setAttribute('color', new THREE.Float32BufferAttribute(ca, 3));
    }
    bucket.push(geom);
  };
  const sphere = (): THREE.BufferGeometry => new THREE.SphereGeometry(0.5, 18, 14); // 単位直径1
  const capsule = (r: number, len: number): THREE.BufferGeometry => new THREE.CapsuleGeometry(r, len, 6, 12);

  // 1体分を局所座標（原点=お尻の接地点・+x=正面/前方・+y=上）で組み、anchor へ s 倍で配置するビルダ。
  // put(): ソリッド色（頂点カラー）→ opaque。 spot(): 斑点テクスチャ → spotted（頂点カラーなし）。
  const makeDoll = (
    kind: 'dog' | 'panda', anchorX: number, anchorZ: number,
    build: (
      put: (geom: THREE.BufferGeometry, color: string, lx: number, ly: number, lz: number, sx?: number, sy?: number, sz?: number, rx?: number, ry?: number, rz?: number) => void,
      spot: (geom: THREE.BufferGeometry, lx: number, ly: number, lz: number, sx?: number, sy?: number, sz?: number) => void,
    ) => void,
  ): void => {
    const toWorld = (l: number): number => l * s;
    const put = (
      geom: THREE.BufferGeometry, color: string, lx: number, ly: number, lz: number,
      sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0,
    ): void =>
      bake(opaque, geom, color, anchorX + toWorld(lx), seatTopY + toWorld(ly), anchorZ + toWorld(lz),
        sx * s, sy * s, sz * s, rx, ry, rz);
    const spot = (
      geom: THREE.BufferGeometry, lx: number, ly: number, lz: number, sx = 1, sy = 1, sz = 1,
    ): void =>
      bake(spotted, geom, null, anchorX + toWorld(lx), seatTopY + toWorld(ly), anchorZ + toWorld(lz),
        sx * s, sy * s, sz * s);
    build(put, spot);
    void kind;
  };

  // ---- ダルメシアンの子犬（-Z 側） --------------------------------------------------
  // 白パイル地＋黒まだら斑点・大きく垂れた黒耳・黒丸鼻/茶ボタン目・白マズル・濃紺デニムのオーバーオール。
  makeDoll('dog', backX, zCenter - 0.42, (put, spot) => {
    const denim = '#243a63'; // 濃紺デニム
    const black = '#141414';
    const white = '#f1efe9';
    // 胴・頭（斑点テクスチャ）: ぷっくり大きめの頭（デフォルメ）。
    spot(sphere(), 0.02, 0.34, 0, 0.68, 0.62, 0.70); // 胴（少し縦つぶし）
    spot(sphere(), 0.07, 0.86, 0, 0.70, 0.68, 0.72); // 頭（大きめ）
    // マズル（白・前方下）+ 黒丸鼻 + 茶ボタン目。
    put(sphere(), white, 0.34, 0.80, 0, 0.32, 0.26, 0.32);
    put(sphere(), black, 0.48, 0.83, 0, 0.13, 0.12, 0.13); // 鼻
    put(sphere(), '#5a3a20', 0.31, 0.97, 0.15, 0.10, 0.11, 0.10); // 右目
    put(sphere(), '#5a3a20', 0.31, 0.97, -0.15, 0.10, 0.11, 0.10); // 左目
    // 大きく垂れた黒耳（頭頂から左右へだらんと。-Z 耳は少し立ち気味＝可愛い非対称）。
    put(sphere(), black, -0.02, 0.66, 0.36, 0.16, 0.50, 0.26, 0, 0, 0.22);
    put(sphere(), black, 0.02, 0.72, -0.36, 0.16, 0.46, 0.26, 0, 0, -0.10);
    // 前脚を前へ投げ出す（白・水平カプセル）+ 丸い前足。
    put(capsule(0.11, 0.16), white, 0.30, 0.13, 0.17, 1, 1, 1, 0, 0, -Math.PI / 2);
    put(capsule(0.11, 0.16), white, 0.30, 0.13, -0.17, 1, 1, 1, 0, 0, -Math.PI / 2);
    put(sphere(), white, 0.50, 0.11, 0.17, 0.20, 0.16, 0.20);
    put(sphere(), white, 0.50, 0.11, -0.17, 0.20, 0.16, 0.20);
    // 短い後脚（体側で丸まる）。
    put(sphere(), white, -0.02, 0.14, 0.34, 0.24, 0.20, 0.24);
    put(sphere(), white, -0.02, 0.14, -0.34, 0.24, 0.20, 0.24);
    // デニムのオーバーオール: 胴回りのウエスト（切頭円錐）+ 胸当て + 肩紐×2 + 膝の当て布（破れ表現）。
    put(new THREE.CylinderGeometry(0.34, 0.40, 0.42, 16), denim, 0.02, 0.30, 0, 1, 1, 1); // ウエスト/腰回り
    put(new THREE.BoxGeometry(0.06, 0.26, 0.34), denim, 0.31, 0.52, 0); // 胸当て（前面）
    put(new THREE.BoxGeometry(0.34, 0.06, 0.08), denim, 0.14, 0.70, 0.13, 1, 1, 1, 0, 0, -0.5); // 肩紐右
    put(new THREE.BoxGeometry(0.34, 0.06, 0.08), denim, 0.14, 0.70, -0.13, 1, 1, 1, 0, 0, -0.5); // 肩紐左
    put(new THREE.BoxGeometry(0.03, 0.10, 0.13), '#6a86bf', 0.36, 0.17, 0.17); // 膝当て（破れの明色）右
    put(new THREE.BoxGeometry(0.03, 0.10, 0.13), '#6a86bf', 0.36, 0.17, -0.17); // 膝当て左
    // 白い襟（首元の薄いトーラス）。
    put(new THREE.TorusGeometry(0.22, 0.05, 8, 20), white, 0.12, 0.64, 0, 1, 1, 1, Math.PI / 2, 0, 0);
  });

  // ---- 青いパンダ（+Z 側） ---------------------------------------------------------
  // 白ボディ＋青の耳/目パッチ/手足先・茶丸鼻・黒丸目・にっこり口（縫い目風）・白いワンピース。
  makeDoll('panda', backX, zCenter + 0.42, (put) => {
    const white = '#f4f2ec';
    const blue = '#2f6fd0'; // 鮮やかな青
    const black = '#141414';
    const stitch = '#6b4a3a'; // 縫い目風の口
    // 胴・頭（白・丸くふっくら。頭は特に大きめのデフォルメ）。
    put(sphere(), white, 0.02, 0.34, 0, 0.68, 0.62, 0.70); // 胴
    put(sphere(), white, 0.06, 0.88, 0, 0.72, 0.70, 0.74); // 頭
    // 青い丸耳（頭頂の左右）。
    put(sphere(), blue, -0.04, 1.16, 0.24, 0.26, 0.24, 0.20);
    put(sphere(), blue, -0.04, 1.16, -0.24, 0.26, 0.24, 0.20);
    // 青い目パッチ（顔に平たく貼る）+ 黒丸目。
    put(sphere(), blue, 0.30, 0.94, 0.16, 0.12, 0.24, 0.22);
    put(sphere(), blue, 0.30, 0.94, -0.16, 0.12, 0.24, 0.22);
    put(sphere(), black, 0.37, 0.94, 0.16, 0.11, 0.12, 0.11);
    put(sphere(), black, 0.37, 0.94, -0.16, 0.11, 0.12, 0.11);
    // 茶色の丸鼻。
    put(sphere(), stitch, 0.40, 0.83, 0, 0.12, 0.11, 0.12);
    // にっこりした小さな口（縫い目風の曲線＝小さな点を上向きの弧に並べる）。
    const smile: [number, number][] = [[-0.11, 0.755], [-0.06, 0.735], [0, 0.728], [0.06, 0.735], [0.11, 0.755]];
    for (const [lz, ly] of smile) put(sphere(), stitch, 0.44, ly, lz, 0.055, 0.05, 0.055);
    // 腕（白）+ 青い手先。
    put(capsule(0.10, 0.16), white, 0.20, 0.36, 0.30, 1, 1, 1, 0, 0, -Math.PI / 2);
    put(capsule(0.10, 0.16), white, 0.20, 0.36, -0.30, 1, 1, 1, 0, 0, -Math.PI / 2);
    put(sphere(), blue, 0.40, 0.30, 0.30, 0.19, 0.17, 0.19);
    put(sphere(), blue, 0.40, 0.30, -0.30, 0.19, 0.17, 0.19);
    // 脚（白）を前へ + 青い足先。
    put(capsule(0.11, 0.16), white, 0.28, 0.13, 0.16, 1, 1, 1, 0, 0, -Math.PI / 2);
    put(capsule(0.11, 0.16), white, 0.28, 0.13, -0.16, 1, 1, 1, 0, 0, -Math.PI / 2);
    put(sphere(), blue, 0.49, 0.11, 0.16, 0.20, 0.18, 0.22);
    put(sphere(), blue, 0.49, 0.11, -0.16, 0.20, 0.18, 0.22);
    // 白いワンピース: 裾広がりのスカート（切頭円錐）+ 首元の襟。柔らかい生地感。
    put(new THREE.CylinderGeometry(0.30, 0.46, 0.52, 18), white, 0.02, 0.24, 0, 1, 1, 1);
    put(new THREE.TorusGeometry(0.24, 0.05, 8, 20), white, 0.08, 0.66, 0, 1, 1, 1, Math.PI / 2, 0, 0);
    // ワンピースに散る小さな模様（淡い色の点・忠実性の一筆）。
    const dots: [number, number, number, string][] = [
      [0.36, 0.20, 0.10, '#f4b8cf'], [0.34, 0.30, -0.14, '#a9c8f0'],
      [0.30, 0.14, -0.02, '#f4d79a'], [0.33, 0.26, 0.16, '#a9c8f0'], [0.31, 0.17, -0.18, '#f4b8cf'],
    ];
    for (const [lx, ly, lz, c] of dots) put(sphere(), c, lx, ly, lz, 0.05, 0.05, 0.05);
  });

  // ---- バケットをマテリアル毎に1メッシュへ統合（描画コール = 空でないバケット数） ----
  const group = new THREE.Group();
  group.name = 'plushDolls';
  let drawCalls = 0;
  const flush = (bucket: THREE.BufferGeometry[], material: THREE.Material): void => {
    if (!bucket.length) return;
    const merged = mergeGeometries(bucket, false); // useGroups=false ＝ 1グループ＝1描画コール
    for (const g of bucket) g.dispose?.();
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = false; // 家具と同一ポリシー（影計算に載せない）
    mesh.receiveShadow = false;
    group.add(mesh);
    drawCalls++;
  };
  flush(opaque, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.94, metalness: 0 }));
  flush(spotted, new THREE.MeshStandardMaterial({ map: spotTexture(), roughness: 0.92, metalness: 0 }));

  return { group, drawCalls };
}
