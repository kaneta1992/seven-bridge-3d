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
- **公開ルームの可視性はリレー×WebRTCの2段（R38/契約35）**: 広告は nostr でピア発見→WebRTC データチャネルで配送。TURN 必須（STUN のみだとモバイル CGNAT 同士のペアが繋がらず「端末により見えたり見えなかったり」になる）。**trystero の rtcConfig は simple-peer の opts へスプレッドされるため `{ config: { iceServers } }` と包んで渡す**（トップレベル iceServers は無視される罠）。ロビーは `LobbyLink.enableSelfHeal`（ピア0+無活動45sでトランスポート再生成）で nostr 購読死から自己復旧する。診断はロビー画面の「接続リレー n/8・ロビーピア m」
- **Canvas由来テクスチャはモバイルでパージされ「白カード/黒床」になる（R40/契約37）**: 対策は3系統（restored/タブ復帰カナリアゲート/30秒カナリア）＋各モジュールの refresh API（cardTexture/felt/roomTextures redrawレジストリ）。**復帰ポーリングで自前ハンドラを直呼びしてはいけない**（threeのinitGLContextが飛び描画ゾンビ化）— 必ず `el.dispatchEvent(new Event('webglcontextrestored'))`。新しい Canvas テクスチャを足すときは必ず再描画レジストリへ登録。検証は `__glTest('purge'/'lose'/'restore'/'checkback')`。非表示ペインでは restore がOS保留になり検証不能（visibilitychange 合成イベントで代替）
- **Nostrリレーは劣化する**（2026-08-10 実障害）: trysteroデフォルトリレーの有料化・故障で「公開ルームが見えない/コード参加が固まる」全面障害になった。`trysteroTransport.ts` の RELAY_URLS に実測済みリレーを明示指定している。同種の症状が再発したら、ブラウザコンソールの `Trystero: relay failure` 警告を確認し、候補リレーへ `new WebSocket(url)` の生存プローブを実行して RELAY_URLS を更新する
- ブラウザペインは hidden 状態だと rAF 停止 → スクリーンショット取得がタイムアウトする。検証は read_page / javascript_tool の DOM 駆動で行う（.card 要素クリック→ボタン click）
- ビューポート0x0のときは ref クリックが (8,8) に落ちる → JS で直接 click
- scene.ts は視覚上の共面回避に y 微差を多用。カード配置をいじるときは distinctY を壊さないこと
- ドラッグ中の再描画競合: 並び替え実装はドラッグ中の driver 再描画を保留する設計（詳細は app.ts の attachHandPointer 周辺コメント）
- **ドロップ標的のライフサイクル順序（2026-08-11 実バグ）**: `hideDropTargets()` は attachableMelds を消すため、**必ず resolveDrop() の後に呼ぶ**。先に呼ぶと dropTargetAt のメルド判定が全て素通りし「場=公開」へ化ける（ホバーの判定円は光るのにドロップだけ失敗する紛らわしい症状になる）。付け札D&Dを触ったら必ず「実ポインタ経路」（pointerdown→move→up の合成イベント＋__dropProbe グリッド）で検証すること — resolveDrop 直接呼び出しの検証はこのクラスのバグを素通しする
- **prefers-reduced-motion の罠（2026-08-12 実バグ）**: このPC（ユーザー環境）は Windows「アニメーション効果」OFFで `prefers-reduced-motion: reduce` が立つ。reduced ゲートに入れた演出は**ユーザーの実機で一切見えなくなる**（ハートエフェクト不表示の真因）。ユーザーが明示要望した演出は reduced ゲートに入れないこと。quality.cameraShake=!reduced なのでシェイク系も同様に注意
- **__plushProbe/__cameraState はタイトルデモのシーンを掴むことがある**: タイトル画面中はデモ用 TableScene（cinematic=true・dt≈0.033の32fpsスロットル）が生きており、`document.querySelectorAll` で最初に見つかる canvas がそれ。ゲーム側の検証は「`/ラウンド \d/` が HUD にあり TAP TO START が無い」ことを確認してからプローブを取得する。cinematic=true では注視判定は常に false（gazeT が進まない）
- **スクリーンショットは粒子検証に使えない**: ツール往復ラグ（約2秒）で寿命1〜2秒の粒子は写らない。`__plushProbe('state').particles`（プール生存数）とシェーダ数式のピクセルシミュレーション（ASCII化）で数値検証する
- **Meshy家具パイプライン（R27/契約25）**: 部屋の家具は `scripts/meshy-room-gen.mjs`（生成・state.jsonで再開可）→ `scripts/merge-furniture.mjs`（1メッシュ/1アトラス統合）→ `public/models/room-furniture.glb`。配置の単一ソースは `scripts/room-layout.mjs`。**Meshy生成モデルは向き・軸がバラバラ**（fixYaw で補正）で、箱物は均等フィットだと最小軸に潰れる（stretch: true で軸別スケール）。部屋を確認するときは `__lookProbe(yawDeg, h?, fov?)`（canvas直付け・卓中央から任意方位を注視）。**レイアウト変更時は hideSpots.ts の家具AABBも更新すること**（merge-report.json から転記）
- **かくれんぼ同期の設計（R28/契約26）**: 隠れ場所は「候補地カタログ（純計算・全席可視レイ検証込み）× 共有シード（ルームコード#ラウンド）」で全クライアントが独立に同一導出。**可視性検証（＝どのスポットを選ぶか）を実行時レイキャストにしてはいけない**（GLBロード成否で結果が割れて同期ずれする）。検証は `__hiddenProbe`（配置）と scratchpad の hidespots-debug（遮蔽内訳）
- **かくれんぼ候補地の画像検証パイプライン（R33/契約30）**: `__spotShot(i, ang)`（canvas直付け・候補地iへテスト個体を強制配置→同期render→JPEG dataURL）→ scratchpad の shot-server.mjs(127.0.0.1:9977)へPOST保存 → make-sheets.mjs(sharp)でラベル付きコンタクトシート → scout-opus並列で CLIP/FLOAT/BURIED/EASY 判定。候補地を増減したら必ずこのパイプラインで再検証する。スクショの黒床は浮きに見えやすい（誤FLOAT）ので個別ショットで再確認
- **「見えている床」は影受け円盤（R35/契約32の教訓）**: 部屋の床として見えているのは buildTable 系の CircleGeometry(14) 円盤（y=-0.45）で、躯体（BoxGeometry 床面 y=-0.5）はその下に隠れている。床の見た目を変えるときは**円盤のマテリアル**を触ること（R31で躯体側だけ3回改良して全部不発だった）。床に置くもの（ラグ・接地影・かくれんぼ床スポット）は y=-0.45 基準
- **かくれんぼの最終判定は可視ピクセル監査 `__spotVis(i, 0.75)`（R37/契約34）**: 6席の実カメラからマゼンタレンダ+readPixelsで可視画素を計数（ジッター最小スケール・本物個体は監査中非表示）。合格= max≥900 かつ 600以上の席が2+。近接写真レビュー(__spotShot)は「めり込み/浮き」用で、「本の陰に沈んで見えない」は検出できない — 両方回すこと
- **かくれんぼの数値監査は `__spotAudit()`**（全候補×両モデルの接地ギャップ/最終身長を実測）。ただしプロシージャル面（窓上枠など）のスポットは roomGlb レイ対象外で偽陽性の浮き扱いになる→個別 __spotShot で確認。配置系の実行時保険: 接地スナップ→頭上クリアランス縮小→最終沈降の3段
- **接地スナップは同期と無関係（R31/契約29）**: 配置後の「家具GLBへ下向きレイキャストで実サーフェス吸着」は各端末の見た目補正なので実行時レイキャストでもOK（スポット選択に影響しない）。棚段・天面スポットの高さはカタログでは目測±0.35mで書き、スナップに任せる。GLBロード完了時に placeHiddenPlush を再実行する結線を忘れない

## 通信UX（R9以降）
- `src/net/lobbyChannel.ts`: 公開ルーム一覧（固定ロビーチャネル LOBBY_ROOM への定期広告・受信側TTL・送受信両側 sanitizeRoomAd で {code,hostName,count,rounds} 以外を遮断）
- `session.recover()`: visibilitychange/pageshow/online で自動回復（再join・再アナウンス・ホストはスナップ再送・1.5sデバウンス・冪等）
- 人数はルーム作成時に指定しない（SEAT_CAP=6 内部定数）。開始時の名簿人数で確定
- 招待: Web Share ボタン + `?room=CODE` URL直行参加（保存名で自動join・replaceStateでループ防止）
- ルール変更履歴: 親=累計失点最大の人（2026-08-12変更・同点は直前親優先→席順。旧: 前ラウンド勝者）/ 開始時めくり札なし / シークエンスは循環ラップ許可（isConsecutiveRun=円環アーク判定・meldSortも循環整列）/ 鳴き10秒・鳴きUIは本人のみ表示 / 自動ツモ

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
