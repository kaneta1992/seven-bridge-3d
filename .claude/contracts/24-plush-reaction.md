# 契約24: ぬいぐるみの「見つめると手を振る」リアクション

委譲先: implementer-opus / ダイヤル: ゴール委譲

## 目的
- 要求（ユーザー）: 「人形の方を見てズームアップしたらこっちに向かってエモーションするように」「リグを入れてこっちを向いて手を振るみたいなのは」
- 成功条件: 合格基準の全コマンド exit 0 + 動作確認報告（status行必須）

## 素材（準備済み・public/models/）
- `panda.glb`（4.4MB・静的・新写真から再生成済み）
- `dalmatian.glb`（4.3MB・静的・新写真から再生成済み）
- `dalmatian-wave.glb`（7.7MB・**スキン+アニメクリップ 'Armature|Big_Wave_Hello|baselayer' 入り**。直立して大きく手を振るモーション）
- パンダはMeshyリギング不可（座り姿勢+ワンピースでポーズ推定失敗）→ ボーンレス演出で代替

## 実装要求
1. **視線+ズーム検知**: 対局中の首振りカメラで「ソファのぬいぐるみ方向を向き（視線ベクトルと人形方向の角度差が閾値内）かつズームイン（fovが既定より十分小さい）」を検知。数百ms の注視デバウンスでチラ見では発火しない
2. **ダルメシアンのリアクション（本命）**: 検知したら
   - 静的 dalmatian.glb を非表示 → dalmatian-wave.glb（事前ロード）を同位置に表示し、**カメラの方へ向き直してから** AnimationMixer で Big_Wave_Hello を1回再生
   - 再生終了で静的モデルへ戻す（位置・向きも復帰）。滑らかに（フェード/スケールでポップしない）
   - 効果音（可愛い挨拶音・プロシージャル）+ 頭上に小さなハートパーティクル
3. **パンダのリアクション**: 検知したら squash&stretch のぷるぷる→ぴょんと2回はねる + ハートパーティクル + 効果音（ボーンレス・transform アニメ）
4. **クールダウン**: 1体あたり20〜30秒。リアクション中の再検知は無視。両方同時視認なら両方発火してよい
5. **スコープ**: 対局中（ホットシート/solo/通信）のみ。タイトルデモ中は発火しない（シネマカメラと干渉するため）
6. wave GLB は必要時に遅延ロード（初回検知時 or アイドル時プリフェッチ。初期ロードを重くしない）

## エッジケース
- E1: リアクション中にカメラを外す/視点リセット/手番交代カメラリセット → アニメは最後まで再生して静的へ戻る（進行に影響なし）
- E2: wave GLB のロード失敗 → ダルメシアンもパンダ式のバウンス演出へフォールバック
- E3: AnimationMixer の update を既存レンダループに統合（rAF停止/再開の idle 機構と整合）/ dispose 整合（SkinnedMesh・クリップ・ミキサー）
- E4: prefers-reduced-motion では控えめ（手振りは再生してよいがパンチ/パーティクル抑制）
- （実装前に追加エッジケースを追補せよ）

## スコープと負の制約
- 変更してよい: src/render/**, src/ui/**（SFX呼び出し等最小限）, tests/**
- 変更禁止: src/core/** src/driver/** src/net/** docs/ .claude/ scripts/ public/models/**（素材は完成品・触らない）/ 新規npm依存
- diff 上限: 1200行 / コミット禁止 / seedタブ操作禁止

## 環境ノート
- Node PATH前置: `export PATH="$PATH:/c/Users/kanet/tools/node-v24.19.0-win-x64"`
- 必読: `.claude/skills/seven-dev/SKILL.md`（GLTFLoader型シムは three-ext.d.ts に定義済み。AnimationMixer等の型が足りなければ同シムへ追記可）

## 合格基準（全て実行し、コマンドと exit code を報告に含めること）
- `npm run build` / `npm run typecheck` / `npm test`（119件基準グリーン維持）
- `git diff --name-only -- src/core src/driver src/net public | (! grep .)`（保護領域+素材ゲート）
- 動作確認: 視線+ズーム検知の発火（検知条件の数値報告）・wave再生→復帰のシーケンス・パンダのバウンス・クールダウン（実機DOM/JS駆動で）

## 出力契約
最終報告は日本語35行以内。**status行必須**。status / files_changed / commands_run / 動作確認結果 / summary / notes。
