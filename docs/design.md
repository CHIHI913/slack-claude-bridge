# Slack × Claude Code 連携 設計書

## 1. 全体アーキテクチャ

```
┌─────────────────┐
│     Slack       │
│ (特定チャンネル)  │
└────────┬────────┘
         │ WebSocket (Socket Mode)
         ▼
┌─────────────────────────────────────┐
│           Bridge (Node.js)          │
│                                     │
│  ┌─────────────────────────────┐    │
│  │       Slack Bot Client      │    │
│  │   - 受信 / 投稿             │    │
│  └──────────────┬──────────────┘    │
│                 │                   │
│                 ▼                   │
│  ┌─────────────────────────────┐    │
│  │      Claude Executor        │    │
│  │                             │    │
│  │  - ウィンドウ管理 (JSON)     │    │
│  │  - Terminal起動 (AppleScript)│    │
│  │  - Stop hook完了監視        │    │
│  │  - ターミナル内容差分取得    │    │
│  └─────────────────────────────┘    │
└─────────────────────────────────────┘
         │
         ▼ AppleScript → Terminal
┌─────────────────────────────────────┐
│            Terminal.app             │
│  ┌─────────────────────────────┐    │
│  │  claude (対話モード)         │    │
│  │  - ウィンドウID管理          │    │
│  │  - 同一スレッド=同一ウィンドウ │    │
│  └─────────────────────────────┘    │
└─────────────────────────────────────┘
         │
         ▼ Stop hook
┌─────────────────────────────────────┐
│         scripts/on-stop.sh          │
│  - 完了マーカー作成                  │
└─────────────────────────────────────┘
```

## 2. コンポーネント設計

### 2.1 Slack Bot Client

**責務**: Slackイベントの受信と投稿

**使用ライブラリ**: `@slack/bolt` (Socket Mode対応)

**主要機能**:
- Socket Mode でイベント受信
- `message` イベントをフィルタリング
- スレッドへの返信投稿

### 2.2 Claude Executor

**責務**: Claude Code CLI の対話モード実行 + ウィンドウ管理

**主要機能**:
- ウィンドウ管理（JSONファイル永続化: thread_ts → window_id）
- Terminal起動（AppleScript経由）
- 新規セッション: 新しいターミナルウィンドウでclaude起動
- セッション継続: クリップボード + ペースト方式でメッセージ送信
- Stop hook監視による応答完了検知
- ターミナル内容の差分取得

## 3. データ構造

### 3.1 セッション対応表 (sessions.json)

```json
{
  "sessions": {
    "<thread_ts>": {
      "window_id": 12345,
      "session_id": "uuid-v4",
      "created_at": "2026-01-26T10:00:00.000Z",
      "last_used_at": "2026-01-26T10:30:00.000Z"
    }
  }
}
```

**特徴**:
- JSONファイルで永続化
- プロセス再起動後もセッション継続可能
- ウィンドウIDでターミナルを特定
- session_idでClaude Codeのセッションを特定（JSONLファイル取得、セッション再開に使用）

### 3.2 Stop hook用ファイル

| ファイル | 用途 | ライフサイクル |
|----------|------|---------------|
| `/tmp/claude_current_thread` | 現在処理中のthread_ts | 処理開始時に作成、応答取得後に削除 |
| `/tmp/claude_done_<thread_ts>` | 応答完了マーカー | Stop hookで作成、応答取得後に削除 |
| `/tmp/claude_stop_hook.log` | デバッグログ | 永続（手動削除） |

**注意**: `/tmp/claude_current_thread`は応答取得後に削除されるため、Slack経由以外でClaude Codeを使用してもStop hookは何も実行しない。

### 3.3 一時ファイル

| ファイル | 用途 | ライフサイクル |
|----------|------|---------------|
| `/tmp/claude-start-<thread_ts>.sh` | 新規セッション起動スクリプト | 応答取得後に削除 |
| `/tmp/claude-resume-<thread_ts>.scpt` | 既存ウィンドウへのメッセージ送信 | 応答取得後に削除 |
| `/tmp/claude-resume-new-<thread_ts>.sh` | セッション再開スクリプト | 応答取得後に削除 |
| `/tmp/claude-send-<thread_ts>.scpt` | セッション再開後のメッセージ送信 | 応答取得後に削除 |

