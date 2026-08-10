# 契約10: 敵対レビュー指摘の修正ラウンド

委譲先: implementer-opus / ダイヤル: 標準（修正対象は指定・実装詳細は委ねる）
**本契約に限り src/net と src/core の変更を許可**（各項の範囲内のみ）

## 目的
- 要求: Opus敵対レビュー4体（A付け札/Bエンジン/C通信/D UI）の指摘のうち採択された15件を修正し、回帰テストで固定する
- 成功条件: 合格基準の全コマンド exit 0 + 各修正の対応報告（status行必須）

## コンテキスト
- 必読: `.claude/skills/seven-dev/SKILL.md`
- 指摘の全文はこの契約の下部「レビュー指摘の詳細」を参照
- HEAD時点でテスト66件

## 修正項目（優先度順・すべて必須）

### セキュリティ（src/net）
1. **[Critical] 席乗っ取り対策 — 秘匿rebindToken**: Hello に pk とは別の秘匿トークン（クライアント生成・localStorage保存・ワイヤではHelloのみに載せる）を追加。ホストは pk 初回束縛時に token を記録し、既知 pk の別 peer への再束縛（E8張替え）は **token 一致時のみ**許可。不一致 Hello は黙殺。Roster/Start/Snapshot 等の公開メッセージに token を載せないこと。既存の E8 テストを token 前提へ更新し、「盗んだ pk では乗っ取れない」テストを追加
2. **[High] ホスト先着束縛**: ゲストは最初に受信した Roster/Start の送信 peer を hostPeerId として固定し、以後別 peer からの Roster/Start/Snapshot/Err/Ack を無視する（現状は誰の Start でも受理）。残余リスク（先着レース）は修正せずコード内コメントで明記
3. **[High] Hello 入力検証**: sanitizeHello を新設（pk: 英数と-_ のみ・64文字以内の string / name: string を10文字に slice・制御文字除去）。不正は破棄。既知 pk の name 変更は 1 の token 一致時のみ反映
4. **[Med] 公開ロビーの防御**: 受信広告を「送信 peer ごとに最新1件」で管理し、全体上限50件。超過分は破棄
5. **[Med] startGame 人数ガード**: members < 2 なら開始拒否（ホストUIにトースト）。UI活性だけに依存しない
6. **[Low] ゲストの snapBuffer**: start 前バッファは最新1件のみ保持（seq最大のもの）

### エンジン（src/core — 最小変更）
7. **[Med] applyAction に default 節**: 未知 action.type は fail('unknown action') を返す（undefined 返却の排除）。テスト追加
8. **[Low] attachResult のカード防御コピー**: `[...meld.cards, { ...card }]` に（publishMeld/鳴きと整合）

### UI/3D（src/ui, src/render）
9. **[Med] teardownGame で this.closing = false をリセット**（鳴きウィンドウ永久閉塞の芽を摘む）
10. **[Med] カードドラッグ中のカメラ固定**: 手札ドラッグ（app の drag 状態）中は canvas のカメラ操作（オービット/ピンチ）を無視する連携を追加
11. **[Med] WebGLコンテキストロストの最低限対応**: canvas に webglcontextlost（preventDefault）/webglcontextrestored リスナを追加し、restored でシーン再構築（困難ならページ再読み込みを促す日本語通知でも可 — 黒画面放置をなくす）
12. **[Low] ロビー診断タイマーの自己解放**: paintDiag 内で diag 要素が DOM から外れていたら clearInterval（現状リーク）
13. **[Low] CLAIM_WINDOW_MS の二重定義排除**: app.ts のローカル定数を削除し src/net/protocol.ts から import（コメントの「5秒」陳腐化も修正）
14. **[Low] resize 時の fov 再適用**: userControlled 中でも縦/横に応じた fov を resize で更新
15. **[Minor] 付け札D&Dの整合**: (a) 複数選択ドラッグ（card=null）時の attachableMeldIds は空配列を返す（全メルドが光る誤表示の解消）(b) 3D dropTargetAt のメルドヒットは「ドラッグ中カードが canAttach 真のメルド」に限定し、不可メルドは素通しして捨て札/場の判定へ落とす（誤付け札・誤トーストの解消）(c) 2Dパネルの最近傍吸着（domMeldAt）は「ポインタ直下のメルド優先、直下になければ最近傍」に変更

### テスト追加（レビューA指摘の空白）
16. ラップ境界: 12枚アークへの欠落ランク付与で13枚全周成立 / lone7 シークエンスの円環またぎ成長（7→…→K→A→2）/ 同スート13枚全周の正当性
17. meldSort の循環整列テスト新設（K-A-2 が K,A,2 順・A-2-3 が A 先頭・Q-K-A が A 末尾・13枚全周）

## 修正しない（採択外 — 触らないこと）
- deriveViewFor の meldWindow 存在漏洩（DevToolsレベル・状態機械歪曲のリスクが利益を上回る）/ 楽観ACKの成功倒し / lastWinner の表示陳腐化 / lone7 determined デッドコード（コメント追記のみ可）/ entering rAF のフェード潰し

## スコープと負の制約
- 変更してよい: src/net/**, src/ui/**, src/render/**, src/core/engine.ts と melds.ts（項7,8のみ）, tests/**
- 変更禁止: docs/ .claude/** scripts/** / 新規npm依存 / 外部アセット
- diff 上限: 1800行
- コミット禁止 / seedタブ操作禁止

## 環境ノート
- Node PATH前置: `export PATH="$PATH:/c/Users/kanet/tools/node-v24.19.0-win-x64"`

## 合格基準（全て実行し、コマンドと exit code を報告に含めること）
- `npm run build` / `npm run typecheck` / `npm test`（既存66件+新規テスト全グリーン。E5系維持必須）
- 目視/機構確認: 1のなりすまし拒否テスト・5の人数ガード・15の付け札D&D挙動（確認方法を報告）

## 出力契約
最終報告は日本語40行以内。**status行必須**。status / files_changed / 修正対応表(1〜17の各項に1行) / commands_run / summary / notes。

## エスカレーション条件
- 1 の token 方式が既存の再接続（recover/E8）テストと両立しない設計上の矛盾を見つけた（代替案を添えて報告）

---

## レビュー指摘の詳細（参照用抜粋）
- C#1 席乗っ取り: 漏洩源 session.ts:288-295（RosterMsgにpk）/ 成立点 session.ts:235-240（onHello無検証張替え）→ 締め出し hostDriver.ts:118 / 代行 :119,123 / 手札漏洩 :170-171
- C#2 偽ホスト: session.ts:317-343（onRoster/onStart 送信元無検証）/ :345-348（onSnap）
- C#3 Hello無検証: session.ts:235-267。sanitizeRoomAd(protocol.ts:158)と非対称
- C#4 ロビー: lobbyChannel.ts:102-107 発信者照合・件数上限なし
- C#5 人数: session.ts:125-143 に members.length 検査なし（UI canStart のみ）
- C#6 snapBuffer: session.ts:345-348 無制限push
- B#2 default節: engine.ts:300-459
- A#1 コピー: melds.ts:125,137
- D#1 closing: app.ts:1363のみでリセット・teardownGame(217-260)に無し
- D#3 カメラ: scene.ts:1045-1067 が別pointerIdで発火
- D#4 diagTimer: lobby.ts:170,182-184（タブ切替時のみ解除）
- D#7 二重定義: app.ts:39 / protocol.ts:24
- A#4/D#5 付け札D&D: app.ts:964（card null で全true）/ scene.ts:736-762（canAttach非考慮）/ app.ts:1006-1033（最近傍吸着）
