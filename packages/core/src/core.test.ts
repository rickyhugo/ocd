import { describe, expect, it } from "vite-plus/test";

import {
  canTransition,
  findSecrets,
  parseWorkerReport,
  plainText,
  redact,
  resolveOcdPaths,
  TASK_STATES,
} from "./index.ts";

describe("task state machine", () => {
  it("never completes without passing through review", () => {
    const into = TASK_STATES.filter((s) => canTransition(s, "completed"));
    expect(into).toEqual(["ready_for_review"]);
  });

  it("treats completed and cancelled as terminal", () => {
    for (const to of TASK_STATES) {
      expect(canTransition("completed", to)).toBe(false);
      expect(canTransition("cancelled", to)).toBe(false);
    }
  });
});

describe("secret detection", () => {
  it("finds common credential shapes", () => {
    expect(findSecrets("token: ghp_abcdefghijklmnopqrstuvwxyz0123")).toContain("GitHub token");
    expect(findSecrets("AKIAABCDEFGHIJKLMNOP")).toContain("AWS access key");
    expect(findSecrets("password=hunter2hunter2")).toContain("credential assignment");
    expect(findSecrets("Prefer small commits")).toEqual([]);
  });

  it("redacts in place", () => {
    expect(redact("use sk-ant-abcdefghijklmnopqrstuv now")).toBe("use [REDACTED] now");
  });
});

describe("plain text", () => {
  it("drops escape sequences, control and invisible characters", () => {
    const text = "\u001b[31mred\u001b[0m \u001b]0;title\u0007ok\u0007\u0000 \u202egnp.exe\u200b";
    expect(plainText(text)).toBe("red ok gnp.exe");
  });

  it("folds lines into one unless multiline, dropping blank lines", () => {
    const text = "  one\r\n\n\ttwo  \u2028three\r";
    expect(plainText(text)).toBe("one two three");
    expect(plainText(text, { multiline: true })).toBe("one\ntwo\nthree");
  });
});

describe("worker report protocol", () => {
  it("parses the last ocd-report block", () => {
    const text =
      'x\n```ocd-report\n{"summary":"old"}\n```\nmore\n```ocd-report\n{"summary":"new","changedFiles":["a.ts"]}\n```';
    const parsed = parseWorkerReport(text);
    expect(parsed.ok && parsed.report.summary).toBe("new");
    expect(parsed.ok && parsed.report.tests).toEqual([]);
  });

  it("rejects missing or malformed reports", () => {
    expect(parseWorkerReport("I'm done!").ok).toBe(false);
    expect(parseWorkerReport("```ocd-report\n{nope}\n```").ok).toBe(false);
    expect(parseWorkerReport('```ocd-report\n{"changedFiles":[]}\n```').ok).toBe(false);
  });
});

describe("paths", () => {
  it("defaults to ~/.ocd and honours OCD_HOME", () => {
    expect(resolveOcdPaths({ HOME: "/Users/x" }).home).toMatch(/\.ocd$/);
    const paths = resolveOcdPaths({ OCD_HOME: "/tmp/ocdtest" });
    expect(paths.socket).toBe("/tmp/ocdtest/run/ocd.sock");
  });

  it("rejects socket paths that are too long", () => {
    expect(() => resolveOcdPaths({ OCD_SOCKET: `/tmp/${"x".repeat(120)}.sock` })).toThrow(
      /too long/,
    );
  });
});
