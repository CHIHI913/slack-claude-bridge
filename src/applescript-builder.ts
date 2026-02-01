import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * AppleScript生成・実行を担当するクラス
 */
export class AppleScriptBuilder {
  /**
   * AppleScript用のエスケープ処理
   */
  escapeForAppleScript(str: string): string {
    return str
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');
  }

  /**
   * シェル用のエスケープ処理
   */
  escapeForShell(str: string): string {
    return str
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`');
  }

  /**
   * 新しいターミナルウィンドウでスクリプトを実行
   */
  buildOpenTerminalScript(scriptPath: string): string {
    return `
tell application "Terminal"
  activate
  do script "${scriptPath}"
  set windowId to id of window 1
  return windowId
end tell
`;
  }

  /**
   * クリップボード経由でメッセージを送信するスクリプト
   */
  buildClipboardPasteScript(windowId: number, message: string): string {
    return `set the clipboard to "${this.escapeForAppleScript(message)}"

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
  }

  /**
   * ウィンドウ存在確認スクリプト
   */
  buildCheckWindowScript(windowId: number): string {
    return `
tell application "Terminal"
  try
    get window id ${windowId}
    return true
  on error
    return false
  end try
end tell
`;
  }

  /**
   * キーストローク送信スクリプト（AskUserQuestion回答用）
   */
  buildKeystrokeScript(windowId: number, keystrokes: string[]): string {
    return `
tell application "Terminal"
  activate
  set frontmost of window id ${windowId} to true
end tell

delay 0.3

tell application "System Events"
  tell process "Terminal"
    ${keystrokes.join('\n    ')}
  end tell
end tell
`;
  }

  /**
   * AppleScriptを直接実行（短いスクリプト用）
   */
  async executeInline(script: string): Promise<string> {
    const { stdout } = await execAsync(`osascript -e '${script}'`);
    return stdout.trim();
  }

  /**
   * AppleScriptファイルを実行
   */
  async executeFile(scriptPath: string): Promise<void> {
    await execAsync(`osascript "${scriptPath}"`);
  }

  /**
   * ウィンドウが存在するか確認
   */
  async checkWindowExists(windowId: number): Promise<boolean> {
    try {
      const result = await this.executeInline(this.buildCheckWindowScript(windowId));
      return result === 'true';
    } catch {
      return false;
    }
  }
}
