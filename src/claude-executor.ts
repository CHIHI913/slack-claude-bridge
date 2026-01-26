import { spawn } from 'child_process';
import { config } from './config';

interface ClaudeResponse {
  session_id: string;
  result: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

const SYSTEM_PROMPT = `あなたはSlackでの返信案を生成するアシスタントです。
日本語で回答してください。
構成: 結論 → 理由 → 次アクション
断定しすぎず、提案形式で回答してください。
返信案は1つだけ生成してください。`;

export class ClaudeExecutor {
  private workingDir: string;
  private timeout: number;

  constructor(workingDir: string = config.claudeWorkingDir, timeout: number = config.claudeTimeout) {
    this.workingDir = workingDir;
    this.timeout = timeout;
  }

  async executeNew(message: string): Promise<ClaudeResponse> {
    const args = [
      '-p',
      message,
      '--output-format',
      'json',
      '--append-system-prompt',
      SYSTEM_PROMPT,
    ];

    return this.execute(args);
  }

  async executeResume(message: string, sessionId: string): Promise<ClaudeResponse> {
    const args = [
      '-p',
      message,
      '--resume',
      sessionId,
      '--output-format',
      'json',
    ];

    return this.execute(args);
  }

  private execute(args: string[]): Promise<ClaudeResponse> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      const proc = spawn('claude', args, {
        cwd: this.workingDir,
        timeout: this.timeout,
      });

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Claude exited with code ${code}: ${stderr}`));
          return;
        }

        try {
          const response = JSON.parse(stdout) as ClaudeResponse;
          resolve(response);
        } catch (error) {
          reject(new Error(`Failed to parse Claude response: ${stdout}`));
        }
      });

      proc.on('error', (error) => {
        reject(error);
      });
    });
  }
}
