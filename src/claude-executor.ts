import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { config } from './config';
import type { WaitResult, AskUserQuestionToolUse, AnswerSelection } from './types';

const execAsync = promisify(exec);

interface SessionData {
  window_id: number;
  session_id: string;  // Claude CodeのセッションID（UUID）
  created_at: string;
  last_used_at: string;
}

interface SessionsFile {
  sessions: Record<string, SessionData>;
}

const SYSTEM_PROMPT = '';

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
    } catch {
      this.sessions = new Map();
    }
  }

  private async saveSessions(): Promise<void> {
    const data: SessionsFile = {
      sessions: Object.fromEntries(this.sessions),
    };
    await fs.writeFile(this.sessionsFilePath, JSON.stringify(data, null, 2));
  }

  async executeNew(message: string, threadTs: string): Promise<WaitResult> {
    console.log(`[NEW] ${threadTs}`);

    await this.setCurrentThread(threadTs);
    await this.clearDoneMarker(threadTs);

    const sessionId = crypto.randomUUID();
    const sanitizedThreadTs = threadTs.replace('.', '-');
    const scriptPath = `/tmp/claude-start-${sanitizedThreadTs}.sh`;
    const systemPromptArg = SYSTEM_PROMPT ? `--append-system-prompt "${this.escapeForShell(SYSTEM_PROMPT)}"` : '';
    const scriptContent = `#!/bin/zsh
cd "${this.workingDir}"
claude --dangerously-skip-permissions --session-id "${sessionId}" ${systemPromptArg} "${this.escapeForShell(message)}"
`;
    await fs.writeFile(scriptPath, scriptContent, { mode: 0o755 });

    const appleScript = `
tell application "Terminal"
  activate
  do script "${scriptPath}"
  set windowId to id of window 1
  return windowId
end tell
`;

    const { stdout } = await execAsync(`osascript -e '${appleScript}'`);
    const windowId = parseInt(stdout.trim(), 10);

    // セッション情報を保存
    const now = new Date().toISOString();
    this.sessions.set(threadTs, {
      window_id: windowId,
      session_id: sessionId,
      created_at: now,
      last_used_at: now,
    });
    await this.saveSessions();

    // 応答完了を待機
    const result = await this.waitForResponse(threadTs, sessionId);
    if (result.type === 'final') {
      await this.cleanupTempFiles(threadTs);
    }
    return result;
  }

  async executeResume(message: string, threadTs: string): Promise<WaitResult> {
    console.log(`[RESUME] ${threadTs}`);

    const sessionData = this.sessions.get(threadTs);
    if (!sessionData) {
      throw new Error(`Session not found for thread: ${threadTs}`);
    }

    // ウィンドウが存在するか確認
    const windowExists = await this.checkWindowExists(sessionData.window_id);
    if (!windowExists) {
      console.log(`[RESUME] Window ${sessionData.window_id} not found, reopening session`);
      return this.executeResumeInNewTerminal(message, threadTs, sessionData.session_id);
    }

    await this.setCurrentThread(threadTs);
    await this.clearDoneMarker(threadTs);

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
    keystroke return using command down
  end tell
end tell
`;

    await fs.writeFile(scriptPath, appleScript);

    await execAsync(`osascript "${scriptPath}"`);

    // セッション情報を更新
    sessionData.last_used_at = new Date().toISOString();
    this.sessions.set(threadTs, sessionData);
    await this.saveSessions();

    // 応答完了を待機
    const result = await this.waitForResponse(threadTs, sessionData.session_id);
    if (result.type === 'final') {
      await this.cleanupTempFiles(threadTs);
    }
    return result;
  }

  private async executeResumeInNewTerminal(message: string, threadTs: string, sessionId: string): Promise<WaitResult> {
    await this.setCurrentThread(threadTs);
    await this.clearDoneMarker(threadTs);

    const sanitizedThreadTs = threadTs.replace('.', '-');
    const scriptPath = `/tmp/claude-resume-new-${sanitizedThreadTs}.sh`;
    const scriptContent = `#!/bin/zsh
cd "${this.workingDir}"
claude --dangerously-skip-permissions --resume "${sessionId}"
`;
    await fs.writeFile(scriptPath, scriptContent, { mode: 0o755 });

    // 新しいターミナルでセッション再開
    const openScript = `
tell application "Terminal"
  activate
  do script "${scriptPath}"
  set windowId to id of window 1
  return windowId
end tell
`;

    const { stdout } = await execAsync(`osascript -e '${openScript}'`);
    const windowId = parseInt(stdout.trim(), 10);

    // セッション情報を更新（新しいウィンドウID）
    const now = new Date().toISOString();
    this.sessions.set(threadTs, {
      window_id: windowId,
      session_id: sessionId,
      created_at: this.sessions.get(threadTs)?.created_at || now,
      last_used_at: now,
    });
    await this.saveSessions();

    // Claude Codeが起動するまで待機（resumeは起動に時間がかかる）
    await this.delay(4000);

    // AppleScriptでメッセージを送信
    const sendScriptPath = `/tmp/claude-send-${sanitizedThreadTs}.scpt`;
    const sendScript = `set the clipboard to "${this.escapeForAppleScript(message)}"

tell application "Terminal"
  activate
  set frontmost of window id ${windowId} to true
end tell

delay 0.3

tell application "System Events"
  tell process "Terminal"
    keystroke "v" using command down
    delay 0.2
    keystroke return using command down
  end tell
end tell
`;

    await fs.writeFile(sendScriptPath, sendScript);
    await execAsync(`osascript "${sendScriptPath}"`);

    // メッセージ送信後にdoneマーカーをクリア（セッション再開時の応答でマーカーが作成されている可能性があるため）
    await this.clearDoneMarker(threadTs);

    // 応答完了を待機
    const result = await this.waitForResponse(threadTs, sessionId);
    if (result.type === 'final') {
      await this.cleanupTempFiles(threadTs);
    }
    return result;
  }

  private async checkWindowExists(windowId: number): Promise<boolean> {
    const appleScript = `
tell application "Terminal"
  try
    get window id ${windowId}
    return true
  on error
    return false
  end try
end tell
`;
    try {
      const { stdout } = await execAsync(`osascript -e '${appleScript}'`);
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  private async waitForResponse(threadTs: string, sessionId: string): Promise<WaitResult> {
    const doneMarkerPath = `/tmp/claude_done_${threadTs.replace('.', '-')}`;
    const startTime = Date.now();
    const checkInterval = 500;
    let lastCheckedLine = 0;

    while (Date.now() - startTime < this.timeout) {
      // AskUserQuestionの検出（doneマーカーに関係なく常にチェック）
      const askQuestion = await this.checkForAskUserQuestion(sessionId, lastCheckedLine);
      if (askQuestion.found) {
        lastCheckedLine = askQuestion.lineCount;
        if (askQuestion.toolUse) {
          console.log(`[ASK] ${threadTs} - AskUserQuestion detected`);
          return {
            type: 'ask_user_question',
            toolUse: askQuestion.toolUse,
            sessionId: sessionId,
            threadTs: threadTs,
          };
        }
      }

      // doneマーカーの確認
      try {
        await fs.access(doneMarkerPath);
        await this.delay(500);

        // 最終応答かどうか確認（tool_useがある場合はまだ続く）
        const isFinal = await this.isFinalResponse(sessionId);
        if (!isFinal) {
          console.log(`[WAIT] ${threadTs} - tool_use detected, waiting for final response...`);
          await this.clearDoneMarker(threadTs);
          await this.delay(checkInterval);
          continue;
        }

        const response = await this.getResponseFromJsonl(sessionId);
        await this.clearDoneMarker(threadTs);
        await this.clearCurrentThread();
        console.log(`[DONE] ${threadTs}`);
        return { type: 'final', text: response };
      } catch {
        // マーカーがまだない
      }
      await this.delay(checkInterval);
    }

    throw new Error(`Timeout waiting for Claude response (${this.timeout}ms)`);
  }

  private async getResponseFromJsonl(sessionId: string): Promise<string> {
    const projectDir = this.workingDir.replace(/[\/\.]/g, '-');
    const jsonlPath = path.join(os.homedir(), '.claude', 'projects', projectDir, `${sessionId}.jsonl`);

    const content = await fs.readFile(jsonlPath, 'utf-8');
    const lines = content.trim().split('\n');

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'assistant' && entry.message?.content) {
          const textContent = entry.message.content
            .filter((c: { type: string }) => c.type === 'text')
            .map((c: { text: string }) => c.text)
            .join('\n');
          if (textContent) return textContent;
        }
      } catch {
        // JSONパースエラーは無視
      }
    }

    throw new Error('No assistant message found in JSONL');
  }

  private async isFinalResponse(sessionId: string): Promise<boolean> {
    const projectDir = this.workingDir.replace(/[\/\.]/g, '-');
    const jsonlPath = path.join(os.homedir(), '.claude', 'projects', projectDir, `${sessionId}.jsonl`);

    try {
      const content = await fs.readFile(jsonlPath, 'utf-8');
      const lines = content.trim().split('\n');

      // 最後のassistantメッセージを探す
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type === 'assistant' && entry.message?.content) {
            // content内にtool_useがあるかチェック（AskUserQuestion以外）
            const hasNonAskToolUse = entry.message.content.some(
              (c: { type: string; name?: string }) =>
                c.type === 'tool_use' && c.name !== 'AskUserQuestion'
            );
            // AskUserQuestion以外のtool_useがある場合はまだ続く
            return !hasNonAskToolUse;
          }
        } catch {
          // JSONパースエラーは無視
        }
      }
    } catch {
      // ファイル読み込みエラー
    }

    return false;
  }

  private async checkForAskUserQuestion(
    sessionId: string,
    lastCheckedLine: number = 0
  ): Promise<{ found: boolean; toolUse: AskUserQuestionToolUse | null; lineCount: number }> {
    const projectDir = this.workingDir.replace(/[\/\.]/g, '-');
    const jsonlPath = path.join(os.homedir(), '.claude', 'projects', projectDir, `${sessionId}.jsonl`);

    try {
      const content = await fs.readFile(jsonlPath, 'utf-8');
      const lines = content.trim().split('\n');
      const lineCount = lines.length;

      // 新しい行がなければスキップ
      if (lineCount <= lastCheckedLine) {
        return { found: false, toolUse: null, lineCount };
      }

      // 最後のassistantメッセージを探す（新しい行のみ）
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);

          // tool_resultがある場合は既に回答済みなのでスキップ
          if (entry.type === 'user' && entry.message?.content) {
            const hasToolResult = entry.message.content.some(
              (c: { type: string }) => c.type === 'tool_result'
            );
            if (hasToolResult) {
              // 既に回答済み
              return { found: true, toolUse: null, lineCount };
            }
          }

          if (entry.type === 'assistant' && entry.message?.content) {
            // AskUserQuestionのtool_useを探す
            const askToolUse = entry.message.content.find(
              (c: { type: string; name?: string }) =>
                c.type === 'tool_use' && c.name === 'AskUserQuestion'
            );
            if (askToolUse) {
              return { found: true, toolUse: askToolUse as AskUserQuestionToolUse, lineCount };
            }
            // 他のassistantメッセージが見つかったら、AskUserQuestionはない
            return { found: true, toolUse: null, lineCount };
          }
        } catch {
          // JSONパースエラーは無視
        }
      }
    } catch {
      // ファイル読み込みエラー
    }

    return { found: false, toolUse: null, lineCount: lastCheckedLine };
  }

  async sendUserAnswer(threadTs: string, selections: AnswerSelection[]): Promise<WaitResult> {
    console.log(`[ANSWER] ${threadTs} - Sending selections:`, selections.map(s =>
      `Q${s.questionIndex}: [${s.selectedIndices.join(',')}] (multiSelect: ${s.isMultiSelect})`
    ).join(', '));

    const sessionData = this.sessions.get(threadTs);
    if (!sessionData) {
      throw new Error(`Session not found for thread: ${threadTs}`);
    }

    // ウィンドウが存在するか確認
    const windowExists = await this.checkWindowExists(sessionData.window_id);
    if (!windowExists) {
      throw new Error(`Terminal window not found for thread: ${threadTs}`);
    }

    await this.clearDoneMarker(threadTs);

    // AppleScriptでキーストロークを送信
    const sanitizedThreadTs = threadTs.replace('.', '-');
    const scriptPath = `/tmp/claude-answer-${sanitizedThreadTs}.scpt`;

    // 各質問に対するキーストロークを生成
    const keystrokes: string[] = [];
    for (const selection of selections) {
      if (selection.isMultiSelect) {
        // multiSelect: 各選択肢に移動してスペースキーでチェック
        // 選択肢のインデックスをソートして順番に処理
        const sortedIndices = [...selection.selectedIndices].sort((a, b) => a - b);
        let currentPosition = 0;

        for (const targetIndex of sortedIndices) {
          // 現在位置から目標位置まで移動
          const moves = targetIndex - currentPosition;
          for (let i = 0; i < moves; i++) {
            keystrokes.push('key code 125'); // 下矢印
            keystrokes.push('delay 0.1');
          }
          // スペースキーでチェック
          keystrokes.push('keystroke space');
          keystrokes.push('delay 0.2');
          currentPosition = targetIndex;
        }

        // Submit/Next位置まで移動してエンター
        // 選択肢(0〜optionCount-1) → Type something(optionCount) → Next(optionCount+1)
        const submitPosition = selection.optionCount + 1;
        const movesToSubmit = submitPosition - currentPosition;
        for (let i = 0; i < movesToSubmit; i++) {
          keystrokes.push('key code 125'); // 下矢印
          keystrokes.push('delay 0.1');
        }
        keystrokes.push('keystroke return');
        keystrokes.push('delay 0.3');
      } else {
        // 単一選択: 下矢印で移動してエンター
        const index = selection.selectedIndices[0] || 0;
        for (let i = 0; i < index; i++) {
          keystrokes.push('key code 125'); // 下矢印
          keystrokes.push('delay 0.1');
        }
        keystrokes.push('keystroke return');
        keystrokes.push('delay 0.3');
      }
    }

    // 最後にSubmit確認画面でエンターを押す
    keystrokes.push('delay 0.5');
    keystrokes.push('keystroke return');

    const appleScript = `
tell application "Terminal"
  activate
  set frontmost of window id ${sessionData.window_id} to true
end tell

delay 0.3

tell application "System Events"
  tell process "Terminal"
    ${keystrokes.join('\n    ')}
  end tell
end tell
`;

    await fs.writeFile(scriptPath, appleScript);
    await execAsync(`osascript "${scriptPath}"`);

    // 応答完了を待機
    const result = await this.waitForResponse(threadTs, sessionData.session_id);

    // 一時ファイルのクリーンアップ
    try {
      await fs.unlink(scriptPath);
    } catch {
      // 無視
    }

    if (result.type === 'final') {
      await this.cleanupTempFiles(threadTs);
    }

    return result;
  }

  private async setCurrentThread(threadTs: string): Promise<void> {
    const sanitizedThreadTs = threadTs.replace('.', '-');
    await fs.writeFile('/tmp/claude_current_thread', sanitizedThreadTs);
  }

  private async clearCurrentThread(): Promise<void> {
    try {
      await fs.unlink('/tmp/claude_current_thread');
    } catch {
      // ファイルが存在しない場合は無視
    }
  }

  private async clearDoneMarker(threadTs: string): Promise<void> {
    const markerPath = `/tmp/claude_done_${threadTs.replace('.', '-')}`;
    try {
      await fs.unlink(markerPath);
    } catch {
      // マーカーが存在しない場合は無視
    }
  }

  private async cleanupTempFiles(threadTs: string): Promise<void> {
    const sanitizedThreadTs = threadTs.replace('.', '-');
    const tempFiles = [
      `/tmp/claude-start-${sanitizedThreadTs}.sh`,
      `/tmp/claude-resume-${sanitizedThreadTs}.scpt`,
      `/tmp/claude-resume-new-${sanitizedThreadTs}.sh`,
      `/tmp/claude-send-${sanitizedThreadTs}.scpt`,
    ];

    for (const filePath of tempFiles) {
      try {
        await fs.unlink(filePath);
      } catch {
        // ファイルが存在しない場合は無視
      }
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
