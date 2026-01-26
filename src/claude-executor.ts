import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import * as path from 'path';
import { config } from './config';

const execAsync = promisify(exec);

interface SessionData {
  window_id: number;
  created_at: string;
  last_used_at: string;
  terminal_content_before: string;
}

interface SessionsFile {
  sessions: Record<string, SessionData>;
}

const SYSTEM_PROMPT = 'あなたはSlackでの返信案を生成するアシスタントです。日本語で回答してください。構成: 結論 → 理由 → 次アクション。断定しすぎず、提案形式で回答してください。返信案は1つだけ生成してください。';

export class ClaudeExecutor {
  private workingDir: string;
  private timeout: number;
  private sessionsFilePath: string;
  private sessions: Map<string, SessionData> = new Map();

  constructor(workingDir: string = config.claudeWorkingDir, timeout: number = config.claudeTimeout) {
    this.workingDir = workingDir;
    this.timeout = timeout;
    this.sessionsFilePath = config.sessionsFilePath;
    this.loadSessions();
  }

  private async loadSessions(): Promise<void> {
    try {
      const data = await fs.readFile(this.sessionsFilePath, 'utf-8');
      const parsed: SessionsFile = JSON.parse(data);
      this.sessions = new Map(Object.entries(parsed.sessions));
      console.log(`[SESSIONS] Loaded ${this.sessions.size} sessions from ${this.sessionsFilePath}`);
    } catch {
      console.log(`[SESSIONS] No existing sessions file, starting fresh`);
      this.sessions = new Map();
    }
  }

  private async saveSessions(): Promise<void> {
    const data: SessionsFile = {
      sessions: Object.fromEntries(this.sessions),
    };
    await fs.writeFile(this.sessionsFilePath, JSON.stringify(data, null, 2));
    console.log(`[SESSIONS] Saved ${this.sessions.size} sessions to ${this.sessionsFilePath}`);
  }

  async executeNew(message: string, threadTs: string): Promise<string> {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[NEW SESSION] Thread: ${threadTs}`);
    console.log(`${'='.repeat(60)}`);

    // 現在のthread_tsをファイルに書き込み（Stop hook用）
    await this.setCurrentThread(threadTs);

    // 完了マーカーを削除
    await this.clearDoneMarker(threadTs);

    // 一時シェルスクリプトファイルを作成（エスケープ問題を回避）
    const sanitizedThreadTs = threadTs.replace('.', '-');
    const scriptPath = `/tmp/claude-start-${sanitizedThreadTs}.sh`;
    const scriptContent = `#!/bin/zsh
cd "${this.workingDir}"
claude --dangerously-skip-permissions --append-system-prompt "${this.escapeForShell(SYSTEM_PROMPT)}" "${this.escapeForShell(message)}"
`;
    await fs.writeFile(scriptPath, scriptContent, { mode: 0o755 });
    console.log(`[SCRIPT] Created startup script: ${scriptPath}`);

    // 新しいターミナルウィンドウでスクリプトを実行
    const appleScript = `
tell application "Terminal"
  activate
  do script "${scriptPath}"
  set windowId to id of window 1
  return windowId
end tell
`;

    console.log(`[COMMAND] Executing script: ${scriptPath}`);

    const { stdout } = await execAsync(`osascript -e '${appleScript}'`);
    const windowId = parseInt(stdout.trim(), 10);
    console.log(`[WINDOW] Created new Terminal window, ID: ${windowId}`);

    // ターミナル内容の初期状態を取得
    await this.delay(500);
    const terminalContentBefore = await this.getTerminalContent(windowId);

    // セッション情報を保存
    const now = new Date().toISOString();
    this.sessions.set(threadTs, {
      window_id: windowId,
      created_at: now,
      last_used_at: now,
      terminal_content_before: terminalContentBefore,
    });
    await this.saveSessions();

    // 応答完了を待機
    const response = await this.waitForResponse(threadTs, windowId, terminalContentBefore);
    return response;
  }

  async executeResume(message: string, threadTs: string): Promise<string> {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[RESUME SESSION] Thread: ${threadTs}`);
    console.log(`${'='.repeat(60)}`);

    const sessionData = this.sessions.get(threadTs);
    if (!sessionData) {
      throw new Error(`Session not found for thread: ${threadTs}`);
    }

    // 現在のthread_tsをファイルに書き込み（Stop hook用）
    await this.setCurrentThread(threadTs);

    // 完了マーカーを削除
    await this.clearDoneMarker(threadTs);

    // 現在のターミナル内容を取得
    const terminalContentBefore = await this.getTerminalContent(sessionData.window_id);

