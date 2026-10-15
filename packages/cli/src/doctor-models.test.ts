import { SupervisorConfig } from "@ocd/supervisor";
import { describe, expect, it } from "vite-plus/test";

import { checkProfileModels, modelLines, type RunList } from "./harnesses.ts";

const config = (profiles: Record<string, { harness: string; model: string }>, extra = {}) =>
  SupervisorConfig.parse({ profiles, ...extra });

const lists: Record<string, string> = {
  opencode: "openai/gpt-5\nanthropic/sonnet-4\n",
  codex: JSON.stringify({ models: [{ slug: "gpt-6", visibility: "list" }] }),
};

describe("checkProfileModels", () => {
  it("checks each profile against its harness's list, ignoring the #variant", async () => {
    const calls: string[][] = [];
    const list: RunList = async (binary, args) => {
      calls.push([binary.split("/").pop()!, ...args]);
      return lists[binary.split("/").pop()!] ?? null;
    };
    const reports = await checkProfileModels(
      config(
        {
          good: { harness: "opencode", model: "openai/gpt-5#high" },
          typo: { harness: "opencode", model: "openai/gpt-55" },
          cdx: { harness: "codex", model: "gpt-6#high" },
          cc: { harness: "claude", model: "sonnet" },
          cc2: { harness: "claude", model: "claude-sonnet-4-5" },
        },
        { claude: { enabled: true }, codex: { enabled: true } },
      ),
      list,
    );
    expect(reports.map((r) => [r.profile, r.status])).toEqual([
      ["good", "ok"],
      ["typo", "unknown"],
      ["cc", "ok"],
      ["cc2", "unchecked"],
      ["cdx", "ok"],
    ]);
    // One read-only listing per harness that has a list command, never one per profile.
    expect(calls).toEqual([
      ["opencode", "models"],
      ["codex", "debug", "models"],
    ]);
  });

  it("skips harnesses that are off, and does not guess when the list cannot be read", async () => {
    expect(
      await checkProfileModels(
        config({ cdx: { harness: "codex", model: "gpt-6" } }),
        async () => "never",
      ),
    ).toEqual([]);
    const reports = await checkProfileModels(
      config({ a: { harness: "opencode", model: "x/y" } }),
      async () => null,
    );
    expect(reports).toEqual([
      {
        profile: "a",
        harness: "opencode",
        model: "x/y",
        status: "unchecked",
        note: "its model list could not be read",
      },
    ]);
  });

  it("words a warning per unlisted model and notes what cannot be checked", () => {
    const lines = modelLines(
      [
        { profile: "typo", harness: "opencode", model: "x/y", status: "unknown" },
        { profile: "cc2", harness: "claude", model: "claude-x", status: "unchecked" },
        { profile: "fine", harness: "claude", model: "sonnet", status: "ok" },
      ],
      (h) => h,
    );
    expect(lines[0]).toContain("WARN profile typo (opencode x/y): not in the harness's model list");
    expect(lines[1]).toContain("not checkable");
    expect(lines[2]).toContain("ok profile fine");
  });
});
