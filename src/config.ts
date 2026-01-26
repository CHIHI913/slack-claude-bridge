import dotenv from 'dotenv';

dotenv.config();

export const config = {
  // Slack
  slackBotToken: process.env.SLACK_BOT_TOKEN || '',
  slackAppToken: process.env.SLACK_APP_TOKEN || '',
  targetChannelId: process.env.TARGET_CHANNEL_ID || '',

  // Claude
  claudeWorkingDir: process.env.CLAUDE_WORKING_DIR || process.cwd(),
  claudeTimeout: 120000, // 2分

  // Sessions
  sessionsFilePath: './sessions.json',
} as const;

export function validateConfig(): void {
  const required = ['slackBotToken', 'slackAppToken', 'targetChannelId'] as const;

  for (const key of required) {
    if (!config[key]) {
      throw new Error(`Missing required config: ${key}`);
    }
  }
}
