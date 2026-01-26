# Slack × Claude Code 連携 要件定義

## 0. 前提・方針（最重要）

- Claude Code は Macローカルで起動
- Slackの1スレッドは、Claude Codeの1セッションと1対1対応
- スレッドが続く限り、同じClaudeセッションを再開して使う
- Claude Code は CLI / headless 実行
- 外部サーバ公開なし（Socket Mode）
- Claudeは「返信案生成役」、最終判断は人間

## 1. 全体アーキテクチャ

```
Slack（特定チャンネル）
   ↓ Socket Mode Events
Mac上 Bridge（常駐）
   ├─ Slackイベント受信
   ├─ thread_ts → claude_session_id を管理
   ├─ Claude Code をCLIで起動 / 再開
   └─ Slackスレッドに返信案を投稿
```

- Bridge は Mac 上で常駐（Node or Python）
- 状態（セッション対応表）は Bridge が保持
- Claude Code 自体はローカルだが、セッションは Claude 側で管理

## 2. セッション対応ルール（核心）

| Slack | Claude Code |
|-------|-------------|
| 1スレッド（thread_ts） | 1セッション（session_id） |
| 親投稿 | 新規Claudeセッション作成 |
| スレッド内返信 | 既存Claudeセッションを --resume |
| スレッド終了 | セッション破棄 or 放置 |

- 対応表：`thread_ts` → `claude_session_id`
- Claude再開は `--resume <session_id>` を使用
- Claude実行時の cwd（作業ディレクトリ）は固定

## 3. 対象Slackチャンネル

- 指定した特定チャンネルのみ
- 対象外チャンネルのイベントは無視

## 4. イベントトリガー仕様

### 4.1 新規スレッド開始（親メッセージ）

**条件**
- 対象チャンネル
- thread_ts が無い（親投稿）
- bot投稿ではない

**動作**
1. thread_ts = ts とみなす
2. Claude Code を新規セッションで起動
3. 生成された session_id を取得・保存
4. Claudeが生成した返信案（ドラフト）を同スレッドに投稿

### 4.2 スレッド内で人間が返信

**条件**
- 対象チャンネル
- thread_ts が存在
- 投稿者が bot ではない

**動作**
1. thread_ts から claude_session_id を取得
2. Claude Code を `--resume <session_id>` で再開
3. 人間の最新発言を入力として返信案を生成
4. 同じスレッドに返信案を投稿

## 5. Claude Code 実行要件

**実行方式**
- CLI / headless 実行
- 同一スレッドでは必ず同一セッションを再開
- 出力はテキスト（または stream-json）

**Claudeへの指示（固定）**
- 日本語
- Slack向け文体
- 構成：結論 → 理由 → 次アクション
- 断定しすぎない
- 返信案は1つだけ

**入力に含めるもの**
- 人間の最新発言
- （任意）スレッドの補足指示や役割定義
- ※ 会話履歴は Claude セッション側が保持

## 6. Slack投稿仕様

- `chat.postMessage`
- 必ず thread_ts を指定
- 投稿内容はドラフトであることを明示

```
返信案（ドラフト）👇

（Claudeが生成した文章）
```

## 7. 人間介在前提の運用

- Claudeの投稿は下書き
- 人間は：
  - そのまま使う
  - 編集して送る
  - 無視する
- 人間の返信は次のClaude入力として継続利用

## 8. ループ・事故防止要件

- bot自身の投稿イベントは必ず無視
- 同一イベントの二重処理防止（冪等性）
- Claude実行失敗時：
  - Slackへは投稿しない
  - ローカルログに記録

## 9. セッション管理要件

**保存情報（最小）**
- thread_ts
- claude_session_id

**保存先**
- インメモリ（Map）で管理
- プロセス再起動時はセッション情報が失われる（許容）
- 並列スレッドでも混線しないこと
- 将来的にJSONファイル永続化も検討可能

## 10. 非要件（やらないこと）

- Claude側での自動終了判定
- 自動確定・自動送信
- クラウド常駐
- 複数Macでの共有
- 高可用性・冗長化
