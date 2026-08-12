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
  // ---- 第3弾（R31・契約29: 壁の情報量） ----
  painting: { size: { w: 1.6, h: 1.2, d: 0.12 }, fixYaw: 0, stretch: true },
  macrame: { size: { w: 1.1, h: 1.5, d: 0.15 }, fixYaw: 0, stretch: true },
  wallclock: { size: { w: 0.8, h: 0.8, d: 0.18 }, fixYaw: 0, stretch: true },
  // ---- 第4弾（R32・契約30: 天面の小物）----
  // ---- 第5弾（R34・契約31: 囮ぬいぐるみ+カモフラ小物＝難度8）----
  pengplush: { size: { w: 0.4, h: 0.45, d: 0.4 }, fixYaw: 0 },
  bunnyplush: { size: { w: 0.45, h: 0.5, d: 0.45 }, fixYaw: 0 },
  teddybear: { size: { w: 0.5, h: 0.5, d: 0.5 }, fixYaw: 0 },
  catplush: { size: { w: 0.45, h: 0.42, d: 0.45 }, fixYaw: 0 },
  blanketpile: { size: { w: 0.7, h: 0.5, d: 0.55 }, fixYaw: 0 },
  pillowpair: { size: { w: 0.7, h: 0.5, d: 0.35 }, fixYaw: 0 },
  bookstack: { size: { w: 0.45, h: 0.32, d: 0.32 }, fixYaw: 0 },
  vaseset: { size: { w: 0.35, h: 0.6, d: 0.35 }, fixYaw: 0 },
  teaset: { size: { w: 0.5, h: 0.28, d: 0.4 }, fixYaw: 0 },
  candleset: { size: { w: 0.35, h: 0.42, d: 0.35 }, fixYaw: 0 },
  photoframes: { size: { w: 0.42, h: 0.32, d: 0.18 }, fixYaw: 0 },
  miniplant: { size: { w: 0.3, h: 0.35, d: 0.3 }, fixYaw: 0 },
};

