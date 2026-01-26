import fs from 'fs';
import path from 'path';
import { validateConfig } from './config';
import { SlackClient } from './slack-client';

const PID_FILE = path.join(__dirname, '..', '.pid');

function checkExistingProcess(): void {
  if (fs.existsSync(PID_FILE)) {
    const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);

    try {
      // プロセスが存在するか確認（シグナル0は何もしないが、存在確認になる）
      process.kill(oldPid, 0);
      console.error(`Error: Another instance is already running (PID: ${oldPid})`);
      console.error('Run `pkill -f "ts-node"` to stop it, or delete .pid file if the process is dead.');
      process.exit(1);
    } catch {
      // プロセスが存在しない場合は古いPIDファイルを削除
      console.log(`Removing stale PID file (old PID: ${oldPid})`);
      fs.unlinkSync(PID_FILE);
    }
  }
}

function writePidFile(): void {
  fs.writeFileSync(PID_FILE, process.pid.toString());
  console.log(`PID file created: ${PID_FILE} (PID: ${process.pid})`);
}

function removePidFile(): void {
  if (fs.existsSync(PID_FILE)) {
    fs.unlinkSync(PID_FILE);
    console.log('PID file removed');
  }
}

async function main(): Promise<void> {
  console.log('Starting Slack Claude Bridge...');

  // 重複起動チェック
  checkExistingProcess();

  // PIDファイル作成
  writePidFile();

  let client: SlackClient | null = null;

  // Graceful shutdown ハンドラ
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}. Shutting down gracefully...`);

    if (client) {
      await client.stop();
    }

    removePidFile();
    process.exit(0);
  };

  // シグナルハンドラ登録
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 予期しない終了時もクリーンアップ
  process.on('exit', () => {
    removePidFile();
  });

  try {
    validateConfig();

    client = new SlackClient();
    await client.start();
  } catch (error) {
    console.error('Failed to start:', error);
    removePidFile();
    process.exit(1);
  }
}

main();
