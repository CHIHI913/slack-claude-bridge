import { validateConfig } from './config';
import { SlackClient } from './slack-client';

async function main(): Promise<void> {
  console.log('Starting Slack Claude Bridge...');

  try {
    validateConfig();

    const client = new SlackClient();
    await client.start();
  } catch (error) {
    console.error('Failed to start:', error);
    process.exit(1);
  }
}

main();
