# 契約38: R41 — 低RAM Android（nubia S 5G）の漸進的劣化→クラッシュ対策

## 症状（2026-08-13 ユーザー報告）
nubia S 5G（A403ZT / Android 15 / RAM 4GB / Unisoc T760 / 2400×1080）で
しばらくプレイすると徐々に動作が重くなり、最終的にアプリが閉じる。

## 診断（リーク監視の実測）
タイトルデモを3分超監視（20秒間隔で __renderStats + heap サンプリング）:
- textures 58→74 で**プラトー**（カード面キャッシュのウォームアップであってリークではない）
- geometries 26 で安定、JSヒープ 30–50MB を往復（GCが回っており健全）
- **結論: メモリリークは存在しない**。真因は2つ:
  1. **漸進的劣化 = 熱スロットリング**。常時 ~476k 三角形 + DPR 2.4相当のフィルレートは
     エントリーSoC（Unisoc T760）には常時過負荷で、数分でクロックが段階的に落ちる
  2. **最終クラッシュ = 4GB端末のOOM**。2400×1080×高DPRのフレームバッファ+ポストFX
     +テクスチャ群が jetsam/LMK の圏内に入る

## 対策（負荷の恒久削減 — 事前ベイク方針。契約33のiPhone対策と同系統）
1. **メッシュ簡略化（アセット事前ベイク）**
   - merge-furniture.mjs に MeshoptSimplifier（ratio 0.35, error 0.001）を quantize 前に挿入
     → room-furniture.glb **390,252→136,518 tris**（6.43MB）
   - ぬいぐるみ3種（panda/dalmatian/dalmatian-wave）を ratio 0.45, error 0.004 で
     31k→**約14k tris/体**（error 0.001 では28kで停止したため緩和。コミット済み原本から再実行）
   - 実測（ゲーム内 __renderStats）: triangles **476k→175k（63%削減）**・calls 37
   - 見た目検証: ソファ閉写 __lookProbe(-76,0.9,40) でぬいぐるみのシルエット/顔/ケープとも
     劣化不可視（ディテールはテクスチャが担っているため）
2. **lowRam 品質ティア**（quality.ts）
   - navigator.deviceMemory ≤ 4（Chrome系のみ・単位GB・上限8）で low ティアをさらに絞る:
     maxDpr 1.5→**1.0** / shadowMap 1024→**512** / sparkCap 90 / confettiCap 100
   - DPR 1.0 で 2400×1080 端末のフィルレートとフレームバッファメモリを半減以下に

## 注意（再発時の手掛かり）
- deviceMemory 非対応ブラウザ（Firefox/Safari）では lowRam 判定が効かない（low どまり）
- 簡略化率をさらに上げる場合は plush の error を上げすぎない（0.004 が顔の限界近傍）
- 三角形の残り主成分: 家具136.5k + plush 4×14k + カード/卓/躯体

## 検証
- 125テスト全緑 / build 成功 / 機密スキャン クリア
- __renderStats: triangles 175,040 / calls 37 / geometries 25 / textures 24（プラトー確認済み）