// 配置インスタンス: 同じモデルを複数置ける（ジオメトリ複製・テクスチャ共有＝Meshy費用ゼロ）。
// yOff: バウンディング底面の floorY からの持ち上げ（壁掛け用）/ topY: 上面基準（天井吊り）/
// scale: 追加倍率（複製に大小を付けて自然に）。
//
// R30（契約28）: 「壁沿いに整列して機械的」→ ゾーン単位のごちゃっと配置へ全面改訂。
// - 生活ゾーン（ソファ回り / 暖炉回り / 読書ヌック / 2人掛けコーナー）に家具を寄せて群を作る
// - 壁置きも角度を数度〜数十度振って整列感を崩す。複製（植物5/カゴ4/クッション3/プフ2/トランク2/
//   サイドテーブル2/吊り植物3）で密度を出す
// - 制約: 卓+ラグ（半径5.2）不可侵 / カメラリング（半径≈6.1・高さ2.7）付近は背の低い物のみ /
//   背の高い家具は壁際 r>7 に留める
export const INSTANCES = [
  // ---- ソファ・リビングゾーン（-x壁）: ぬいぐるみ2体の定位置は不変 ----
  { model: 'sofa', x: -8.0, z: 2.0, yaw: 90 },
  { model: 'coffeetable', x: -6.15, z: 2.1, yaw: 78 },
  { model: 'pouf', x: -6.0, z: 3.6, yaw: 30 },
  { model: 'toybox', x: -7.9, z: 4.9, yaw: 55 },
  { model: 'dogbed', x: -7.55, z: -0.9, yaw: -15 },
  { model: 'sidetable', x: -7.95, z: -2.15, yaw: 35 },
  { model: 'basket', x: -6.7, z: -3.05, yaw: 100 },
  { model: 'cushions', x: -5.85, z: 0.55, yaw: -60, scale: 0.9 },
  { model: 'plant', x: -8.05, z: 6.6, yaw: 40 },
  // ---- 暖炉・窓ゾーン（-z壁） ----
  { model: 'fireplace', x: -6.9, z: -8.45, yaw: 0 },
  { model: 'basket', x: -5.0, z: -8.1, yaw: 20, scale: 1.15 }, // 薪入れカゴ
  { model: 'coatrack', x: -8.45, z: -8.3, yaw: 30 },
  { model: 'plant', x: -8.0, z: -6.5, yaw: 120 },
  { model: 'cushions', x: -2.0, z: -7.75, yaw: 200 }, // 窓の下
  { model: 'tvstand', x: 2.6, z: -8.35, yaw: -6 },
  { model: 'suitcases', x: 4.75, z: -8.0, yaw: 28 },
  // ---- 読書ヌック（+x/-z角）: アームチェアを壁から離し卓向きに斜め置き ----
  { model: 'armchair', x: 6.6, z: -6.2, yaw: -152 },
  { model: 'globe', x: 5.35, z: -7.1, yaw: 170 },
  { model: 'sidetable', x: 8.0, z: -5.0, yaw: -30, scale: 0.9 },
  { model: 'floorlamp', x: 7.95, z: -7.6, yaw: -45 },
  { model: 'suitcases', x: 8.35, z: -6.35, yaw: -75, scale: 0.85 },
  // ---- +x壁 ----
  { model: 'bookshelf', x: 8.45, z: -2.9, yaw: -90 },
  { model: 'basket', x: 8.15, z: -0.95, yaw: -60, scale: 0.9 },
  { model: 'recordconsole', x: 8.4, z: 0.6, yaw: -90 },
  { model: 'wallshelf', x: 8.75, z: 2.5, yaw: -90, yOff: 2.6 },
  { model: 'mirror', x: 8.5, z: 4.15, yaw: -102 },
  // ---- 2人掛けコーナー（+x/+z角・斜め45°で卓向き） ----
  { model: 'loveseat', x: 6.7, z: 6.9, yaw: -137 },
  { model: 'pouf', x: 4.6, z: 5.55, yaw: 10, scale: 0.9 },
  { model: 'cushions', x: 5.35, z: 4.35, yaw: 75 },
  { model: 'plant', x: 8.2, z: 8.2, yaw: 200, scale: 0.85 }, // 2人掛けの背後の角
  // ---- +z壁 ----
  { model: 'sideboard', x: 0.3, z: 8.5, yaw: 180 },
  { model: 'barcart', x: 3.0, z: 8.0, yaw: 160 },
  { model: 'basket', x: -3.2, z: 8.25, yaw: 210, scale: 0.9 },
  { model: 'laddershelf', x: -4.65, z: 8.3, yaw: 172 },
  { model: 'plant', x: -6.35, z: 8.05, yaw: 300, scale: 0.9 },
  { model: 'plant', x: -8.0, z: 7.9, yaw: 40 },
  // ---- 壁掛け（R31・契約29: 額絵/マクラメ/時計 + ウォールシェルフ複製） ----
  { model: 'painting', x: -8.85, z: 5.4, yaw: 90, yOff: 2.4 }, // -x壁・おもちゃ箱の上
  { model: 'painting', x: -6.9, z: -8.87, yaw: 0, yOff: 2.75, scale: 0.85 }, // 暖炉の上
  { model: 'painting', x: 2.6, z: -8.88, yaw: 0, yOff: 2.6, scale: 0.9 }, // TVの上
  { model: 'macrame', x: 5.6, z: 8.87, yaw: 180, yOff: 2.3 }, // +z壁・2人掛けの上
  { model: 'wallclock', x: 8.87, z: 0.6, yaw: -90, yOff: 2.9 }, // +x壁・コンソールの上
  { model: 'wallshelf', x: -8.75, z: -4.9, yaw: 90, yOff: 2.7 }, // 複製・-x壁
  { model: 'wallshelf', x: 8.8, z: -5.9, yaw: -90, yOff: 2.7, scale: 0.9 }, // 複製・+x壁
  // R35（契約32）: 高所の掛棚を増設 — 「下ばかり見ると見つかる」対策で上方向に分布を作る
  { model: 'wallshelf', x: -3.0, z: -8.85, yaw: 0, yOff: 4.7 }, // 窓の上
  { model: 'wallshelf', x: 2.6, z: -8.8, yaw: 0, yOff: 4.15, scale: 0.9 }, // TV上の額のさらに上
  { model: 'wallshelf', x: 3.4, z: 8.8, yaw: 180, yOff: 4.3, scale: 0.95 }, // +z壁・額の上
  { model: 'wallshelf', x: -8.8, z: -0.9, yaw: 90, yOff: 4.0, scale: 0.9 }, // -x壁・高所
  // ---- 天井（梁吊り: 梁は x=±5 と z=±5 に走る・下面≈5.78） ----
  { model: 'chandelier', x: 0, z: -5.0, yaw: 0, topY: 5.78 },
  { model: 'hangplant', x: -5.0, z: 3.5, yaw: 30, topY: 5.78 },
  { model: 'hangplant', x: 5.0, z: -3.5, yaw: 210, topY: 5.78 },
  { model: 'hangplant', x: 5.0, z: 3.2, yaw: 120, topY: 5.78, scale: 0.85 },
  // ---- 天面の小物（R32・契約30: 人形カモフラージュ。snapCap で家具天面へ自動吸着するため
  // 必ず家具インスタンスより後に並べる。かくれんぼスポットの隣に置いて人形を紛れさせる）----
  { model: 'vaseset', x: -1.55, z: 8.45, yaw: 170, snapCap: 1.1 }, // サイドボード天面
  { model: 'bookstack', x: -0.5, z: 8.45, yaw: 200, snapCap: 1.1 },
  { model: 'photoframes', x: 0.55, z: 8.5, yaw: 175, snapCap: 1.1 },
  { model: 'teaset', x: 1.5, z: 8.4, yaw: 160, snapCap: 1.1 },
  { model: 'miniplant', x: 8.45, z: -3.9, yaw: -90, snapCap: 4.0 }, // 本棚の上
  { model: 'bookstack', x: 8.45, z: -1.95, yaw: -100, snapCap: 4.0 },
  { model: 'photoframes', x: 1.35, z: -8.6, yaw: 0, snapCap: 1.0 }, // TV台の天面
  { model: 'miniplant', x: 3.85, z: -8.5, yaw: -20, snapCap: 0.7 },
  { model: 'teaset', x: -6.35, z: 1.75, yaw: 60, snapCap: 0.3 }, // コーヒーテーブル
  { model: 'candleset', x: -7.7, z: -1.95, yaw: 30, snapCap: 0.9 }, // サイドテーブル1
  { model: 'bookstack', x: 8.25, z: -4.75, yaw: -70, snapCap: 0.8, scale: 0.9 }, // サイドテーブル2
  { model: 'candleset', x: 8.5, z: 1.3, yaw: -90, snapCap: 1.0 }, // レコードコンソール
  // R32追補（2026-08-12 ユーザー要望「1Pの後ろの低い棚にもっと小物を」）: TV台天面を賑やかに +
  // 各コンソール天面も増強（人形カモフラージュの密度）
  { model: 'bookstack', x: 1.45, z: -8.25, yaw: 12, snapCap: 1.0, scale: 0.9 }, // TV台（写真立ての手前側）
  { model: 'candleset', x: 3.6, z: -8.7, yaw: -30, snapCap: 1.0, scale: 0.9 }, // TV台（TVの右奥）
  { model: 'vaseset', x: 4.0, z: -8.25, yaw: 20, snapCap: 1.0, scale: 0.85 }, // TV台（右端手前）
  { model: 'photoframes', x: 8.55, z: -0.25, yaw: -95, snapCap: 1.0, scale: 0.9 }, // レコードコンソール左
  { model: 'miniplant', x: -1.35, z: 8.6, yaw: 150, snapCap: 1.1 }, // サイドボード（花瓶の奥）
  // ---- 囮ぬいぐるみ（R34・契約31: 本物2体と紛らわしい偽陽性。かくれんぼスポットから0.35m以上離す）----
  { model: 'teddybear', x: 7.0, z: -5.85, yaw: -160, snapCap: 0.9 }, // アームチェア座面の隅
  { model: 'teddybear', x: -6.95, z: 4.15, yaw: 60, scale: 0.9 }, // おもちゃ箱の前の床
  { model: 'bunnyplush', x: -0.45, z: 8.5, yaw: 185, snapCap: 1.1 }, // サイドボードの上（小物の間）
  { model: 'bunnyplush', x: -7.8, z: -1.25, yaw: -30, snapCap: 0.05, scale: 0.9 }, // 犬用ベッドの中
  { model: 'pengplush', x: 4.85, z: -6.4, yaw: 170 }, // 地球儀の脇の床（白黒＝ダルメ空似）
  { model: 'pengplush', x: -8.55, z: 0.35, yaw: 95, snapCap: 1.35, scale: 0.9 }, // ソファ背もたれの上
  { model: 'catplush', x: 5.65, z: 4.95, yaw: -120 }, // クッションと2人掛けの間の床
  { model: 'catplush', x: -2.0, z: -7.75, yaw: 15, snapCap: 0.3, scale: 0.9 }, // 窓下クッションの上
  // ---- カモフラ小物（カラフルな布物＝2体の派手なマントと同化させる）----
  { model: 'blanketpile', x: 5.7, z: 7.9, yaw: -140, snapCap: 0.75 }, // 2人掛けの座面（端）
  { model: 'blanketpile', x: 8.45, z: -7.05, yaw: -75, scale: 0.9 }, // ランプとトランクの間の床
  { model: 'pillowpair', x: -4.6, z: -7.3, yaw: 25 }, // 薪カゴの脇の床
  { model: 'pillowpair', x: 7.9, z: -7.1, yaw: -50, scale: 0.9 }, // ランプとアームチェアの間
];
