# 契約25: R27 — Meshy家具による部屋の高品質化（1メッシュ統合）

## 目的
プロシージャル家具の主役級（ヒーロー家具）をMeshy text-to-3D生成の高品質モデルへ差し替え、
居間の見た目を一段引き上げる。**ドローコールは増やさない**（全Meshy家具を1ジオメトリ+1アトラス
テクスチャ=1ドローコールへオフライン統合）。R28（かくれんぼ）の候補地アンカーを配置設計に織り込む。

## ユーザー指示（2026-08-12）
- いつでも今の状態に戻せるようにしつつ作業を進める → タグ `pre-r27` + ブランチ `r27-meshy-room`。
  検証完了までmasterへマージしない。戻す時は `git reset --hard pre-r27`（master上）または該当タグへcheckout。
- ドローコール節約のため可能なら1メッシュ化する。

## 生成物パイプライン
1. `scripts/meshy-room-gen.mjs` — 12点をtext-to-3Dで生成（preview→refine→GLB）。
   生成物は `assets-src/meshy-room/`（**gitignore対象** — rawアセットはコミットしない）。
   state.jsonで再開可能（クレジット節約）。APIキーは ~/.meshy_key.txt。ログへ出さない。
2. `scripts/merge-furniture.mjs` — 全GLBを読み、配置（PLACEMENTS）どおりワールド座標へ焼き込み、
   テクスチャを4096アトラスへ詰めUVを再マップ、**1メッシュ1マテリアルの `public/models/room-furniture.glb`**
   を出力（quantize圧縮）。これのみコミットする。
3. `src/render/scene.ts` — buildFurnitureのバケットを「維持(keep)」と「差替(swap)」に分離。
   room-furniture.glb を非同期ロードし、成功時にswapバケットのメッシュを除去・解放（ぬいぐるみGLBと同じ
   フォールバック方式: ロード失敗時はプロシージャル版のまま）。

## 家具リスト（12点・配置は現行レイアウト踏襲）
sofa(-x壁・卓向き) / armchair(新規) / bookshelf(+x壁) / sideboard(+z壁) / sidetable(ソファ脇) /
coffeetable(新規・ソファ前) / floorlamp(+x/-z角) / plant(×3配置・モデル共有) / tvstand(新規・-z壁) /
basket(×2配置) / pouf / wallshelf(新規・壁面高所)

## 差替で消すプロシージャル（swapバケット）
ソファ一式・サイドテーブル+卓上小物・本棚+本+飾り・観葉植物×3・サイドボード+天板小物・
雑誌/カゴ/プフ・フロアランプ（発光シェードのみglow overlayとして残置しMeshyランプ位置に合わせる）

## 維持するプロシージャル（keepバケット）
ラグ・窓+カーテン・壁の額・天井照明+梁・壁掛け時計・部屋躯体（壁/床/天井）

## 負の制約
- 実行時の外部URL禁止（D7）— GLBはリポジトリ内 public/models/ のみ
- 選択的Bloomレイヤ(1)に家具を載せない（E1）/ 影 cast/receive=false 維持
- src/core 非改変 / 通信プロトコル非改変
- ユーザー写真・APIキーのコミット禁止（secret-scan必須）
- ぬいぐるみ2体のソファ着座位置は維持（Meshyソファの座面高に合わせ調整可）

## R28への布石（アンカースロット）
配置定義 `scripts/room-layout.mjs`（単一ソース）に家具毎のスロット雛形を持たせ、
R28で src/render 側から参照できる形（生成JSON or 定数エクスポート）で約100候補地を導出する。

## 合格基準
- typecheck / build / 全テスト green、secret-scanクリア
- room-furniture.glb 追加後の描画コール増分が +1（renderer.info.render.calls で実測）
- GLB合計サイズ 10MB 以下（目標 ~7MB）
- 全席（6席視点）から部屋が破綻なく見える（ブラウザ実機確認）
- ぬいぐるみがMeshyソファに正しく着座、リアクション動作維持
- ロード失敗時にプロシージャル版で完全動作（フォールバック確認）
