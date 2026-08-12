# 契約33: R36 — iPhone (iOS Safari) クラッシュ対策（メモリ）

## 症状と分析（2026-08-12）
- iPhone 11 でしばらくプレイすると「問題が繰り返し起きました」= Safari WebContent プロセスの
  反復クラッシュ画面。Pixel 7a は正常
- 原因: **GPUメモリ超過による iOS の jetsam**。内訳（展開後・ミップ込み）:
  - 家具アトラス 4096²×3枚 ≈ **255MB** ← 支配的
  - ぬいぐるみGLBテクスチャ（2048級）≈ 50MB+
  - Canvasテクスチャ群・フレームバッファ（DPR1.5+Bloomなしでも Retina で数十MB）
  - iOS Safari の WebContent 上限（実質 ~1GB・GPU共有）に対し合計が臨界。プレイ中の
    ラウンド遷移・粒子・スナップショットで圧力が漸増して閾値超え

## 対策（ユーザー裁定: 品質より軽さ優先・アセットを予め半分解像度に）
- merge-furniture.mjs の TILE 1024→**512**（アトラス 4096→2048）: 255MB → **64MB**
- ぬいぐるみGLB（panda/dalmatian/dalmatian-wave）のテクスチャを gltf-transform textureCompress で
  **1024へ縮小**: panda/dalmatian 各4.2MB→1.2MB（GPU 67MB→17MB）
- 配信サイズも 28MB→18.6MB（モバイル初回ロード改善）
- ランタイム縮小（quality.textureCap）案は不採用（アセット側で解決・コード増なし）

## 見積り効果
GPUテクスチャ合計 ≈ 320MB → **約80MB**（-240MB）。iPhone 11 の余裕を大きく確保

## 検証
- デスクトップ実機でゲーム距離の見た目劣化なしを確認。typecheck/123テスト/secret-scan green
- iPhone 11 実機の再現確認はユーザーに依頼（こちらでは実機なし）
