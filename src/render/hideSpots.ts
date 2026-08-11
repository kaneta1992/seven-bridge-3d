// 契約26(R28): かくれんぼ（隠れぬいぐるみ）の候補地カタログ。
//
// 設計（同期ずれゼロが最重要）:
// - 候補地は「厳選スポット（家具の上・隙間・カゴの中など意味のある位置）」+「壁沿いの家具の
//   隙間の床スポット（自動生成）」。すべて純粋データ+純粋計算で、GLB のロード成否や実行環境に
//   一切依存しない → 全クライアントで同一の配列が決定的に得られる（P2P 同期はシード共有だけで済む）。
// - 可視性は 6 席ぶんの仮想視点からのレイ vs 家具AABB（スラブ法）でモジュールロード時に検証し、
//   1席でも遮蔽される候補地は除外する（要求: 全プレイヤーから見える位置）。
// - 家具AABBは scripts/merge-furniture.mjs の出力（merge-report.json 2026-08-12）から転記した実測値。
//   部屋レイアウトを変えたら scripts/room-layout.mjs と併せてここも更新すること。
//
// 座標系: 部屋±9・floorY=-0.5。s はぬいぐるみの基準座高(1.05)に対する倍率（0.4 未満は
// 「プレイヤーから極端に小さく見える」ため使わない）。yaw は正面(ローカル+z)の方位角。

export interface HideSpot {
  x: number;
  y: number; // 接地面の高さ（ぬいぐるみのバウンディング底面をこの高さへ置く）
  z: number;
  yaw: number; // ラジアン。既定は部屋中央向き
  s: number; // スケール倍率（0.4〜0.8）
}

const FLOOR = -0.5;
const PLUSH_H = 1.05; // 基準座高（ソファの2体と同じ正規化高さ）

// 家具の実測ワールドAABB（merge-report.json より・遮蔽/重なり判定用）。
// name は保守用。table は卓（プロシージャル）の近似箱。
const BOXES: { name: string; min: [number, number, number]; max: [number, number, number] }[] = [
  { name: 'sofa', min: [-8.85, -0.5, 0.18], max: [-7.15, 1.04, 3.82] },
  { name: 'armchair', min: [5.52, -0.5, 4.5], max: [7.7, 1.15, 6.71] },
  { name: 'bookshelf', min: [8.1, -0.5, -4.3], max: [8.7, 3.7, -1.7] },
  { name: 'sideboard', min: [-1.9, -0.5, 7.95], max: [1.9, 0.8, 8.95] },
  { name: 'sidetable', min: [-8.4, -0.5, -2.2], max: [-7.2, 0.62, -1.0] },
  { name: 'coffeetable', min: [-6.6, -0.5, 1.33], max: [-5.6, 0.04, 2.67] },
  { name: 'floorlamp', min: [7.61, -0.5, -8.18], max: [8.38, 2.4, -7.42] },
  { name: 'plant1', min: [6.86, -0.5, 7.01], max: [8.7, 1.64, 8.63] },
  { name: 'plant2', min: [-8.68, -0.5, 7.06], max: [-6.83, 1.64, 8.64] },
  { name: 'plant3', min: [-8.6, -0.5, -6.96], max: [-6.98, 1.64, -5.1] },
  { name: 'tvstand', min: [2.1, -0.5, -8.75], max: [4.9, 1.5, -7.85] },
  { name: 'basket1', min: [3.82, -0.5, -5.07], max: [4.77, 0.2, -4.13] },
  { name: 'basket2', min: [-7.96, -0.5, -4.14], max: [-7.02, 0.2, -3.13] },
  { name: 'pouf', min: [2.65, -0.5, 2.25], max: [3.75, 0, 3.35] },
  { name: 'wallshelf', min: [8.43, 2.1, 1.5], max: [9.07, 3.0, 3.5] },
  { name: 'table', min: [-4.6, -0.5, -4.6], max: [4.6, 0.55, 4.6] },
  // ---- 第2弾（R29・契約27）。chandelier/hangplant は y4.18 以上＝視線より上なので不掲載 ----
  { name: 'fireplace', min: [-8.2, -0.5, -8.9], max: [-5.8, 2.1, -8.1] },
  { name: 'loveseat', min: [3.9, -0.5, 7.49], max: [6.5, 0.94, 8.91] },
  { name: 'laddershelf', min: [-5.41, -0.5, 8.13], max: [-4.59, 2.1, 8.67] },
  { name: 'barcart', min: [2.35, -0.5, 7.87], max: [3.65, 0.83, 8.73] },
  { name: 'recordconsole', min: [8.0, -0.5, -0.7], max: [8.7, 0.7, 1.3] },
  { name: 'globe', min: [6.3, -0.5, -7.0], max: [7.1, 1.05, -6.2] },
  { name: 'coatrack', min: [-8.65, -0.5, -8.65], max: [-8.08, 1.9, -8.08] },
  { name: 'dogbed', min: [-6.18, -0.5, -8.27], max: [-5.03, -0.1, -7.14] },
  { name: 'toybox', min: [-8.65, -0.5, 4.59], max: [-7.6, 0.4, 6.0] },
  { name: 'cushions', min: [5.18, -0.5, 0.58], max: [6.03, 0.05, 1.43] },
  { name: 'mirror', min: [8.5, -0.5, 3.98], max: [8.6, 1.8, 4.62] },
  { name: 'suitcases', min: [5.7, -0.5, -8.64], max: [6.7, 0.7, -8.12] },
];

