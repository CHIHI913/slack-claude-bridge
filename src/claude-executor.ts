import { exec } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { config } from './config';

interface ClaudeResponse {
  result: string;
  session_id: string;
}

const SYSTEM_PROMPT = 'あなたはSlackでの返信案を生成するアシスタントです。日本語で回答してください。構成: 結論 → 理由 → 次アクション。断定しすぎず、提案形式で回答してください。返信案は1つだけ生成してください。';

export class ClaudeExecutor {
  private workingDir: string;
  private timeout: number;
  private sessions: Map<string, string> = new Map(); // threadTs -> sessionId

  constructor(workingDir: string = config.claudeWorkingDir, timeout: number = config.claudeTimeout) {
    this.workingDir = workingDir;
    this.timeout = timeout;
  }

  async executeNew(message: string, threadTs: string): Promise<string> {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[NEW SESSION] Thread: ${threadTs}`);
    console.log(`${'='.repeat(60)}`);

    const response = await this.runClaudeInTerminal(message, null, threadTs);

    // セッションIDを保存
    this.sessions.set(threadTs, response.session_id);
    console.log(`[SESSION SAVED] ${threadTs} -> ${response.session_id}`);

    return response.result;
  }

  async executeResume(message: string, threadTs: string): Promise<string> {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[RESUME SESSION] Thread: ${threadTs}`);
    console.log(`${'='.repeat(60)}`);

    const sessionId = this.sessions.get(threadTs);
    if (!sessionId) {
      throw new Error(`Session not found for thread: ${threadTs}`);
    }

    const response = await this.runClaudeInTerminal(message, sessionId, threadTs);
    return response.result;
  }

  private async runClaudeInTerminal(message: string, sessionId: string | null, threadTs: string): Promise<ClaudeResponse> {
    // 一時ファイルのパスを生成
    const outputFile = path.join(os.tmpdir(), `claude-output-${threadTs.replace('.', '-')}.json`);

    // メッセージをエスケープ
    const escapedMessage = message.replace(/'/g, "'\\''");
    const escapedSystemPrompt = SYSTEM_PROMPT.replace(/'/g, "'\\''");

    // claudeコマンド構築
    let claudeCmd = `claude -p '${escapedMessage}' --append-system-prompt '${escapedSystemPrompt}' --output-format json`;
    if (sessionId) {
      claudeCmd += ` --resume '${sessionId}'`;
    }

    // 出力をファイルに書き込むコマンド
    const fullCmd = `cd '${this.workingDir}' && ${claudeCmd} > '${outputFile}' 2>&1; echo "DONE" >> '${outputFile}'`;

    // AppleScriptでターミナルを開いてコマンド実行
    const appleScript = `
      tell application "Terminal"
        activate
        do script "${fullCmd.replace(/"/g, '\\"')}"
      end tell
    `;

    console.log(`[COMMAND] ${claudeCmd.substring(0, 100)}...`);
    console.log(`[OUTPUT FILE] ${outputFile}`);

    return new Promise((resolve, reject) => {
      // ターミナルでコマンドを実行
      exec(`osascript -e '${appleScript.replace(/'/g, "'\\''")}'`, async (error) => {
        if (error) {
          console.error(`[ERROR] Failed to open Terminal: ${error.message}`);
          reject(error);
          return;
        }

        // 出力ファイルを監視して結果を取得
        const startTime = Date.now();
        const checkInterval = 1000; // 1秒ごとにチェック

        const checkOutput = async () => {
          try {
            const content = await fs.readFile(outputFile, 'utf-8');

            // "DONE"が含まれていたら完了
            if (content.includes('DONE')) {
              // DONEを除去してJSONをパース
              const jsonContent = content.replace(/DONE\s*$/, '').trim();
              console.log(`[OUTPUT] ${jsonContent.substring(0, 200)}...`);

              try {
                const response = JSON.parse(jsonContent);
                const result: ClaudeResponse = {
                  result: response.result || '',
                  session_id: response.session_id || '',
                };
                console.log(`[RESPONSE] session_id: ${result.session_id}`);

                // 一時ファイルを削除
                await fs.unlink(outputFile).catch(() => {});

                resolve(result);
              } catch (parseError) {
                console.error(`[PARSE ERROR] ${parseError}`);
                resolve({
                  result: jsonContent,
                  session_id: sessionId || '',
                });
              }
              return;
            }
          } catch {
            // ファイルがまだ存在しない場合は無視
          }

          // タイムアウトチェック
          if (Date.now() - startTime > this.timeout) {
            reject(new Error(`Timeout waiting for Claude response (${this.timeout}ms)`));
            return;
          }

          // 再チェック
          setTimeout(checkOutput, checkInterval);
        };

        // 少し待ってからチェック開始
        setTimeout(checkOutput, 2000);
      });
    });
  }

  hasSession(threadTs: string): boolean {
    return this.sessions.has(threadTs);
  }

  getSessionId(threadTs: string): string | null {
    return this.sessions.get(threadTs) || null;
  }

  async cleanup(): Promise<void> {
    console.log('Cleaning up Claude sessions...');
    this.sessions.clear();
  }
}
