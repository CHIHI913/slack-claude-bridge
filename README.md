# Slack Claude Bridge

Slackの1スレッドを1つの会話単位とし、Mac上のClaude Codeの同一セッションを再開しながら返信案を生成するBridge。

## セットアップ

### 1. Slack App 作成

1. [Slack API](https://api.slack.com/apps) で新しいAppを作成
2. **Socket Mode** を有効化し、App-Level Token を生成（`connections:write` scope）
3. **OAuth & Permissions** で Bot Token Scopes を追加:
   - `channels:history`
   - `chat:write`
4. **Event Subscriptions** で Subscribe to bot events:
   - `message.channels`
5. ワークスペースにインストール

### 2. 環境変数設定

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

### 3. 依存関係インストール

```bash
npm install
```

### 4. 起動

```bash
# 開発
npm run dev

# 本番
npm run build
npm start
```

## 使い方

1. 対象チャンネルでメッセージを投稿
2. Bridgeが Claude Code を起動し、返信案をスレッドに投稿
3. スレッド内で会話を続けると、同じClaudeセッションが維持される

## ディレクトリ構成

```
slack-claude-bridge/
├── src/
│   ├── index.ts           # エントリーポイント
│   ├── config.ts          # 設定
│   ├── slack-client.ts    # Slack Bot Client
│   ├── session-manager.ts # Session Manager
│   └── claude-executor.ts # Claude Executor
├── sessions.json          # セッション対応表（自動生成）
├── package.json
├── tsconfig.json
└── .env
```
