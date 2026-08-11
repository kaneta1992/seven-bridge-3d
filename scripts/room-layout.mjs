// R27: 部屋レイアウトの単一ソース（契約25）。
// - merge-furniture.mjs がこの定義どおりに Meshy GLB をワールド座標へ焼き込む。
// - R28 のかくれんぼ候補地（アンカースロット）もこの配置から導出する。
// 座標系: 部屋 18x18・高さ6.6 / floorY=-0.5 / 壁内面 ±9 / 卓は原点・ラグ半径5.2。
// yaw: モデル正面(ローカル+z)が向く方位角[deg]。dir=(sin yaw, 0, cos yaw)。
// fixYaw: Meshy 生成モデルの「正面」をローカル+z に直す事前回転[deg]（視覚確認して調整する）。

export const FLOOR_Y = -0.5;
export const WALL = 9;

// モデル定義: size = ローカル軸 {w(x), h(y), d(z)} の目標バウンディング。
// stretch: true = 軸別スケール（箱物家具向け。均等フィットだと最小軸に潰されるため）。
// 視覚検証済み（2026-08-12）: 箱物3種は stretch、wallshelf は fixYaw 90 が必要。
export const MODELS = {
  sofa: { size: { w: 4.3, h: 1.7, d: 1.7 }, fixYaw: 0 },
  armchair: { size: { w: 1.7, h: 1.7, d: 1.7 }, fixYaw: 0 },
  bookshelf: { size: { w: 2.6, h: 4.2, d: 0.6 }, fixYaw: 0, stretch: true },
  sideboard: { size: { w: 3.8, h: 1.3, d: 1.0 }, fixYaw: 0, stretch: true },
  sidetable: { size: { w: 1.2, h: 1.15, d: 1.2 }, fixYaw: 0 },
  coffeetable: { size: { w: 1.9, h: 0.55, d: 1.0 }, fixYaw: 0 },
  floorlamp: { size: { w: 0.95, h: 2.9, d: 0.95 }, fixYaw: 0 },
  plant: { size: { w: 1.7, h: 2.3, d: 1.7 }, fixYaw: 0 },
  tvstand: { size: { w: 2.8, h: 2.0, d: 0.9 }, fixYaw: 0, stretch: true },
  basket: { size: { w: 0.95, h: 0.75, d: 0.95 }, fixYaw: 0 },
  pouf: { size: { w: 1.1, h: 0.5, d: 1.1 }, fixYaw: 0 },
  wallshelf: { size: { w: 2.0, h: 0.9, d: 0.65 }, fixYaw: 90, stretch: true },
};

// 配置インスタンス: 同じモデルを複数置ける（ジオメトリ複製・テクスチャ共有＝Meshy費用ゼロ）。
// yOff: バウンディング底面の floorY からの持ち上げ（壁掛け用）。
export const INSTANCES = [
  { model: 'sofa', x: -8.0, z: 2.0, yaw: 90 }, // -x壁・卓向き（ぬいぐるみ着座位置＝現行踏襲）
  { model: 'armchair', x: 6.6, z: 5.6, yaw: -130 }, // 新規・+x/+z角から卓向き
  { model: 'bookshelf', x: 8.4, z: -3.0, yaw: -90 }, // +x壁
  { model: 'sideboard', x: 0.0, z: 8.45, yaw: 180 }, // +z壁（額の下）
  { model: 'sidetable', x: -7.8, z: -1.6, yaw: 20 }, // ソファ脇
  { model: 'coffeetable', x: -6.1, z: 2.0, yaw: 90 }, // 新規・ソファ前（ラグ外周）
  { model: 'floorlamp', x: 8.0, z: -7.8, yaw: -45 }, // +x/-z角（本棚と窓の間）
  { model: 'plant', x: 7.8, z: 7.8, yaw: 200 },
  { model: 'plant', x: -7.8, z: 7.8, yaw: 40 },
  { model: 'plant', x: -7.8, z: -6.0, yaw: 120 },
  { model: 'tvstand', x: 3.5, z: -8.3, yaw: 0 }, // 新規・-z壁（窓の隣）
  { model: 'basket', x: 4.3, z: -4.6, yaw: 0 },
  { model: 'basket', x: -7.5, z: -3.6, yaw: 70 },
  { model: 'pouf', x: 3.2, z: 2.8, yaw: 0 },
  { model: 'wallshelf', x: 8.75, z: 2.5, yaw: -90, yOff: 2.6 }, // 新規・+x壁の高所
];
