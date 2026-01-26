# Slack Claude Bridge

Slackの1スレッドを1つの会話単位とし、Mac上のClaude Codeの同一セッションを再開しながら返信案を生成するBridge。

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