## 4. 処理フロー

### 4.1 新規スレッド（親メッセージ）

```
1. Slack message イベント受信
2. フィルタリング
   - 対象チャンネルか？ → No: 無視
   - bot投稿か？ → Yes: 無視
   - thread_ts あり？ → Yes: 4.2へ
3. session_id (UUID) を生成
4. /tmp/claude_current_thread にthread_tsを書き込み
5. 新しいターミナルウィンドウを開く（AppleScript）
6. claude --dangerously-skip-permissions --session-id <uuid> を実行
7. ウィンドウID, session_id をsessions.jsonに保存
8. /tmp/claude_done_<thread_ts> を監視
9. 完了後、JSONLファイルから応答を取得
10. /tmp/claude_current_thread と一時ファイルを削除
11. Slack スレッドに返信案を投稿
```

### 4.2 スレッド内返信

```
1. Slack message イベント受信
2. フィルタリング
   - 対象チャンネルか？ → No: 無視
   - bot投稿か？ → Yes: 無視
   - thread_ts あり？ → No: 4.1へ
3. sessions.jsonからwindow_id, session_idを取得
   - 見つからない場合: エラー
4. ウィンドウが存在するか確認
   - 存在しない場合: 4.3へ
5. /tmp/claude_current_thread にthread_tsを書き込み
6. 対象ウィンドウをアクティブ化
7. クリップボード + Cmd+V + Cmd+Enter でメッセージ送信
8. /tmp/claude_done_<thread_ts> を監視
9. 完了後、JSONLファイルから応答を取得
10. /tmp/claude_current_thread と一時ファイルを削除
11. Slack スレッドに返信案を投稿
```

### 4.3 セッション再開（ターミナルが閉じられた場合）

```
1. /tmp/claude_current_thread にthread_tsを書き込み
2. 新しいターミナルウィンドウを開く（AppleScript）
3. claude --dangerously-skip-permissions --resume <session-id> を実行
4. 新しいウィンドウIDでsessions.jsonを更新
5. Claude Code起動完了を待機（4秒）
6. クリップボード + Cmd+V + Cmd+Enter でメッセージ送信
7. /tmp/claude_done_<thread_ts> をクリア（resume時のStop hook誤検知対策）
8. /tmp/claude_done_<thread_ts> を監視
9. 完了後、JSONLファイルから応答を取得
10. /tmp/claude_current_thread と一時ファイルを削除
11. Slack スレッドに返信案を投稿
```

## 5. Claude Code 実行詳細

### 5.1 実行方式

**対話モード + Stop hook方式**を採用:
1. AppleScriptでターミナルウィンドウを開く
2. `claude --dangerously-skip-permissions` で対話モード起動
3. 同じスレッドでは同じウィンドウにメッセージを送信
4. Stop hookで応答完了を検知
5. ターミナル内容の差分から応答を抽出

**理由**:
- ターミナル上でClaudeとのやり取りが可視化される
- 同一スレッド=同一セッションの対応が自然
- 対話の流れが維持される

### 5.2 新規セッション

```bash
cd /path/to/working/dir && claude --dangerously-skip-permissions --session-id "<uuid>" '<message>'
```

### 5.3 セッション継続（ウィンドウが存在する場合）

```applescript
-- クリップボードにメッセージをセット
set the clipboard to "<message>"

-- 対象ウィンドウをアクティブ化
tell application "Terminal"
    set frontmost of window id <window_id> to true
end tell

-- ペースト + Cmd+Enter（送信）
tell application "System Events"
    tell process "Terminal"
        keystroke "v" using command down
        delay 0.2
        keystroke return using command down
    end tell
end tell
```

### 5.4 セッション再開（ウィンドウが閉じられた場合）

```bash
cd /path/to/working/dir && claude --dangerously-skip-permissions --resume "<session-id>"
```

起動後、4秒待機してからAppleScriptでメッセージを送信（5.3と同じ方式）。

### 5.5 Stop hook設定（前提条件）

