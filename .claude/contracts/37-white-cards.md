# 契約37: R40 — 長時間プレイでカードが真っ白になる問題の対策

## 症状（2026-08-13 ユーザー報告）
モバイル長時間プレイで一部端末の3Dカードだけ真っ白。家具/ぬいぐるみ（GLB=ImageBitmap）は正常。
事象後に切られたカード（捨て札の一番上）だけ生きていた。

## 診断
- カード面/裏は Canvas 生成テクスチャ（512×716×53枚 ≈ 77MB のCPU側Canvas＝端末内最大のCanvas群）
- モバイルブラウザはメモリ圧で Canvas バッキングストアをパージする。その後 GPU 側テクスチャの
  再アップロード契機（コンテキスト復帰等）が来ると**空の Canvas がアップロードされ白/黒になる**
- カード材質は transparent クローンのため空Canvas=α0→面プレーン消失→クリーム色の本体が露出=「真っ白」
- 事象後の新カードは新規描画なので正常 ← 目撃事実と一致
- 敵対レビュー指摘の残課題: 実機でロスト案内が出たかは未確認（出ていなくても本対策のカナリアが拾う）

## 対策（多層）
1. **再描画API**: cardTexture（キャッシュに Card を対で保持）/ felt / roomTextures（redrawレジストリ）
   に refresh 関数を追加。scene.refreshAllCanvasTextures() が一括再描画+needsUpdate（clone含む）
2. **トリガ3系統**:
   a. webglcontextrestored（three の復帰処理→自前 refresh の順）
   b. タブ復帰（visibilitychange→visible）— カナリアで**パージ時のみ**全再描画（通常復帰は無コスト）
   c. **カナリア監視**: 30秒毎に裏面Canvas中心1画素を検査、空なら自己回復（イベントレス白化も拾う）
3. **復帰イベント不発環境対応**: ロスト中1秒毎に isContextLost() を確認し、復帰していたら
   **本物の webglcontextrestored を dispatch**（自前ハンドラ直呼びは three の initGLContext を
   飛ばして描画ゾンビ化する — 敵対レビューが検出した重大リグレッションを修正済み）
4. 二重実行ガード（1.5秒）/ ロスト中の visibility-wake 抑止 / felt ノイズのシード化+clearRect

## 敵対レビュー（scout-opus）指摘の処置
- 高: ポーリング直呼びのゾンビ化 → dispatch 方式へ修正 ✅ / roomTextures 未対策 → レジストリ追加 ✅ /
  トリガレス白化 → カナリア追加 ✅
- 中: visibilitychange の毎回コスト → カナリアゲート ✅ / wake が状態機械を破る → 抑止 ✅ /
  envMap（等角Canvas→PMREM）は未対策（艶が僅かに暗くなる程度・再発時に対応）
- 中(将来): 根治は Canvas を createImageBitmap 化して解放（パージ対象から外す）。再発したら実施
- 低: felt シード化 ✅ / ラベルは1手番で自己回復のため許容 / __glTest 本番残置は他プローブと同方針

## 検証（画素実測）
- purge→visibilitychange: [0,0,0,0]→[14,42,74,255] 自動復元 ✅
- 健常時の visibilitychange: 変化なし（ゲート動作）✅
- restored 経路は非表示ペインではOSがコンテキスト再作成を保留するため実機でのみ確認可能
- __glTest プローブ（purge/lose/restore/refresh/checkback）を常設

## ユーザーへの切り分け質問（再発時）
再発した場合:「直前に画面を切り替えた/ロック解除した直後だったか」「再読み込み案内が一瞬出たか」
「床・壁も黒ずんでいたか」で経路を特定できる
