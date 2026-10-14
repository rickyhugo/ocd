import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { loginShellPath, parseShellPath, toolPath } from "./shell-env.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocd-shell-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A stand-in login shell named `name` that runs `body`, then the command it was given. */
function fakeShell(name: string, body: string): string {
  const path = join(root, name);
  writeFileSync(path, `#!/bin/sh\n${body}\nexec /bin/sh -c "$4"\n`, { mode: 0o755 });
  return path;
}

const MARK = "__OCD_SHELL_PATH__";

describe("reading the login shell's PATH", () => {
  it("parses the PATH between the markers, ignoring startup noise", () => {
    expect(parseShellPath(`motd\n${MARK}\n/a/bin:/usr/bin\n${MARK}\nbye\n`)).toBe(
      "/a/bin:/usr/bin",
    );
    expect(parseShellPath("no markers")).toBeNull();
    expect(parseShellPath(`${MARK}\n${MARK}\n`)).toBeNull();
    expect(parseShellPath(`${MARK}\nrelative:also\n${MARK}\n`)).toBeNull();
  });

  it("runs the shell as a login shell, without a terminal, and reads its PATH", async () => {
    const shell = fakeShell(
      "zsh",
      [
        'echo "Welcome back"',
        // rc files can tell OCD is asking and skip anything interactive.
        '[ "$OCD_RESOLVING_SHELL_ENV" = 1 ] || exit 3',
        '[ "$1 $2 $3" = "-l -i -c" ] || exit 4',
        "PATH=/opt/tools/bin:/usr/bin:/bin; export PATH",
      ].join("\n"),
    );
    expect(await loginShellPath({ shell })).toEqual({
      path: "/opt/tools/bin:/usr/bin:/bin",
      shell,
      error: null,
    });
  });

  it("does not wait for a background process that keeps stdout open", async () => {
    const shell = fakeShell(
      "bash",
      ["sleep 30 &", "PATH=/opt/tools/bin:/usr/bin:/bin; export PATH"].join("\n"),
    );
    const started = Date.now();
    const result = await loginShellPath({ shell, timeoutMs: 8000 });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(result.path).toBe("/opt/tools/bin:/usr/bin:/bin");
  });

  it("gives up on a shell that hangs, within the timeout", async () => {
    const shell = fakeShell("bash", "sleep 30");
    const started = Date.now();
    const result = await loginShellPath({ shell, timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result).toMatchObject({ path: null, error: expect.stringContaining("did not finish") });
  });

  it("reports a shell that prints no PATH or cannot run, and skips unknown shells", async () => {
    expect(await loginShellPath({ shell: fakeShell("fish", "exit 1") })).toMatchObject({
      path: null,
      error: expect.stringContaining("printed no PATH"),
    });
    expect(await loginShellPath({ shell: join(root, "missing", "zsh") })).toMatchObject({
      path: null,
      error: expect.stringContaining("could not be started"),
    });
    expect(await loginShellPath({ shell: "/usr/bin/nu" })).toMatchObject({
      path: null,
      error: "unsupported shell nu",
    });
    expect(await loginShellPath({ shell: null })).toMatchObject({ error: "no login shell" });
  });

  it("works with a real /bin/sh", async () => {
    const result = await loginShellPath({
      shell: "/bin/sh",
      env: { HOME: root, PATH: "/usr/bin:/bin" },
    });
    expect(result.error).toBeNull();
    expect(result.path?.split(":")).toContain("/usr/bin");
  });
});

describe("the PATH OCD runs tools with", () => {
  it("puts the login shell's PATH first, then the inherited one, then fallbacks", () => {
    const path = toolPath({
      login: "/login/bin:/usr/bin",
      inherited: "/inherited/bin:relative:/usr/bin:",
      platform: "darwin",
      home: "/Users/me",
    }).split(":");
    expect(path.slice(0, 3)).toEqual(["/login/bin", "/usr/bin", "/inherited/bin"]);
    expect(path).not.toContain("relative");
    expect(path).not.toContain("");
    expect(new Set(path).size).toBe(path.length);
    expect(path).toEqual(
      expect.arrayContaining(["/Users/me/.local/bin", "/opt/homebrew/bin", "/bin", "/sbin"]),
    );
  });

  it("still finds common install locations when the login shell could not be read", () => {
    const path = toolPath({
      login: null,
      inherited: "/usr/bin:/bin",
      platform: "linux",
      home: "/home/me",
    });
    expect(path.split(":")).toEqual(
      expect.arrayContaining([
        "/home/me/.local/bin",
        "/home/linuxbrew/.linuxbrew/bin",
        "/usr/local/bin",
      ]),
    );
  });
});
