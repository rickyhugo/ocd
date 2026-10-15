import { readFileSync } from "node:fs";

import { OcdClient, routePath, routes, type AnyRoute } from "@ocd/core";
import { describe, expect, it } from "vite-plus/test";

import { buildApi } from "./api.ts";
import type { Logger } from "./logger.ts";

const entries = Object.entries(routes) as [string, AnyRoute][];

describe("API contract", () => {
  it("is registered by the supervisor, route for route", async () => {
    const quiet = {
      child: () => quiet,
      level: "silent",
      fatal() {},
      trace() {},
      info() {},
      warn() {},
      error() {},
      debug() {},
    };
    const app = buildApi({ apiToken: "t", logger: quiet as unknown as Logger } as never);
    await app.ready();
    for (const [name, route] of entries)
      expect(app.hasRoute({ method: route.method, url: route.path }), name).toBe(true);
    await app.close();
  });

  it("is the only way routes are registered", () => {
    // A hand-written route would bypass the table's parsing.
    const source = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bapp\.(get|post|delete|put|patch)\(/);
  });

  it("is what every OcdClient method sends", async () => {
    const client = new OcdClient({ socketPath: "/nowhere", actor: "human" });
    const sent: { method: string; path: string; timeoutMs?: number | undefined }[] = [];
    client.call = (async (
      method: string,
      path: string,
      _body: unknown,
      _query: unknown,
      options: { timeoutMs?: number },
    ) => {
      sent.push({ method, path, timeoutMs: options.timeoutMs });
    }) as typeof client.call;
    const methods = Object.entries(client).filter(
      (entry): entry is [string, (arg: string) => Promise<unknown>] =>
        typeof entry[1] === "function" && entry[0] !== "call" && entry[0] !== "withSession",
    );
    for (const [, method] of methods) await method("t_1");

    expect(sent).toHaveLength(methods.length);
    const key = (method: string, path: string) => `${method} ${path}`;
    expect(sent.map((s) => key(s.method, s.path)).toSorted()).toEqual(
      entries.map(([, r]) => key(r.method, routePath(r.path, { id: "t_1" }))).toSorted(),
    );
    for (const [name, route] of entries) {
      const call = sent.find(
        (s) => key(s.method, s.path) === key(route.method, routePath(route.path, { id: "t_1" })),
      );
      expect(call?.timeoutMs, name).toBe(route.timeoutMs);
    }
  });
});