const faceCenter = (x: number, z: number): number => Math.atan2(-x, -z);
const spot = (x: number, y: number, z: number, s: number, yaw = faceCenter(x, z)): HideSpot => ({ x, y, z, yaw, s });

// ---- 厳選スポット（家具と「一緒に置かれている」意味のある位置） ----------------------
const CURATED: HideSpot[] = [
  // ソファまわり（固定2体の隣・肘掛け脇の床・背もたれの上）
  spot(-8.0, 0.2, 0.75, 0.5, Math.PI / 2), // 座面の左端（2体の隣）
  spot(-8.0, 0.2, 3.25, 0.5, Math.PI / 2), // 座面の右端
  spot(-8.55, 1.04, 1.1, 0.42, Math.PI / 2), // 背もたれの上（左）
  spot(-8.55, 1.04, 2.0, 0.42, Math.PI / 2), // 背もたれの上（中央）
  spot(-8.55, 1.04, 2.9, 0.42, Math.PI / 2), // 背もたれの上（右）
  spot(-8.2, FLOOR, 4.35, 0.6), // 肘掛けの外（+z側の床・おもちゃ箱との隙間）
  spot(-8.2, FLOOR, -0.55, 0.6), // 肘掛けの外（-z側の床）
  // コーヒーテーブル（上・両脇）
  spot(-6.1, 0.04, 2.0, 0.45), // 天板の上
  spot(-6.0, FLOOR, 0.85, 0.5), // 脇
  spot(-6.0, FLOOR, 3.15, 0.5), // 脇
  // サイドテーブル（上・下の床）
  spot(-7.8, 0.62, -1.6, 0.4), // 天板の上
  spot(-7.0, FLOOR, -2.5, 0.55), // 脇の床
  // カゴ（中に隠れる・脇）
  spot(-7.5, -0.12, -3.6, 0.45), // カゴ2の中（顔だけ出す）
  spot(-6.75, FLOOR, -3.0, 0.55), // カゴ2の脇
  spot(4.3, -0.12, -4.6, 0.45), // カゴ1の中
  spot(5.05, FLOOR, -4.0, 0.55), // カゴ1の脇
  // 観葉植物の根元（3鉢）
  spot(-6.7, FLOOR, -5.5, 0.55), // plant3 の手前
  spot(-8.35, FLOOR, -7.35, 0.6), // plant3 と角の間
  spot(-6.5, FLOOR, 8.3, 0.55), // plant2 の脇
  spot(6.55, FLOOR, 8.35, 0.55), // plant1 の脇
  spot(8.45, FLOOR, 6.55, 0.55), // plant1 と壁の間
  // 本棚（上・両脇の床）
  spot(8.35, 3.7, -3.55, 0.55, faceCenter(8.35, -3.55)), // 本棚の上（左）
  spot(8.35, 3.7, -2.85, 0.5, faceCenter(8.35, -2.85)), // 本棚の上（中）
  spot(8.35, 3.7, -2.2, 0.55, faceCenter(8.35, -2.2)), // 本棚の上（右）
  spot(8.3, FLOOR, -5.15, 0.6), // 本棚の脇（窓側）
  spot(8.3, FLOOR, -0.95, 0.6), // 本棚の脇（棚と棚の間）
  // ウォールシェルフ（棚板の上・小さめだが高所で目立つ）
  spot(8.7, 2.32, 2.0, 0.4, -Math.PI / 2),
  spot(8.7, 2.32, 3.05, 0.4, -Math.PI / 2),
  // フロアランプ（台座の陰・角）
  spot(7.15, FLOOR, -7.1, 0.55),
  spot(8.5, FLOOR, -8.5, 0.6),
  // TVスタンド（脇の床・前）
  spot(1.45, FLOOR, -8.35, 0.6),
  spot(7.15, FLOOR, -8.35, 0.5), // トランクとフロアランプの間
  spot(3.5, FLOOR, -7.3, 0.5),
  // アームチェア（座面・背後・脇）
  spot(6.6, 0.12, 5.6, 0.5), // 座面の上
  spot(7.95, FLOOR, 7.0, 0.6), // 背後の角側
  spot(4.9, FLOOR, 6.45, 0.6), // 脇
  // プフ（上・脇）
  spot(3.2, 0.0, 2.8, 0.5), // プフの上
  spot(4.15, FLOOR, 3.45, 0.55), // 脇
  // サイドボード（天板の上3・両脇の床）
  spot(-1.35, 0.8, 8.4, 0.48),
  spot(0.0, 0.8, 8.4, 0.48),
  spot(1.35, 0.8, 8.4, 0.48),
  spot(-2.65, FLOOR, 8.4, 0.6),
  spot(2.1, FLOOR, 8.5, 0.45), // サイドボードとバーカートの隙間
  // 部屋の隅（家具のない隅）
  spot(-8.5, FLOOR, 8.5, 0.6),
  spot(8.5, FLOOR, 8.5, 0.6),
  // 追加の厳選（家具の「前」＝一緒に写る位置・2026-08-12 検証で候補数を確保）
  spot(-8.0, 0.2, 2.0, 0.45, Math.PI / 2), // ソファ座面の中央（固定2体の間）
  spot(-6.1, 0.04, 1.65, 0.42), // コーヒーテーブル天板（2点目）
  spot(7.4, FLOOR, -3.7, 0.55), // 本棚の前
  spot(7.4, FLOOR, -2.3, 0.55), // 本棚の前
  spot(2.6, FLOOR, -7.15, 0.5), // TV台の前（左）
  spot(4.4, FLOOR, -7.15, 0.5), // TV台の前（右）
  spot(5.55, FLOOR, 4.25, 0.55), // アームチェアの前
  spot(6.5, FLOOR, 6.95, 0.5), // plant1 とアームチェアの間
  spot(-6.35, FLOOR, 7.05, 0.55), // plant2 の手前
  spot(6.85, FLOOR, -8.35, 0.55), // フロアランプと TV台の間
  spot(3.55, FLOOR, -3.85, 0.5), // カゴ1の卓側
  spot(-0.7, 0.8, 8.4, 0.45), // サイドボード天板（追加・左中）
  spot(0.7, 0.8, 8.4, 0.45), // サイドボード天板（追加・右中）
  spot(3.5, 1.5, -8.3, 0.4), // TVの上（高所の特等席）
  // ---- 第2弾家具（R29・契約27）: 高密度化で増えた「意味のある」隠れ場所 ----
  spot(-7.6, 2.1, -8.45, 0.42), // 暖炉マントルの上（左）
  spot(-6.4, 2.1, -8.45, 0.42), // 暖炉マントルの上（右）
  spot(-7.0, FLOOR, -7.75, 0.5), // 暖炉の前（炉端）
  spot(-5.6, -0.28, -7.7, 0.48), // 犬用ベッドの中（丸まって座る）
  spot(-8.1, -0.12, 5.3, 0.45), // おもちゃ箱の中（顔だけ出す）
  spot(4.65, 0.3, 8.3, 0.45, Math.PI), // 2人掛けソファの座面（左）
  spot(5.75, 0.3, 8.3, 0.45, Math.PI), // 2人掛けソファの座面（右）
  spot(5.6, 0.05, 1.0, 0.45), // フロアクッションの上
  spot(6.2, 0.7, -8.4, 0.4), // トランクの山の上
  spot(8.35, 0.7, 0.3, 0.42, -Math.PI / 2), // レコードコンソールの上
  spot(8.3, FLOOR, 2.6, 0.5), // コンソールとミラーの間（ウォールシェルフの下）
  spot(3.0, 0.83, 8.3, 0.4, Math.PI), // バーカートの天板
  spot(6.0, FLOOR, -5.95, 0.5), // 地球儀の脇
  spot(-7.85, FLOOR, -7.85, 0.48), // コート掛けの足元（暖炉との隙間）
  spot(8.4, FLOOR, 5.2, 0.5), // ミラーとアームチェアの間
  spot(-4.0, FLOOR, 8.35, 0.5), // ラダーシェルフとサイドボードの間
  // ラグの縁（卓を囲む臙脂ラグの上・開けていて全席から見える）
  ...[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
    const a = (deg * Math.PI) / 180;
    return spot(Math.sin(a) * 5.85, FLOOR, Math.cos(a) * 5.85, 0.5);
  }),
];

