import type { SessionStore, StoredSession } from "./session-store.js";
import { sendMagicCode, verifyMagicCode, selectWorkspace } from "./magic-auth.js";

export interface TokenProvider {
  getToken(): Promise<string | null>;
  getWorkspaceId(): number | null;
  onRotate(seal: string): void;
  isConnected(): Promise<boolean>;
}

export interface WorkOSSessionProviderOptions {
  store: SessionStore;
  key: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export class WorkOSSessionProvider implements TokenProvider {
  private cache: StoredSession | null = null;

  constructor(private readonly opts: WorkOSSessionProviderOptions) {}

  private async load(): Promise<StoredSession | null> {
    if (this.cache) return this.cache;
    this.cache = await this.opts.store.get(this.opts.key);
    return this.cache;
  }

  private async save(session: StoredSession): Promise<void> {
    this.cache = session;
    await this.opts.store.set(this.opts.key, session);
  }

  async startConnect(email: string): Promise<void> {
    await sendMagicCode(this.opts.baseUrl, email, this.opts.fetchImpl);
  }

  async completeConnect(email: string, code: string): Promise<{ workspaceId: number | null }> {
    const r = await verifyMagicCode(this.opts.baseUrl, email, code, this.opts.fetchImpl);
    await this.save({ seal: r.session, workspaceId: r.workspaceId, email });
    return { workspaceId: r.workspaceId };
  }

  async setWorkspace(workspaceId: number): Promise<void> {
    const current = await this.load();
    if (!current) throw new Error("not connected");
    const r = await selectWorkspace(this.opts.baseUrl, current.seal, workspaceId, this.opts.fetchImpl);
    await this.save({ ...current, seal: r.session, workspaceId: r.workspaceId });
  }

  async getToken(): Promise<string | null> {
    return (await this.load())?.seal ?? null;
  }

  getWorkspaceId(): number | null {
    return this.cache?.workspaceId ?? null;
  }

  onRotate(seal: string): void {
    if (!this.cache) return;
    void this.save({ ...this.cache, seal });
  }

  async isConnected(): Promise<boolean> {
    return (await this.load()) != null;
  }
}

export class SealTokenProvider implements TokenProvider {
  private seal: string;

  constructor(
    seal: string,
    private readonly workspaceId: number | null,
    private readonly writeRotate?: (seal: string) => void,
  ) {
    this.seal = seal;
  }

  async getToken(): Promise<string | null> {
    return this.seal;
  }
  getWorkspaceId(): number | null {
    return this.workspaceId;
  }
  onRotate(seal: string): void {
    this.seal = seal;
    this.writeRotate?.(seal);
  }
  async isConnected(): Promise<boolean> {
    return true;
  }
}

export class StaticTokenProvider implements TokenProvider {
  private seal: string;
  private readonly workspaceId: number | null;

  constructor(seal: string, workspaceId: number | null = null) {
    this.seal = seal;
    this.workspaceId = workspaceId;
  }

  async getToken(): Promise<string | null> {
    return this.seal;
  }
  getWorkspaceId(): number | null {
    return this.workspaceId;
  }
  onRotate(seal: string): void {
    this.seal = seal;
  }
  async isConnected(): Promise<boolean> {
    return true;
  }
}
