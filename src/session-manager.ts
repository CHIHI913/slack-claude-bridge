import fs from 'fs';
import { config } from './config';

interface Session {
  session_id: string;
  channel_id: string;
  created_at: string;
  last_used_at: string;
}

interface SessionStore {
  sessions: Record<string, Session>;
}

export class SessionManager {
  private store: SessionStore = { sessions: {} };
  private filePath: string;

  constructor(filePath: string = config.sessionsFilePath) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf-8');
        this.store = JSON.parse(data);
      }
    } catch (error) {
      console.error('Failed to load sessions:', error);
      this.store = { sessions: {} };
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.store, null, 2));
    } catch (error) {
      console.error('Failed to save sessions:', error);
    }
  }

  getSessionId(threadTs: string): string | null {
    const session = this.store.sessions[threadTs];
    return session?.session_id ?? null;
  }

  saveSession(threadTs: string, sessionId: string, channelId: string): void {
    const now = new Date().toISOString();
    const existing = this.store.sessions[threadTs];

    this.store.sessions[threadTs] = {
      session_id: sessionId,
      channel_id: channelId,
      created_at: existing?.created_at ?? now,
      last_used_at: now,
    };

    this.save();
  }

  updateLastUsed(threadTs: string): void {
    const session = this.store.sessions[threadTs];
    if (session) {
      session.last_used_at = new Date().toISOString();
      this.save();
    }
  }
}
