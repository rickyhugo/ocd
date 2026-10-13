import { OcdClient } from "@ocd/core";

const MANAGER_TTL_MS = 30_000;
const BRIEFING_TTL_MS = 15_000;

/**
 * Supplies the bounded briefing for the registered manager session only. The
 * context hook runs on every model request, so results are cached briefly.
 */
export class BriefingCache {
  private readonly socketPath: string;
  private manager: { sessionId: string | null; at: number } | null = null;
  private briefing: { sessionId: string; text: string; at: number } | null = null;
  private readonly now: () => number;

  constructor(socketPath: string, now: () => number = Date.now) {
    this.socketPath = socketPath;
    this.now = now;
  }

  private client(sessionId?: string): OcdClient {
    return new OcdClient({
      socketPath: this.socketPath,
      actor: "manager",
      timeoutMs: 5_000,
      ...(sessionId ? { sessionId } : {}),
    });
  }

  private async managerSession(): Promise<string | null> {
    if (this.manager && this.now() - this.manager.at < MANAGER_TTL_MS)
      return this.manager.sessionId;
    try {
      const manager = await this.client().getManager();
      this.manager = { sessionId: manager?.sessionId ?? null, at: this.now() };
    } catch {
      // Keep the last known manager while the supervisor is unreachable.
      if (!this.manager) return null;
    }
    return this.manager?.sessionId ?? null;
  }

  async forSession(sessionId: string): Promise<string | null> {
    if ((await this.managerSession()) !== sessionId) return null;
    if (this.briefing?.sessionId === sessionId && this.now() - this.briefing.at < BRIEFING_TTL_MS)
      return this.briefing.text;
    try {
      const briefing = await this.client(sessionId).briefing();
      this.briefing = { sessionId, text: briefing.text, at: this.now() };
      return briefing.text;
    } catch {
      return "## OCD briefing\nThe OCD supervisor is unreachable, so task state may be stale. Ask the human to check `ocd status`.";
    }
  }
}