// ---- 壁沿い床スポットの自動生成（家具の隙間＝意味のある「壁ぎわ」位置） ------------------
function wallRing(): HideSpot[] {
  const out: HideSpot[] = [];
  const D = 8.35; // 壁からの距離 0.65
  const pts: [number, number][] = [];
  for (let t = -7.6; t <= 7.65; t += 0.8) {
    pts.push([t, -D], [t, D], [-D, t], [D, t]);
  }
  for (const [x, z] of pts) {
    const s = 0.55;
    const half = 0.34 * s * PLUSH_H * 2; // 概略の半幅（重なり判定用）
    const hit = BOXES.some(
      (b) =>
        x + half > b.min[0] - 0.15 && x - half < b.max[0] + 0.15 &&
        z + half > b.min[2] - 0.15 && z - half < b.max[2] + 0.15 &&
        FLOOR < b.max[1], // 床高さで重なる箱のみ
    );
    if (!hit) out.push(spot(x, FLOOR, z, s));
  }
  return out;
}

// ---- 可視性検証（6席の仮想視点からのレイ vs AABB・純数学＝決定的） ----------------------
// 視点: 卓を囲む6席のカメラ近似（半径6.5・高さ3.4・60°間隔）。実カメラは首振り+ピッチ+ズームが
// できるため、やや高めの視点＝「その席から見回せば見える」の判定。ターゲットはぬいぐるみの頭部
// （接地+座高*0.8*s）。ターゲットが載っている/入っている家具の箱は遮蔽と見なさない。
const EYES: [number, number, number][] = Array.from({ length: 6 }, (_, i) => {
  const a = (i * Math.PI) / 3;
  return [Math.sin(a) * 6.5, 3.4, Math.cos(a) * 6.5];
});