    // クリップボードにメッセージをセットして、ペースト＋Enter
    // 一時AppleScriptファイルを作成（エスケープ問題を回避）
    const sanitizedThreadTs = threadTs.replace('.', '-');
    const scriptPath = `/tmp/claude-resume-${sanitizedThreadTs}.scpt`;
    const appleScript = `set the clipboard to "${this.escapeForAppleScript(message)}"

tell application "Terminal"
  activate
  set frontmost of window id ${sessionData.window_id} to true
end tell

delay 0.3

tell application "System Events"
  tell process "Terminal"
    keystroke "v" using command down
    delay 0.2
    keystroke return
  end tell
end tell
`;

    await fs.writeFile(scriptPath, appleScript);
    console.log(`[RESUME] Sending message to window ${sessionData.window_id}`);

    await execAsync(`osascript "${scriptPath}"`);

    // セッション情報を更新
    sessionData.last_used_at = new Date().toISOString();
    sessionData.terminal_content_before = terminalContentBefore;
    this.sessions.set(threadTs, sessionData);
    await this.saveSessions();

    // 応答完了を待機
    const response = await this.waitForResponse(threadTs, sessionData.window_id, terminalContentBefore);
    return response;
  }

  private async waitForResponse(threadTs: string, windowId: number, terminalContentBefore: string): Promise<string> {
    const doneMarkerPath = `/tmp/claude_done_${threadTs.replace('.', '-')}`;
    const startTime = Date.now();
    const checkInterval = 500;

    console.log(`[WAITING] Monitoring ${doneMarkerPath}`);

    while (Date.now() - startTime < this.timeout) {
      try {
        await fs.access(doneMarkerPath);
        console.log(`[DONE] Stop hook triggered for ${threadTs}`);

        // 少し待ってからターミナル内容を取得
        await this.delay(300);

        // ターミナル内容の差分を取得
        const terminalContentAfter = await this.getTerminalContent(windowId);
        const response = this.extractResponse(terminalContentBefore, terminalContentAfter);

        // マーカーを削除
        await this.clearDoneMarker(threadTs);

        return response;
      } catch {
        // マーカーがまだない
      }

      await this.delay(checkInterval);
    }

    throw new Error(`Timeout waiting for Claude response (${this.timeout}ms)`);
  }

  private async getTerminalContent(windowId: number): Promise<string> {
    try {
      const appleScript = `
        tell application "Terminal"
          set terminalContent to contents of tab 1 of window id ${windowId}
          return terminalContent
        end tell
      `;
      const { stdout } = await execAsync(`osascript -e '${appleScript.replace(/'/g, "'\\''")}'`);
      return stdout;
    } catch (error) {
      console.error(`[ERROR] Failed to get terminal content: ${error}`);
      return '';
    }
  }

  private extractResponse(before: string, after: string): string {
    // 差分を抽出
    // beforeの末尾以降の内容がClaudeの応答
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');

    // beforeの最後の行を探して、それ以降を取得
    let startIndex = 0;
    if (beforeLines.length > 0) {
      const lastBeforeLine = beforeLines[beforeLines.length - 1].trim();
      for (let i = 0; i < afterLines.length; i++) {
        if (afterLines[i].trim() === lastBeforeLine) {
          startIndex = i + 1;
        }
      }
    }

    const responseLines = afterLines.slice(startIndex);
    let response = responseLines.join('\n').trim();

    // プロンプト行（> など）を除去
    response = response.replace(/^>\s*/gm, '');

    // 空の場合はフォールバック
    if (!response) {
      response = after.slice(-2000); // 最後の2000文字
    }

    console.log(`[RESPONSE] Extracted ${response.length} characters`);
    return response;
  }

  private async setCurrentThread(threadTs: string): Promise<void> {
    const sanitizedThreadTs = threadTs.replace('.', '-');
    await fs.writeFile('/tmp/claude_current_thread', sanitizedThreadTs);
    console.log(`[THREAD] Set current thread to ${sanitizedThreadTs}`);
  }

  private async clearDoneMarker(threadTs: string): Promise<void> {
    const markerPath = `/tmp/claude_done_${threadTs.replace('.', '-')}`;
    try {
      await fs.unlink(markerPath);
      console.log(`[CLEANUP] Removed done marker ${markerPath}`);
    } catch {
      // マーカーが存在しない場合は無視
    }
  }

  private escapeForAppleScript(str: string): string {
    // AppleScriptのダブルクォート内で使用する場合のエスケープ
    return str
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');
  }

  private escapeForShell(str: string): string {
    // シェルのダブルクォート内で使用する場合のエスケープ
    return str
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`');
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  hasSession(threadTs: string): boolean {
    return this.sessions.has(threadTs);
  }

  getWindowId(threadTs: string): number | null {
    const sessionData = this.sessions.get(threadTs);
    return sessionData?.window_id || null;
  }

  async cleanup(): Promise<void> {
    console.log('Cleaning up Claude sessions...');
    this.sessions.clear();
  }
}
