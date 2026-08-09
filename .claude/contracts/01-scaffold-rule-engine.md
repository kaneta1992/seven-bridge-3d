# 契約01: プロジェクトスキャフォールド + ルールエンジン + ユニットテスト

委譲先: implementer-opus / ダイヤル: ゴール委譲（内部設計は委ねる）

## 目的
- 要求: セブンブリッジ3Dゲームの土台となる Vite+TypeScript プロジェクトを新規作成し、ゲームルール全体を純粋TSのルールエンジンとして実装、Vitest でユニットテストする
- ゴール: 後続フェーズ（3D描画・P2P通信）が安心して載せられる、決定的で検証済みのゲームロジック基盤を作る
- 成功条件: 合格基準の全コマンドが exit 0。要件定義書 §2 の全ルールがエンジンで表現され、§4 のテスト必須項目が全てテストされている

## コンテキスト（これを読め。探すな）
- 詳細仕様: `C:\Users\kanet\seven\docs\requirements.md`（**§2 ゲームルール・§3.1 アーキテクチャ原則・§4 品質基準は全文必読**）
- 対象: `C:\Users\kanet\seven\`（現在ほぼ空。docs/ scripts/ orchestration-log.md のみ存在）

## アーキテクチャ要求（凍結事項 — 内部実装は自由）
- `src/core/` にルールエンジンを置く。**DOM / Three.js / 通信ライブラリに一切依存しない純粋TS**
- 状態遷移は決定的な `applyAction(state, action) => 新state`（または同等のreducer形式）で表現する
- 乱数（シャッフル）は**シード付きRNG**を注入可能にする（テストの再現性とホスト権威のため）
- **視界フィルタ関数**を提供する: `deriveViewFor(state, playerId)` — 自分の手札＋公開情報のみを含むビュー（他人の手札は枚数のみ）を返す（要件 §3.1）
- 不正アクション（手番外の操作・資格のない鳴き/付け札等）は例外ではなく**拒否結果**（Result型 or null等）で返し、状態を壊さない
- アクションの種類は最低限: ツモ / メルド公開 / 付け札 / 捨て札 / ポン / チー / 鳴きパス / （内部）ラウンド開始・終了・ゲーム終了
- ラウンド×プレイヤーの失点マトリクスと累計を状態に保持する（スコア票の元データ）
- package.json scripts: `dev` / `build` / `test`（vitest run）/ `typecheck`（tsc --noEmit）を用意。依存に three と trystero を**インストールだけ**しておく（後続フェーズ用。本契約では import しない）
- Vite の `base` は GitHub Pages 配信を想定し `./`（相対）にする

## エッジケース（転写 — テスト名かコメントに E番号を含めること）
- E1 境界値: 2人戦のチー（上家=唯一の相手）/ 6人戦 / 山札切れ→流局（全員手札失点）/ 最後の1枚を捨てて上がり・メルドや付け札で出し切って上がり（捨て札なしの上がり）の両方 / A-2-3 可・Q-K-A 可・K-A-2 不可
- E2 状態遷移の空セル: メルド未公開者の付け札拒否 / メルド未公開者のポン・チーは可（鳴いた時点で公開者になる）/ ポンとチーの競合はポン優先 / 複数ポン競合は捨てた人から時計回りで近い方 / 単独7の成長（シークエンス化・グループ化・方向確定後は逆方向を拒否）/ グループへの5枚目追加拒否（最大4枚・スート重複なし）
- E3 時間・並行性: 鳴きウィンドウ中の他アクション拒否 / 鳴き可能者全員パスでウィンドウ即終了の判定関数（タイマー自体はエンジン外＝ホスト側の責務。エンジンは「誰が鳴き得るか」の列挙を提供する）
- E5 プリモーテム: 失点計算 A=1 / 2〜10=額面 / J=11 / Q=12 / K=13 のテーブルをテストで固定 / 鳴きで取得したカードを手札に入れず必ずメルドに使う制約
- （implementer は実装前にタスク固有の追加エッジケースを En+1.. として追補せよ）

## スコープと負の制約
- 変更してよい: `C:\Users\kanet\seven\` 配下の新規ファイル全般（package.json, vite/ts/vitest設定, src/core/**, tests または src/core/*.test.ts, index.html, .gitignore）
- 変更禁止: `docs/requirements.md` / `orchestration-log.md` / `.claude/**` / `scripts/secret-scan.sh`
- 本契約では UI・3D・通信コードを書かない（src/main.ts は最小プレースホルダで可）
- テスト・フィクスチャに実在の個人情報を使わない（プレイヤー名はダミー）
- diff 上限: 3500行（新規プロジェクトのため。node_modules / package-lock.json は計測から除外）

## 環境ノート（2026-08-09 追記 — この追記が既存記述に優先する）
- Node.js はポータブル版が `C:\Users\kanet\tools\node-v24.19.0-win-x64` に導入済み（v24.19.0 / npm 11.17.0）
- **新規シェルの PATH には載っていない**。node/npm を使う全コマンドの先頭で必ず PATH を通すこと:
  - bash: `export PATH="$PATH:/c/Users/kanet/tools/node-v24.19.0-win-x64"`
  - PowerShell: `$env:Path += ';C:\Users\kanet\tools\node-v24.19.0-win-x64'`

## 合格基準（全て実行し、コマンドと exit code を報告に含めること）
- 実行シェル: bash（作業ディレクトリ `C:/Users/kanet/seven`、上記 export を前置）
- `npm run build`
- `npm run typecheck`
- `npm test`（vitest run — 要件 §4 の必須テスト項目を全て含み全グリーン）
- `git grep --untracked -E "from ['\"]three|from ['\"]trystero" -- src/core; test $? -eq 1`（コアの純粋性 [ゲート]）
- `git grep --untracked -E "\bdocument\.|\bwindow\." -- src/core; test $? -eq 1`（コアのDOM非依存 [ゲート]）
- 注意: この環境の bash に `rg` は無い。grep 系は `git grep --untracked -E` か POSIX `grep -E` を使うこと

## 出力契約
最終報告は日本語で、以下のみ。全体で30行以内。
- status: success | failed | blocked
- files_changed（主要ファイルのみ列挙、テスト件数）
- commands_run（コマンドと exit code）
- summary（結論1〜3行）
- notes（スコープ外の発見・追補したエッジケース番号）

## エスカレーション条件
以下に該当したら、作業を進めず status: blocked で終了せよ（推測で埋めることを禁止する）:
- 前提「作業ディレクトリはほぼ空の新規プロジェクトである」が実際と異なっていた
- 要件定義書 §2 のルールに矛盾・判断不能な穴を見つけた（発見内容を具体的に報告せよ）
- npm がオフライン等で依存導入に失敗した
