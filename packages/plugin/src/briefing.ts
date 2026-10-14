import { OcdApiError, OcdClient } from "@ocd/core";

const BRIEFING_TTL_MS = 15_000;
const NOT_MANAGER_TTL_MS = 30_000;
/** After a failed fetch, do not ask again for this long (a wedged supervisor would stall every turn). */
const ERROR_TTL_MS = 10_000;
/** Entries untouched for this long are dropped. */
const PRUNE_AFTER_MS = 10 * 60_000;

/**
 * Supplies the bounded briefing to manager sessions only: the supervisor
 * decides from the session's directory. The context hook runs on every model
 * request, so results (including "not a manager") are cached briefly.
 */
export class BriefingCache {
  private readonly socketPath: string;
  private readonly directory: string;
  private readonly now: () => number;
  private readonly cache = new Map<
    string,
    { text: string | null; at: number; ttl: number; manager: boolean }
  >();

  constructor(socketPath: string, directory: string, now: () => number = Date.now) {
    this.socketPath = socketPath;
    this.directory = directory;
    this.now = now;
  }

  async forSession(sessionId: string): Promise<string | null> {
    const cached = this.cache.get(sessionId);
    if (cached && this.now() - cached.at < cached.ttl) return cached.text;
    this.prune();
    const client = new OcdClient({
      socketPath: this.socketPath,
      actor: "manager",
      sessionId,
      directory: this.directory,
      timeoutMs: 5_000,
    });
    try {
      const briefing = await client.briefing();
      this.cache.set(sessionId, {
        text: briefing.text,
        at: this.now(),
        ttl: BRIEFING_TTL_MS,
        manager: true,
      });
      return briefing.text;
    } catch (error) {
      if (error instanceof OcdApiError && error.status === 403) {
        this.cache.set(sessionId, {
          text: null,
          at: this.now(),
          ttl: NOT_MANAGER_TTL_MS,
          manager: false,
        });
        return null;
      }
      // Only a session that has been a manager hears that the supervisor is down.
      const text = cached?.manager
        ? "## OCD briefing\nThe OCD supervisor is unreachable, so task state may be stale. Ask the human to check `ocd status`."
        : null;
      this.cache.set(sessionId, {
        text,
        at: this.now(),
        ttl: ERROR_TTL_MS,
        manager: cached?.manager ?? false,
      });
      return text;
    }
  }

  private prune(): void {
    const now = this.now();
    for (const [id, entry] of this.cache) {
      if (now - entry.at > PRUNE_AFTER_MS) this.cache.delete(id);
    }
  }
}
