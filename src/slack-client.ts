import { App, LogLevel } from '@slack/bolt';
import { config } from './config';
import { SessionManager } from './session-manager';
import { ClaudeExecutor } from './claude-executor';

export class SlackClient {
  private app: App;
  private sessionManager: SessionManager;
  private claudeExecutor: ClaudeExecutor;

  constructor() {
    this.app = new App({
      token: config.slackBotToken,
      appToken: config.slackAppToken,
      socketMode: true,
      logLevel: LogLevel.INFO,
    });

    this.sessionManager = new SessionManager();
    this.claudeExecutor = new ClaudeExecutor();

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.app.message(async ({ message, say }) => {
      // bot投稿は無視
      if ('bot_id' in message) {
        return;
      }

      // 対象チャンネルのみ処理
      if (message.channel !== config.targetChannelId) {
        return;
      }

      // テキストがない場合は無視
      if (!('text' in message) || !message.text) {
        return;
      }

      const text = message.text;
      const threadTs = ('thread_ts' in message ? message.thread_ts : message.ts) as string;
      const isThreadReply = 'thread_ts' in message;

      console.log(`Received message: ${text.substring(0, 50)}...`);
      console.log(`Thread: ${threadTs}, IsReply: ${isThreadReply}`);

      try {
        let response;

        if (isThreadReply) {
          // スレッド内返信: セッション再開
          const sessionId = this.sessionManager.getSessionId(threadTs);

          if (sessionId) {
            console.log(`Resuming session: ${sessionId}`);
            response = await this.claudeExecutor.executeResume(text, sessionId);
            this.sessionManager.updateLastUsed(threadTs);
          } else {
            // セッションが見つからない場合は新規作成
            console.log('Session not found, creating new one');
            response = await this.claudeExecutor.executeNew(text);
            this.sessionManager.saveSession(threadTs, response.session_id, message.channel);
          }
        } else {
          // 親メッセージ: 新規セッション
          console.log('Creating new session');
          response = await this.claudeExecutor.executeNew(text);
          this.sessionManager.saveSession(threadTs, response.session_id, message.channel);
        }

        // Slackに返信
        const replyText = `返信案（ドラフト）👇\n\n${response.result}`;

        await say({
          text: replyText,
          thread_ts: threadTs,
        });

        console.log('Reply sent successfully');
      } catch (error) {
        console.error('Error processing message:', error);
        // エラー時はSlackに投稿しない（要件通り）
      }
    });
  }

  async start(): Promise<void> {
    await this.app.start();
    console.log('Slack Claude Bridge is running!');
    console.log(`Watching channel: ${config.targetChannelId}`);
  }
}
