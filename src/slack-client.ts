import { App, LogLevel } from '@slack/bolt';
import { config } from './config';
import { ClaudeExecutor } from './claude-executor';

// メッセージイベントの型定義
interface SlackMessage {
  channel: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
}

export class SlackClient {
  private app: App;
  private claudeExecutor: ClaudeExecutor;
  private processedEvents: Set<string> = new Set(); // 重複排除用

  constructor() {
    this.app = new App({
      token: config.slackBotToken,
      appToken: config.slackAppToken,
      socketMode: true,
      logLevel: LogLevel.DEBUG,
    });

    this.claudeExecutor = new ClaudeExecutor();

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // 全イベントをログ出力（デバッグ用）
    this.app.use(async ({ body, next }) => {
      console.log('=== EVENT RECEIVED ===');
      console.log(JSON.stringify(body, null, 2));
      await next();
    });

    // メッセージイベントを直接処理
    this.app.message(async ({ message, say }) => {
      console.log('=== MESSAGE EVENT ===');
      console.log(JSON.stringify(message, null, 2));

      // 型キャスト
      const msg = message as SlackMessage;

      // 重複イベント排除（tsをキーに）
      const eventKey = `${msg.channel}-${msg.ts}`;
      if (this.processedEvents.has(eventKey)) {
        console.log(`[DUPLICATE] Ignoring already processed event: ${eventKey}`);
        return;
      }
      this.processedEvents.add(eventKey);

      // 古いイベントキーを削除（メモリリーク防止、1000件超えたら古いものを削除）
      if (this.processedEvents.size > 1000) {
        const firstKey = this.processedEvents.values().next().value;
        if (firstKey) this.processedEvents.delete(firstKey);
      }

      // subtypeがある場合は無視（システムメッセージなど）
      if ('subtype' in msg && msg.subtype) {
        console.log(`Ignoring subtype: ${msg.subtype}`);
        return;
      }

      // bot投稿は無視
      if ('bot_id' in msg) {
        console.log('Ignoring bot message');
        return;
      }

      // 対象チャンネルのみ処理
      if (msg.channel !== config.targetChannelId) {
        console.log(`Ignoring channel: ${msg.channel}`);
        return;
      }

      // テキストがない場合は無視
      if (!msg.text) {
        console.log('No text in message');
        return;
      }

      const text = msg.text;
      const threadTs = msg.thread_ts || msg.ts;
      const isThreadReply = !!msg.thread_ts;

      console.log(`Received message: ${text.substring(0, 50)}...`);
      console.log(`Thread: ${threadTs}, IsReply: ${isThreadReply}`);

      try {
        let response: string;

        if (isThreadReply && this.claudeExecutor.hasSession(threadTs)) {
          // スレッド内返信: セッション再開
          console.log(`Resuming session: ${threadTs}`);
          response = await this.claudeExecutor.executeResume(text, threadTs);
        } else {
          // 新規セッション
          console.log('Creating new session');
          response = await this.claudeExecutor.executeNew(text, threadTs);
        }

        // Slackに返信
        await say({
          text: response,
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

  async stop(): Promise<void> {
    console.log('Stopping Slack client...');
    await this.claudeExecutor.cleanup();
    await this.app.stop();
    console.log('Slack client stopped');
  }
}
