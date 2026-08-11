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
  // ---- 第2弾（R29・契約27: 高密度化） ----
  fireplace: { size: { w: 2.4, h: 2.6, d: 0.8 }, fixYaw: 0, stretch: true },
  loveseat: { size: { w: 2.6, h: 1.5, d: 1.5 }, fixYaw: 0 },
  laddershelf: { size: { w: 1.8, h: 2.6, d: 0.9 }, fixYaw: 0 },
  barcart: { size: { w: 1.3, h: 1.4, d: 1.0 }, fixYaw: 0 },
  recordconsole: { size: { w: 2.0, h: 1.2, d: 0.7 }, fixYaw: 0, stretch: true },
  globe: { size: { w: 0.9, h: 1.6, d: 0.9 }, fixYaw: 0 },
  coatrack: { size: { w: 1.1, h: 2.4, d: 1.1 }, fixYaw: 0 },
  dogbed: { size: { w: 1.15, h: 0.4, d: 1.15 }, fixYaw: 0 },
  toybox: { size: { w: 1.3, h: 0.9, d: 0.9 }, fixYaw: 0, stretch: true },
  cushions: { size: { w: 1.0, h: 0.55, d: 1.0 }, fixYaw: 0 },
  mirror: { size: { w: 1.0, h: 2.3, d: 0.6 }, fixYaw: 0 },
  chandelier: { size: { w: 1.7, h: 1.5, d: 1.7 }, fixYaw: 0 },
  hangplant: { size: { w: 0.9, h: 1.6, d: 0.9 }, fixYaw: 0 },
  suitcases: { size: { w: 1.2, h: 1.2, d: 0.85 }, fixYaw: 0 },
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
  // ---- 第2弾（R29・契約27）。topY = バウンディング上面をこの高さへ（天井吊り用・梁の下面≈5.78） ----
  { model: 'fireplace', x: -7.0, z: -8.5, yaw: 0 }, // -z壁・窓の左
  { model: 'loveseat', x: 5.2, z: 8.2, yaw: 180 }, // +z壁・サイドボードと植物の間
  { model: 'laddershelf', x: -5.0, z: 8.4, yaw: 180 }, // +z壁・左
  { model: 'barcart', x: 3.0, z: 8.3, yaw: 180 }, // +z壁・サイドボード右
  { model: 'recordconsole', x: 8.35, z: 0.3, yaw: -90 }, // +x壁・ウォールシェルフの下
  { model: 'globe', x: 6.7, z: -6.6, yaw: 150 }, // フロアランプ手前
  { model: 'coatrack', x: -8.35, z: -8.35, yaw: 45 }, // -x/-z角
  { model: 'dogbed', x: -5.6, z: -7.7, yaw: 20 }, // 暖炉の前
  { model: 'toybox', x: -8.1, z: 5.3, yaw: 80 }, // ソファ脇（+z側）
  { model: 'cushions', x: 5.6, z: 1.0, yaw: -100 }, // ラグ外・アームチェア寄り
  { model: 'mirror', x: 8.55, z: 4.3, yaw: -90 }, // +x壁・立て掛け
  { model: 'chandelier', x: 0, z: -5.0, yaw: 0, topY: 5.78 }, // 梁から吊るす
  { model: 'hangplant', x: -5.0, z: 3.5, yaw: 30, topY: 5.78 }, // 梁の吊り植物
  { model: 'hangplant', x: 5.0, z: -3.5, yaw: 210, topY: 5.78 },
  { model: 'suitcases', x: 6.2, z: -8.35, yaw: 10 }, // TV台とフロアランプの間
];
