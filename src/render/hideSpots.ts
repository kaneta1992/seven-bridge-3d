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
  // R30（契約28）ごちゃっと配置版 merge-report.json（2026-08-12）より転記。
  // chandelier/hangplant は y4.18 以上＝視線より上なので不掲載。
  { name: 'sofa', min: [-8.85, -0.5, 0.18], max: [-7.15, 1.04, 3.82] },
  { name: 'coffeetable', min: [-6.73, -0.5, 1.41], max: [-5.58, 0.04, 2.79] },
  { name: 'pouf1', min: [-6.54, -0.5, 3.05], max: [-5.46, 0, 4.14] },
  { name: 'toybox', min: [-8.64, -0.5, 4.11], max: [-7.21, 0.4, 5.65] },
  { name: 'dogbed', min: [-8.12, -0.5, -1.48], max: [-6.97, -0.1, -0.32] },
  { name: 'sidetable1', min: [-8.56, -0.5, -2.75], max: [-7.35, 0.62, -1.54] },
  { name: 'basket1', min: [-7.19, -0.5, -3.5], max: [-6.24, 0.2, -2.57] },
  { name: 'cushions1', min: [-6.23, -0.5, 0.17], max: [-5.46, 0, 0.93] },
  { name: 'plant1', min: [-8.93, -0.5, 5.86], max: [-7.08, 1.64, 7.44] },
  { name: 'fireplace', min: [-8.1, -0.5, -8.85], max: [-5.7, 2.1, -8.05] },
  { name: 'basket2', min: [-5.55, -0.5, -8.67], max: [-4.5, 0.31, -7.56] },
  { name: 'coatrack', min: [-8.75, -0.5, -8.6], max: [-8.17, 1.9, -8.01] },
  { name: 'plant2', min: [-8.8, -0.5, -7.46], max: [-7.18, 1.64, -5.6] },
  { name: 'cushions2', min: [-2.41, -0.5, -8.17], max: [-1.58, 0.05, -7.32] },
  { name: 'tvstand', min: [1.17, -0.5, -8.94], max: [4.04, 1.5, -7.81] },
  { name: 'suitcases1', min: [4.24, -0.5, -8.4], max: [5.24, 0.7, -7.65] },
  { name: 'armchair', min: [5.53, -0.5, -7.23], max: [7.67, 1.15, -5.14] },
  { name: 'globe', min: [4.91, -0.5, -7.52], max: [5.79, 1.05, -6.68] },
  { name: 'sidetable2', min: [7.46, -0.5, -5.54], max: [8.54, 0.51, -4.45] },
  { name: 'floorlamp', min: [7.56, -0.5, -7.98], max: [8.33, 2.4, -7.22] },
  { name: 'suitcases2', min: [8.13, -0.5, -6.78], max: [8.63, 0.52, -5.92] },
  { name: 'bookshelf', min: [8.15, -0.5, -4.2], max: [8.75, 3.7, -1.6] },
  { name: 'basket3', min: [7.73, -0.5, -1.38], max: [8.59, 0.13, -0.54] },
  { name: 'recordconsole', min: [8.05, -0.5, -0.4], max: [8.75, 0.7, 1.6] },
  { name: 'wallshelf', min: [8.43, 2.1, 1.5], max: [9.07, 3.0, 3.5] },
  { name: 'mirror', min: [8.39, -0.5, 3.83], max: [8.61, 1.8, 4.47] },
  { name: 'loveseat', min: [5.32, -0.5, 5.55], max: [8.1, 0.94, 8.27] },
  { name: 'pouf2', min: [4.11, -0.5, 5.05], max: [5.09, -0.05, 6.04] },
  { name: 'cushions3', min: [4.92, -0.5, 3.93], max: [5.77, 0.05, 4.76] },
  { name: 'plant3', min: [7.4, -0.5, 7.53], max: [8.96, 1.32, 8.9] },
  { name: 'sideboard', min: [-1.6, -0.5, 8.0], max: [2.2, 0.8, 9.0] },
  { name: 'barcart', min: [2.34, -0.5, 7.53], max: [3.67, 0.83, 8.53] },
  { name: 'basket4', min: [-3.61, -0.5, 7.83], max: [-2.77, 0.13, 8.69] },
  { name: 'laddershelf', min: [-5.08, -0.5, 7.98], max: [-4.23, 2.1, 8.62] },
  { name: 'plant4', min: [-7.09, -0.5, 7.24], max: [-5.63, 1.42, 8.92] },
  { name: 'plant5', min: [-8.88, -0.5, 7.16], max: [-7.03, 1.64, 8.74] },
  { name: 'table', min: [-4.6, -0.5, -4.6], max: [4.6, 0.55, 4.6] },
];

