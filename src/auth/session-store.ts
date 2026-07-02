export interface StoredSession {
  seal: string;
  workspaceId: number | null;
  email?: string;
}

export interface SessionStore {
  get(key: string): Promise<StoredSession | null>;
  set(key: string, session: StoredSession): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  private readonly map = new Map<string, StoredSession>();

  async get(key: string): Promise<StoredSession | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, session: StoredSession): Promise<void> {
    this.map.set(key, session);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}