function segmentHitsBox(
  e: [number, number, number], t: [number, number, number],
  b: { min: [number, number, number]; max: [number, number, number] },
): boolean {
  let t0 = 0;
  let t1 = 0.96; // ターゲット直前まで（自身の足元の面などを誤遮蔽にしない）
  const SHRINK = 0.08; // 箱をわずかに縮めて判定（かすめる程度は「見える」扱い）
  for (let k = 0; k < 3; k++) {
    const d = t[k]! - e[k]!;
    const lo = b.min[k]! + SHRINK;
    const hi = b.max[k]! - SHRINK;
    if (Math.abs(d) < 1e-9) {
      if (e[k]! < lo || e[k]! > hi) return false;
      continue;
    }
    let near = (lo - e[k]!) / d;
    let far = (hi - e[k]!) / d;
    if (near > far) [near, far] = [far, near];
    t0 = Math.max(t0, near);
    t1 = Math.min(t1, far);
    if (t0 > t1) return false;
  }
  return true;
}

function visibleFromAllSeats(p: HideSpot): boolean {
  const head: [number, number, number] = [p.x, p.y + PLUSH_H * p.s * 0.8, p.z];
  for (const eye of EYES) {
    for (const b of BOXES) {
      // ターゲットがこの箱の上/中（＝その家具に置かれている/入っている）なら、
      // その家具は住処であって遮蔽物ではない（座面・カゴの中・棚上を誤遮蔽にしない）。
      const onBox =
        p.x >= b.min[0] - 0.1 && p.x <= b.max[0] + 0.1 &&
        p.z >= b.min[2] - 0.1 && p.z <= b.max[2] + 0.1 &&
        p.y >= b.min[1] - 0.1 && p.y <= b.max[1] + 0.35;
      if (onBox) continue;
      if (segmentHitsBox(eye, head, b)) return false;
    }
  }
  return true;
}

/** 検証済みの候補地一覧（モジュールロード時に確定・全クライアントで同一）。 */
export const HIDE_SPOTS: readonly HideSpot[] = [...CURATED, ...wallRing()].filter(visibleFromAllSeats);

/** 検証・保守用の内部公開（scripts/hidespots-debug から遮蔽内訳を観測する）。実行時UIは使わない。 */
export const __hideSpotsDebug = { CURATED, wallRing, BOXES, EYES, segmentHitsBox, PLUSH_H };

/** 文字列シード→32bit ハッシュ（FNV-1a）。core/rng の shuffle 用シードに使う。 */
export function hashSeed(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
