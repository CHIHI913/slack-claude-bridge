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
      logLevel: LogLevel.WARN,
    });

    this.claudeExecutor = new ClaudeExecutor();
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.app.message(async ({ message, say }) => {
      const msg = message as SlackMessage;

      // フィルタリング
      const eventKey = `${msg.channel}-${msg.ts}`;
      if (this.processedEvents.has(eventKey)) return;
      this.processedEvents.add(eventKey);

      if (this.processedEvents.size > 1000) {
        const firstKey = this.processedEvents.values().next().value;
        if (firstKey) this.processedEvents.delete(firstKey);
      }

      if ('subtype' in msg && msg.subtype) return;
      if ('bot_id' in msg) return;
      if (msg.channel !== config.targetChannelId) return;
      if (!msg.text) return;

      const text = msg.text;
      const threadTs = msg.thread_ts || msg.ts;
      const isThreadReply = !!msg.thread_ts;

      try {
        let response: string;

        if (isThreadReply && this.claudeExecutor.hasSession(threadTs)) {
          response = await this.claudeExecutor.executeResume(text, threadTs);
        } else {
          response = await this.claudeExecutor.executeNew(text, threadTs);
        }

        await say({ text: response, thread_ts: threadTs });
      } catch (error) {
        console.error('[ERROR]', error);
      }
    });
  }

  async start(): Promise<void> {
    await this.app.start();
    console.log('Bridge started');
  }

  async stop(): Promise<void> {
    await this.claudeExecutor.cleanup();
    await this.app.stop();
  }
}