作業ディレクトリの `.claude/settings.json` に以下を追加:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/slack-claude-bridge/scripts/on-stop.sh"
          }
        ]
      }
    ]
  }
}
```

### 5.6 応答内容の取得

Claude CodeのJSONLログファイルから応答を取得:

```typescript
// JSONLファイルパス: ~/.claude/projects/<project-dir>/<session-id>.jsonl
const projectDir = workingDir.replace(/[\/\.]/g, '-');
const jsonlPath = path.join(os.homedir(), '.claude', 'projects', projectDir, `${sessionId}.jsonl`);

// ファイルを読み込み、最新のassistantメッセージを抽出
const content = await fs.readFile(jsonlPath, 'utf-8');
const lines = content.trim().split('\n');

for (let i = lines.length - 1; i >= 0; i--) {
  const entry = JSON.parse(lines[i]);
  if (entry.type === 'assistant' && entry.message?.content) {
    // textタイプのコンテンツを結合して返す
    return entry.message.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
  }
}
```

## 6. Slack投稿仕様

Claudeの応答をそのままスレッドに投稿する。

## 7. エラーハンドリング

| エラー種別 | 対応 |
|-----------|------|
| Stop hookタイムアウト | ログ記録、Slack投稿しない |
| Terminal起動失敗 | ログ記録、Slack投稿しない |
| ウィンドウID取得失敗 | エラーログ出力、処理スキップ |
| ターミナル内容取得失敗 | フォールバック（空文字列） |
| Slack投稿失敗 | ログ記録のみ |

## 8. 設定項目

```javascript
const config = {
  // Slack
  slackBotToken: process.env.SLACK_BOT_TOKEN,
  slackAppToken: process.env.SLACK_APP_TOKEN,  // Socket Mode用
  targetChannelId: process.env.TARGET_CHANNEL_ID,

  // Claude
  claudeWorkingDir: process.env.CLAUDE_WORKING_DIR || process.cwd(),
  claudeTimeout: 300000,  // 5分（デフォルト）

  // Sessions
  sessionsFilePath: './sessions.json',
};
```

## 9. ディレクトリ構成

```
slack-claude-bridge/
├── src/
│   ├── index.ts           # エントリーポイント
│   ├── slack-client.ts    # Slack Bot Client
│   ├── claude-executor.ts # Claude Executor + ウィンドウ管理
│   └── config.ts          # 設定
├── scripts/
│   └── on-stop.sh         # Stop hook用スクリプト
├── docs/
│   ├── requirements.md    # 要件定義書
│   └── design.md          # 設計書
├── sessions.json          # セッション対応表（自動生成）
├── package.json
├── tsconfig.json
└── .env                   # 環境変数
```

## 10. 技術選定

| 項目 | 選定 | 理由 |
|------|------|------|
| 言語 | TypeScript | 型安全、エラー検出 |
| Slack SDK | @slack/bolt | Socket Mode対応、公式 |
| プロセス実行 | child_process.exec + AppleScript | ウィンドウID管理、可視化 |
| 状態管理 | JSONファイル | 永続化、プロセス再起動後も継続可能 |
| 応答検知 | Stop hook + ファイル監視 | Claude Code標準機能を活用 |
| 応答取得 | JSONLファイル読み取り | Claude Codeのセッションログから確実に取得 |
| セッション再開 | --resume オプション | ターミナルが閉じられても会話を継続可能 |

## 11. 制限事項・既知の問題

| 項目 | 内容 |
|------|------|
| macOS専用 | AppleScriptを使用するためmacOSでのみ動作 |
| Terminalが必要 | 実行中にTerminal.appが開く（可視化のため） |
| Stop hook設定必須 | 作業ディレクトリに.claude/settings.jsonの設定が必要 |
| 同時処理制限 | 複数スレッドの同時処理は順次実行を推奨 |

## 12. 前提条件

### 12.1 Stop hook設定

Claude Code の Stop hook を設定する必要がある。

作業ディレクトリ（CLAUDE_WORKING_DIR）の `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/Users/chihiro/src/github.com/CHIHI913/slack-claude-bridge/scripts/on-stop.sh"
          }
        ]
      }
    ]
  }
}
```

### 12.2 アクセシビリティ権限

System Eventsでキーストロークを送信するため、Terminalにアクセシビリティ権限が必要:

1. システム設定 > プライバシーとセキュリティ > アクセシビリティ
2. Terminal.app を追加して有効化
