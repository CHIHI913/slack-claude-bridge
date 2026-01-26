import * as pty from 'node-pty';
import { exec } from 'child_process';
import { config } from './config';

interface ClaudeSession {
  pty: pty.IPty;
  threadTs: string;
  buffer: string;
  isWaitingForResponse: boolean;
  responseCallback: ((response: string) => void) | null;
}

const SYSTEM_PROMPT = `あなたはSlackでの返信案を生成するアシスタントです。
日本語で回答してください。
構成: 結論 → 理由 → 次アクション
断定しすぎず、提案形式で回答してください。
返信案は1つだけ生成してください。`;

export class ClaudeExecutor {
  private workingDir: string;
  private timeout: number;
  private sessions: Map<string, ClaudeSession> = new Map();

  constructor(workingDir: string = config.claudeWorkingDir, timeout: number = config.claudeTimeout) {
    this.workingDir = workingDir;
    this.timeout = timeout;
  }

  async executeNew(message: string, threadTs: string): Promise<string> {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[NEW SESSION] Thread: ${threadTs}`);
    console.log(`${'='.repeat(60)}`);

    // 新しいターミナルウィンドウを開く
    await this.openTerminalWindow(threadTs);

    // PTYでclaudeを起動
    const claudePty = pty.spawn('claude', ['--append-system-prompt', SYSTEM_PROMPT], {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd: this.workingDir,
      env: process.env as { [key: string]: string },
    });

    const session: ClaudeSession = {
      pty: claudePty,
      threadTs,
      buffer: '',
      isWaitingForResponse: false,
      responseCallback: null,
    };

    this.sessions.set(threadTs, session);

    // 出力を監視
    claudePty.onData((data) => {
      this.handleOutput(threadTs, data);
    });

    claudePty.onExit(({ exitCode }) => {
      console.log(`[SESSION ${threadTs}] Claude exited with code: ${exitCode}`);
      this.sessions.delete(threadTs);
    });

    // 少し待ってからメッセージを送信（Claude起動待ち）
    await this.sleep(2000);

    // メッセージを送信して返答を待つ
    return this.sendMessage(threadTs, message);
  }

  async executeResume(message: string, threadTs: string): Promise<string> {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[RESUME SESSION] Thread: ${threadTs}`);
    console.log(`${'='.repeat(60)}`);

    const session = this.sessions.get(threadTs);
    if (!session) {
      throw new Error(`Session not found for thread: ${threadTs}`);
    }

    return this.sendMessage(threadTs, message);
  }

  private async sendMessage(threadTs: string, message: string): Promise<string> {
    const session = this.sessions.get(threadTs);
    if (!session) {
      throw new Error(`Session not found for thread: ${threadTs}`);
    }

    console.log(`\n[USER] ${message}`);

    return new Promise((resolve, reject) => {
      session.buffer = '';
      session.isWaitingForResponse = true;
      session.responseCallback = resolve;

      // タイムアウト設定
      const timeoutId = setTimeout(() => {
        if (session.isWaitingForResponse) {
          session.isWaitingForResponse = false;
          session.responseCallback = null;
          reject(new Error(`Timeout waiting for response (${this.timeout}ms)`));
        }
      }, this.timeout);

      // メッセージを送信
      session.pty.write(message + '\r');

      // タイムアウトをクリアするためのラッパー
      const originalCallback = session.responseCallback;
      session.responseCallback = (response: string) => {
        clearTimeout(timeoutId);
        originalCallback?.(response);
      };
    });
  }

  private handleOutput(threadTs: string, data: string): void {
    const session = this.sessions.get(threadTs);
    if (!session) return;

    // ANSIエスケープコードを除去して表示
    const cleanData = this.stripAnsi(data);

    // ターミナルにも表示
    process.stdout.write(data);

    if (session.isWaitingForResponse) {
      session.buffer += data;

      // 返答完了の検出（プロンプトが表示されたら）
      // Claude CLIは返答後に ">" または "❯" プロンプトを表示
      if (this.isResponseComplete(session.buffer)) {
        session.isWaitingForResponse = false;
        const response = this.extractResponse(session.buffer);
        console.log(`\n[RESPONSE COMPLETE] Length: ${response.length} chars`);

        if (session.responseCallback) {
          session.responseCallback(response);
          session.responseCallback = null;
        }
      }
    }
  }

  private isResponseComplete(buffer: string): boolean {
    // Claude CLIのプロンプトパターンを検出
    // 返答後に新しいプロンプトが表示される
    const lines = buffer.split('\n');
    const lastLines = lines.slice(-3).join('\n');

    // プロンプトのパターン（複数のパターンに対応）
    const promptPatterns = [
      />\s*$/,           // ">" プロンプト
      /❯\s*$/,          // "❯" プロンプト
      /\$\s*$/,          // "$" プロンプト
      /claude>\s*$/i,    // "claude>" プロンプト
    ];

    return promptPatterns.some(pattern => pattern.test(lastLines));
  }

  private extractResponse(buffer: string): string {
    // ANSIエスケープコードを除去
    let clean = this.stripAnsi(buffer);

    // 入力されたメッセージ部分を除去（最初の行）
    const lines = clean.split('\n');

    // 最初の入力行と最後のプロンプト行を除去
    const responseLines = lines.slice(1, -1);

    // 空行をトリム
    let response = responseLines.join('\n').trim();

    // プロンプト記号が残っていたら除去
    response = response.replace(/^[>❯\$]\s*/, '').trim();

    return response;
  }

  private stripAnsi(str: string): string {
    // ANSIエスケープコードを除去
    return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
  }

  private async openTerminalWindow(threadTs: string): Promise<void> {
    const appleScript = `
      tell application "Terminal"
        activate
        do script "echo '=== Claude Session: ${threadTs} ===' && echo 'Waiting for Claude output...'"
        set custom title of front window to "Claude: ${threadTs}"
      end tell
    `;

    return new Promise((resolve, reject) => {
      exec(`osascript -e '${appleScript.replace(/'/g, "'\\''")}'`, (error) => {
        if (error) {
          console.error(`Failed to open Terminal: ${error.message}`);
          // ターミナルが開けなくてもエラーにはしない
        }
        resolve();
      });
    });
  }

  hasSession(threadTs: string): boolean {
    return this.sessions.has(threadTs);
  }

  getSessionId(threadTs: string): string | null {
    // PTYベースなのでセッションIDは不要だが、互換性のためthreadTsを返す
    return this.sessions.has(threadTs) ? threadTs : null;
  }

  async cleanup(): Promise<void> {
    console.log('Cleaning up Claude sessions...');
    for (const [threadTs, session] of this.sessions) {
      console.log(`Closing session: ${threadTs}`);
      session.pty.kill();
    }
    this.sessions.clear();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
