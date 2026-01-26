# Slack Claude Bridge

Slackメッセージをトリガーに、Claude Code CLIを実行して返信案を生成するBridge。

## プロジェクト概要

- **目的**: Slackから自然言語で指示 → Claude Codeが自動実行 → 返信案をスレッドに投稿
- **実行環境**: Macローカル（Socket Mode、外部サーバ不要）
- **セッション管理**: 1スレッド = 1 Claudeセッション（`--resume`で再開）

## ディレクトリ構成

```
src/
├── index.ts           # エントリーポイント
├── config.ts          # 設定・環境変数
├── slack-client.ts    # Slack Bot Client（@slack/bolt）
├── session-manager.ts # thread_ts ↔ session_id 管理（JSON）
└── claude-executor.ts # Claude Code CLI実行
```

## 主要コンポーネント

| ファイル | 責務 |
|----------|------|
| `slack-client.ts` | Socket Modeでイベント受信、スレッド返信 |
| `session-manager.ts` | sessions.jsonの読み書き |
| `claude-executor.ts` | `claude -p` の実行、`--resume`でセッション再開 |

## 開発コマンド

```bash
npm run dev    # 開発モード（ts-node）
npm run build  # ビルド
npm start      # 本番実行
```

## 環境変数

| 変数 | 説明 |
|------|------|
| `SLACK_BOT_TOKEN` | Bot Token（xoxb-...） |
| `SLACK_APP_TOKEN` | App Token（xapp-...）Socket Mode用 |
| `TARGET_CHANNEL_ID` | 監視対象チャンネルID |
| `CLAUDE_WORKING_DIR` | Claude実行時のcwd（省略時: process.cwd()） |

## 処理フロー

1. Slackメッセージ受信（Socket Mode）
2. フィルタリング（対象チャンネル、bot除外）
3. thread_tsからsession_idを取得（なければ新規）
4. Claude Code CLI実行（`-p` + `--output-format json`）
5. session_idを保存、結果をスレッドに投稿

## コーディング規約

- TypeScript strict mode
- エラー時はSlackに投稿しない（ログのみ）
- sessions.jsonはシンプルに保つ