const faceCenter = (x: number, z: number): number => Math.atan2(-x, -z);
const spot = (x: number, y: number, z: number, s: number, yaw = faceCenter(x, z)): HideSpot => ({ x, y, z, yaw, s });

// ---- 厳選スポット（家具と「一緒に置かれている」意味のある位置・R30 ごちゃっと配置版） ------
const CURATED: HideSpot[] = [
  // ソファ・リビングゾーン
  spot(-8.0, 0.2, 0.75, 0.5, Math.PI / 2), // 座面の左端（2体の隣）
  spot(-8.0, 0.2, 2.0, 0.45, Math.PI / 2), // 座面の中央（固定2体の間）
  spot(-8.0, 0.2, 3.25, 0.5, Math.PI / 2), // 座面の右端
  spot(-8.55, 1.04, 1.1, 0.42, Math.PI / 2), // 背もたれの上（左）
  spot(-8.55, 1.04, 2.0, 0.42, Math.PI / 2), // 背もたれの上（中央）
  spot(-8.55, 1.04, 2.9, 0.42, Math.PI / 2), // 背もたれの上（右）
  spot(-6.15, 0.04, 2.1, 0.42), // コーヒーテーブルの上
  spot(-6.0, 0.0, 3.6, 0.45), // プフ1の上
  spot(-5.85, 0.0, 0.55, 0.42), // フロアクッション1の上
  spot(-7.9, -0.1, 4.9, 0.45), // おもちゃ箱の中（顔だけ出す）
  spot(-6.6, FLOOR, 4.6, 0.5), // おもちゃ箱の前
  spot(-7.55, -0.28, -0.9, 0.48), // 犬用ベッドの中（丸まって座る）
  spot(-7.95, 0.62, -2.15, 0.4), // サイドテーブル1の上
  spot(-6.7, -0.12, -3.05, 0.45), // カゴ1の中
  spot(-5.9, FLOOR, -2.4, 0.5), // カゴとテーブルの間
  spot(-6.7, FLOOR, 6.4, 0.5), // 植物1の根元
  // 暖炉・窓ゾーン
  spot(-7.5, 2.1, -8.4, 0.42), // 暖炉マントルの上（左）
  spot(-6.3, 2.1, -8.4, 0.42), // 暖炉マントルの上（右）
  spot(-6.9, FLOOR, -7.55, 0.5), // 暖炉の前（炉端）
  spot(-5.0, -0.05, -8.1, 0.45), // 薪入れカゴの中
  spot(-7.95, FLOOR, -7.85, 0.48), // コート掛けの足元（暖炉との隙間）
  spot(-7.0, FLOOR, -5.2, 0.55), // 植物2の手前
  spot(-2.0, 0.05, -7.75, 0.42), // 窓下クッションの上
  spot(-3.6, FLOOR, -8.3, 0.55), // 薪カゴと窓クッションの間
  spot(-0.6, FLOOR, -8.35, 0.55), // 窓の下（クッションの隣）
  spot(2.6, 1.5, -8.4, 0.4), // TVの上（高所の特等席）
  spot(2.6, FLOOR, -7.2, 0.5), // TV台の前
  spot(0.4, FLOOR, -7.9, 0.5), // TV台と窓クッションの間
  spot(4.75, 0.7, -8.05, 0.4), // トランクの山の上
  // 読書ヌック（+x/-z角）
  spot(6.6, 0.12, -6.2, 0.5, faceCenter(6.6, -6.2)), // アームチェアの座面
  spot(4.3, FLOOR, -6.6, 0.5), // 地球儀の脇（卓側）
  spot(8.0, 0.51, -5.0, 0.4), // サイドテーブル2の上
  spot(7.0, FLOOR, -8.35, 0.5), // フロアランプとアームチェアの後ろ
  spot(8.38, 0.52, -6.35, 0.4), // トランク2の上
  spot(8.55, FLOOR, -8.5, 0.55), // 角（ランプの陰）
  spot(5.9, FLOOR, -4.6, 0.5), // アームチェアの前（卓側）
  // +x壁
  spot(8.35, 3.7, -3.5, 0.55, faceCenter(8.35, -3.5)), // 本棚の上（左）
  spot(8.35, 3.7, -2.9, 0.5, faceCenter(8.35, -2.9)), // 本棚の上（中）
  spot(8.35, 3.7, -2.3, 0.55, faceCenter(8.35, -2.3)), // 本棚の上（右）
  spot(7.5, FLOOR, -3.6, 0.55), // 本棚の前（左）
  spot(7.5, FLOOR, -2.2, 0.55), // 本棚の前（右）
  spot(8.15, -0.2, -0.95, 0.4), // カゴ3の中（本棚とコンソールの間）
  spot(8.4, 0.7, 0.6, 0.42, -Math.PI / 2), // レコードコンソールの上
  spot(8.35, FLOOR, 2.7, 0.5), // コンソールとミラーの間（ウォールシェルフの下）
  spot(8.7, 2.32, 2.0, 0.4, -Math.PI / 2), // ウォールシェルフ（左）
  spot(8.7, 2.32, 3.05, 0.4, -Math.PI / 2), // ウォールシェルフ（右）
  spot(8.5, FLOOR, 5.05, 0.5), // ミラーの足元
  // 2人掛けコーナー（+x/+z角）
  spot(6.19, 0.3, 7.38, 0.45, (-137 * Math.PI) / 180), // 2人掛けの座面（左）
  spot(7.21, 0.3, 6.42, 0.45, (-137 * Math.PI) / 180), // 2人掛けの座面（右）
  spot(4.6, -0.05, 5.55, 0.45), // プフ2の上
  spot(5.35, 0.05, 4.35, 0.42), // フロアクッション3の上
  spot(8.65, FLOOR, 6.4, 0.5), // 2人掛けと壁の間
  spot(4.2, FLOOR, 7.0, 0.5), // プフ2と2人掛けの間
  // +z壁
  spot(-1.05, 0.8, 8.45, 0.48), // サイドボードの上×5
  spot(-0.4, 0.8, 8.45, 0.45),
  spot(0.3, 0.8, 8.45, 0.48),
  spot(1.0, 0.8, 8.45, 0.45),
  spot(1.65, 0.8, 8.45, 0.48),
  spot(3.0, 0.83, 8.0, 0.4, Math.PI), // バーカートの天板
  spot(4.5, FLOOR, 8.5, 0.5), // バーカートと2人掛けの間
  spot(-3.2, -0.15, 8.25, 0.42), // カゴ4の中
  spot(-2.2, FLOOR, 8.5, 0.5), // カゴ4とサイドボードの間
  spot(-4.6, FLOOR, 7.3, 0.5), // ラダーシェルフの前
  spot(-6.3, FLOOR, 6.8, 0.5), // 植物4の手前
  // ゾーン間の隙間・高所（R30 追加分）
  spot(-6.9, 2.1, -8.4, 0.42), // 暖炉マントルの上（中央）
  spot(7.07, 0.94, 7.3, 0.4, (-137 * Math.PI) / 180), // 2人掛けの背もたれの上
  spot(1.2, FLOOR, 7.4, 0.5), // サイドボードの前（右）
  spot(-0.9, FLOOR, 7.5, 0.5), // サイドボードの前（左）
  spot(7.2, FLOOR, 4.7, 0.5), // ミラーと2人掛けの間
  spot(3.3, FLOOR, 7.0, 0.5), // バーカートの前
  spot(1.5, FLOOR, -7.5, 0.5), // TV台の脇（卓側）
  spot(-4.15, FLOOR, -7.9, 0.5), // 薪カゴの脇
  spot(-3.0, FLOOR, 6.9, 0.5), // カゴ4の前
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
