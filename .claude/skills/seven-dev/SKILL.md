---
name: seven-dev
description: セブンブリッジ3D（GitHub Pages + WebRTC P2P通信対戦）の開発引き継ぎ。アーキテクチャ・設計判断・落とし穴を記録。本プロジェクトのコードを変更する前に必ず読む。
---

# セブンブリッジ 3D — 開発引き継ぎ

## プロダクト
ブラウザで動く3Dセブンブリッジ。GitHub Pages（静的配信のみ）で2〜6人の通信マルチプレイ。
仕様の単一ソースは `docs/requirements.md`（ゲームルール§2は必読。ローカルルール: メルド公開後のみ付け札可 / ポンは誰の捨て札でも・チーは上家のみ / 麻雀式手番移動 / 失点 A=1,2〜10=額面,J=11,Q=12,K=13 / 指定ラウンド合計最少失点勝ち）。

## アーキテクチャ（3層 + 境界）
```
src/core/    純粋TSルールエンジン（DOM/three/trystero 依存禁止 — ゲートで機械検証）
  cards.ts rng.ts melds.ts engine.ts index.ts
  - applyAction(state, action) => Result（決定的reducer。不正は拒否Resultで状態不変）
  - deriveViewFor(state, playerId) => PlayerView（視界フィルタ: 他家手札は枚数のみ）
  - eligibleClaims / isWindowClosed / computeTotals
  - シャッフルはシード注入RNG（mulberry32）
src/driver/  GameDriver interface（UI⇔ゲームの唯一の境界）
  types.ts localDriver.ts（ホットシート）
  - optional拡張: isAuthority? / claimDeadline? / dispose?
src/net/     P2P通信（trystero、ホスト権威）
  protocol.ts trysteroTransport.ts hostDriver.ts guestDriver.ts session.ts
src/render/  Three.js 3D（scene.ts cardTexture.ts felt.ts — 全プロシージャル生成）
src/ui/      日本語UI（app.ts lobby.ts room.ts scoreTable.ts styles.css）
```

## 重要な設計判断
- **ホスト権威**: ホストのみ applyAction 実行。ゲストは ActionMsg 要求→ホスト検証→**各ピアへ個別に deriveViewFor 済みスナップショットをターゲット送信**（全量・連番付き。差分同期はしない）。他家手札・山札の中身は絶対にワイヤに載せない（tests/net.test.ts の E5 テストで固定）
- **playerKey**: engine の player id = localStorage `sb_pk_<ルームコード>` に保存する乱数キー。peerId は再接続で変わるため席同定に使わない。同一ブラウザ複数タブはキー衝突する（テスト時は手動で別値をセット）
- **trystero**: `joinRoom({appId, password: code}, code)` — password はルームコード（公開値）でE2E暗号化するだけ。機密ではない（機密スキャンで偽陽性になる）
- **鳴きウィンドウ**: 5秒。タイマー管理は権威側UI（app.ts）で、満了時に closeWindow を発行。エンジンはタイマーを持たない
- **手札表示順**: UI層の handOrder（cardId列）が保持するローカル状態。D&D並び替え（Pointer Events・タップ選択とは8px移動閾値で判別）。エンジンの手札集合とは独立
- **手札UI（改善R3以降）**: 自手札は**2D DOMのみ**（3Dシーンは view.hand を参照しない）。扇形配置は `layoutFan()` が絶対座標 transform で計算（DOM順でなく handCards 配列順）。フォーカス=scale1.5+持ち上げ、ドラッグ中=ポインタ追従ゴースト。D&D: 単札上方=捨て/複数選択上方=メルド公開/メルド上=付け札（単独7公開はボタンのみ）。ドラッグ中は render() 保留。山札/捨て札は卓中央±0.5
- **3D**: アセットは全部プロシージャル（Canvasテクスチャ・RoundedBoxGeometry）。外部URL禁止（要件D7・ゲート有）。メルド配置は折り返しパッキング + カード毎の単調増加y（Z-fighting対策: 面プレーンオフセット0.006 + polygonOffset）
- **three の型**: three@0.169 は型非同梱。src/env.d.ts の ambient shim を使用（@types/three 未導入）

## 検証（L1）
```bash
export PATH="$PATH:/c/Users/kanet/tools/node-v24.19.0-win-x64"   # ポータブルNode（このマシンのPATHに無い）
npm run build      # vite build（base='./'。chunk size警告は既知・無害）
npm run typecheck  # tsc --noEmit
npm test           # vitest run（core/driver/net 全テスト）
git diff --name-only -- src/core | (! grep .)   # core非改変ゲート（UI作業時）
```
- dev サーバー: `.claude/launch.json` の seven-dev（node.exe 直起動。npm.cmd はPATH問題で不可）
- この環境の bash に `rg` は無い → `git grep --untracked -E` か POSIX `grep -E`
- コミット前に `bash scripts/secret-scan.sh`（trystero の password 引数は既知の偽陽性）

## 落とし穴
- ブラウザペインは hidden 状態だと rAF 停止 → スクリーンショット取得がタイムアウトする。検証は read_page / javascript_tool の DOM 駆動で行う（.card 要素クリック→ボタン click）
- ビューポート0x0のときは ref クリックが (8,8) に落ちる → JS で直接 click
- scene.ts は視覚上の共面回避に y 微差を多用。カード配置をいじるときは distinctY を壊さないこと
- ドラッグ中の再描画競合: 並び替え実装はドラッグ中の driver 再描画を保留する設計（詳細は app.ts の attachHandPointer 周辺コメント）

## 演出レイヤ（R5以降）
- `src/render/particles.ts`（プール制・1種別1drawコールのShaderMaterial粒子）/ `postfx.ts`（EffectComposer+Bloom、失敗時素renderフォールバック）/ `quality.ts`（モバイル自動品質: DPR/Bloom/影/粒子キャップ）
- `src/ui/callout.ts`（大型コールアウト・バナー・カウントアップ）/ `audio.ts`（WebAudioプロシージャルSFX・ミュート永続）
- 演出はビュー差分から横断検出（スナップショット非依存＝通信対戦でも整合）。prefers-reduced-motion 尊重
- **並行編集の教訓（3回発生）**: 実装サブエージェントを2体同時に同一ツリーへ触らせない。SendMessage再開エージェントの「完了」通知はターン間停止でも発火するため、**status行つき最終報告のみを完了と見なす**。二重化が疑われたら TaskStop で確定停止。将来は worktree 隔離を推奨

## デプロイ
- GitHub Actions（.github/workflows/deploy.yml）: push → npm ci/test/build → Pages。
- リポジトリ: kaneta1992 アカウント（gh CLI 認証済み）。Pages は build_type=workflow

## 履歴・監査
- 契約と裁定: `.claude/contracts/01〜03`（追記が正）/ 判断ログ: `orchestration-log.md`
- 実装コミットとdocsコミットを分離してある。git log がそのまま監査証跡
