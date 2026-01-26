# Slack Claude Bridge

Slackの1スレッドを1つの会話単位とし、Mac上のClaude Codeの同一ターミナルセッションを再開しながら返信案を生成するBridge。

ターミナル上でClaudeとのやり取りが可視化される対話モードを採用。

## セットアップ

### 1. Slack App 作成

[Slack API](https://api.slack.com/apps) で新しいAppを作成（From scratch）

#### 1.1 Socket Mode 有効化

**Settings** → **Socket Mode**

1. **Enable Socket Mode** をオンにする
2. Token Name を入力（例: `socket-token`）
3. **Generate** をクリック
4. 表示された `xapp-...` トークンを控える（App-Level Token）

#### 1.2 OAuth & Permissions 設定

**Features** → **OAuth & Permissions** → **Bot Token Scopes**

以下のスコープを追加:

| Scope | 用途 |
|-------|------|
| `channels:history` | パブリックチャンネルのメッセージ読み取り |
| `groups:history` | プライベートチャンネルのメッセージ読み取り |
| `groups:read` | プライベートチャンネル情報の読み取り |
| `chat:write` | メッセージ投稿 |

#### 1.3 Event Subscriptions 設定

**Features** → **Event Subscriptions**

1. **Enable Events** をオンにする
2. **Subscribe to bot events** で以下を追加:
   - `message.channels`（パブリックチャンネル）
   - `message.groups`（プライベートチャンネル）
3. **Save Changes** をクリック

#### 1.4 ワークスペースにインストール

**Settings** → **Install App** → **Install to Workspace**

インストール後、`xoxb-...` トークンを控える（Bot Token）

#### 1.5 Botをチャンネルに招待

対象チャンネルで以下のいずれかを実行:
- `/invite @アプリ名` を入力
- チャンネル詳細 → インテグレーション → アプリを追加

### 2. Claude Code Stop hook 設定

Claude Code の応答完了を検知するため、Stop hook を設定する。

**作業ディレクトリ（CLAUDE_WORKING_DIR）の `.claude/settings.json`** を作成/編集:

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

`/path/to/slack-claude-bridge` はこのリポジトリの絶対パスに置き換えてください。

### 3. アクセシビリティ権限設定

System Eventsでキーストロークを送信するため、Terminalにアクセシビリティ権限が必要:

1. **システム設定** → **プライバシーとセキュリティ** → **アクセシビリティ**
2. **Terminal.app** を追加して有効化

### 4. 環境変数設定

```bash
cp .env.example .env
```

`.env` を編集:
```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
TARGET_CHANNEL_ID=C...
CLAUDE_WORKING_DIR=/path/to/your/project  # optional
```

### 5. 依存関係インストール

```bash
npm install
```

### 6. 起動

```bash
# 開発
npm run dev

# 本番
npm run build
npm start
```

### 7. 自動起動設定（オプション）

PC起動時に自動で立ち上げるには、launchdを使用する。

#### 7.1 plistファイルを作成

`~/Library/LaunchAgents/com.chihi913.slack-claude-bridge.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.chihi913.slack-claude-bridge</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/node</string>
        <string>dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/slack-claude-bridge</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/slack-claude-bridge.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/slack-claude-bridge.error.log</string>
</dict>
</plist>
```

`/path/to/node` と `/path/to/slack-claude-bridge` は環境に合わせて置き換える。

nodeのパス確認: `which node`

#### 7.2 有効化

```bash
# ビルド
npm run build

# 有効化
launchctl load ~/Library/LaunchAgents/com.chihi913.slack-claude-bridge.plist
```

#### 7.3 操作コマンド

| 操作 | コマンド |
|------|----------|
| 状態確認 | `launchctl list \| grep slack-claude` |
| 一時停止 | `launchctl stop com.chihi913.slack-claude-bridge` |
| 開始 | `launchctl start com.chihi913.slack-claude-bridge` |
| 完全停止 | `launchctl unload ~/Library/LaunchAgents/com.chihi913.slack-claude-bridge.plist` |
| 再有効化 | `launchctl load ~/Library/LaunchAgents/com.chihi913.slack-claude-bridge.plist` |
| ログ確認 | `tail -f /tmp/slack-claude-bridge.log` |
| エラー確認 | `tail -f /tmp/slack-claude-bridge.error.log` |

**注意**: `KeepAlive` が有効なため、「一時停止」しても自動再起動される。

## 使い方

1. 対象チャンネルでメッセージを投稿
2. Bridgeが 新しいターミナルウィンドウで Claude Code を起動
3. ターミナル上でClaudeとのやり取りが見える
4. 応答完了後、返信案がスレッドに投稿される
5. スレッド内で会話を続けると、同じターミナルウィンドウでやり取りが継続

## ディレクトリ構成

```
slack-claude-bridge/
├── src/
│   ├── index.ts           # エントリーポイント
│   ├── config.ts          # 設定
│   ├── slack-client.ts    # Slack Bot Client
│   └── claude-executor.ts # Claude Executor + ウィンドウ管理
├── scripts/
│   └── on-stop.sh         # Stop hook用スクリプト
├── docs/
│   ├── requirements.md    # 要件定義書
│   └── design.md          # 設計書
├── sessions.json          # セッション対応表（自動生成）
├── package.json
├── tsconfig.json
└── .env
```

## 動作原理

1. **新規スレッド**: 新しいターミナルウィンドウで `claude --dangerously-skip-permissions --session-id <uuid>` を起動
2. **スレッド内返信**: 既存のターミナルウィンドウにクリップボード経由でメッセージを送信（Cmd+Enter）
3. **ターミナルが閉じられた場合**: `claude --resume <session-id>` で新しいターミナルでセッションを再開
4. **応答検知**: Stop hook が完了マーカーファイルを作成
5. **応答取得**: Claude CodeのJSONLログファイルから応答を取得してSlackに投稿
6. **クリーンアップ**: 一時ファイルを自動削除

## 一時ファイル

処理中に `/tmp` 配下に一時ファイルを作成し、応答取得後に自動削除される。

| ファイル | 用途 |
|----------|------|
| `claude_current_thread` | 処理中のthread_ts（応答後削除） |
| `claude_done_<thread_ts>` | 完了マーカー（応答後削除） |
| `claude-start-*.sh` | 起動スクリプト（応答後削除） |
| `claude-resume-*.scpt` | メッセージ送信スクリプト（応答後削除） |
| `claude_stop_hook.log` | デバッグログ（永続） |

**注意**: `claude_current_thread` は応答取得後に削除されるため、Slack経由以外で直接Claude Codeを使用してもStop hookは何も実行しない（干渉しない）。

## 制限事項

- macOS専用（AppleScriptを使用）
- Terminal.appが必要（可視化のため）
- Stop hook設定が必須
