import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Interface } from "node:readline/promises";

import { loadConfig } from "@ocd/supervisor";
import { parse } from "jsonc-parser";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { NotificationApproval, NotifierPrerequisite } from "./platform/index.ts";
import {
  codexModels,
  runSetup,
  starterConfig,
  terminalPrompter,
  type Prompter,
  type RunResult,
  type ServiceState,
  type SetupDeps,
} from "./setup.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function gitRepo(path: string): string {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", path]);
  return path;
}

/** A temp machine: home, OCD home, a CLI build, and fakes for everything outside them. */
function machine(
  options: {
    answers?: Record<string, string | boolean>;
    checkout?: boolean;
    service?: ServiceState | null;
    tools?: string[];
    prerequisite?: NotifierPrerequisite | null;
    approval?: NotificationApproval | null;
    run?: (cmd: string, args: string[]) => RunResult | undefined;
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ocd-setup-")));
  dirs.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const ocdHome = join(home, ".ocd");
  // The CLI runs from a checkout (a git repo with packages/cli) or a bare directory.
  const ocdRoot = options.checkout ? gitRepo(join(root, "ocd")) : join(root, "ocd");
  const cliPath = join(ocdRoot, "packages", "cli", "dist", "ocd.mjs");
  mkdirSync(join(ocdRoot, "packages", "cli", "dist"), { recursive: true });
  writeFileSync(join(ocdRoot, "packages", "cli", "package.json"), "{}");
  writeFileSync(cliPath, "// ocd");
  const app = gitRepo(join(home, "code", "my-app"));
  const tools = new Set(["git", "opencode", ...(options.tools ?? [])]);
  const calls: string[][] = [];
  const asked: string[] = [];
  const out: string[] = [];
  let service = options.service === undefined ? defaultService() : options.service;
  const builds: unknown[] = [];

  const answer = (question: string): string | boolean | undefined => {
    asked.push(question);
    for (const [key, value] of Object.entries(options.answers ?? {}))
      if (question.includes(key)) return value;
    return undefined;
  };
  const prompt: Prompter = {
    async confirm(q, d) {
      const a = answer(q);
      return typeof a === "boolean" ? a : d;
    },
    async text(q, fallback) {
      const a = answer(q);
      return typeof a === "string" ? a : fallback;
    },
    async choose(q, _options, fallback) {
      const a = answer(q);
      return typeof a === "string" ? a : fallback;
    },
  };

  const deps: SetupDeps = {
    home,
    ocdHome,
    configPath: join(ocdHome, "ocd.jsonc"),
    platform: {
      notifierPrerequisite: () => options.prerequisite ?? null,
      notificationApproval: () => options.approval ?? null,
    },
    nodeVersion: "24.21.0",
    nodePath: "/usr/local/bin/node",
    cwd: app,
    cliPath,
    locate: (name) => (tools.has(name) ? `/bin/${name}` : null),
    async run(cmd, args) {
      calls.push([cmd, ...args]);
      const custom = options.run?.(cmd, args);
      if (custom) return custom;
      if (args[0] === "models")
        return { code: 0, stdout: "anthropic/claude-sonnet-x\nopenai/gpt-x\n", stderr: "" };
      if (args.includes("--notify"))
        return {
          code: 0,
          stdout: "notify    notify-send\n          test notification sent\n",
          stderr: "",
        };
      if (args[1] === "service" && args[2] === "install")
        service = { installed: true, loaded: true, definition: `${deps.nodePath} ${args[0]}` };
      return { code: 0, stdout: "", stderr: "" };
    },
    prompt,
    say: (line) => out.push(line),
    loginPath: async () => `${join(home, ".local", "bin")}:/usr/bin`,
    service: async () => service,
    async firstBuild(config) {
      builds.push(config.selfUpdate);
      const current = join(ocdHome, "install", "current", "packages", "cli", "dist");
      mkdirSync(current, { recursive: true });
      writeFileSync(join(current, "ocd.mjs"), "// built");
      return { sha: "abc1234def5678", error: null };
    },
    managerInstructions: () => "# OCD manager\n",
  };
  return { root, home, ocdHome, deps, calls, asked, out, app, cliPath, builds, ocdRoot };
}

function defaultService(): ServiceState {
  return { installed: false, loaded: false, definition: null };
}

describe("ocd setup", () => {
  it("sets up a fresh machine with the defaults, and a second run changes nothing", async () => {
    const m = machine({ tools: ["claude"] });
    const result = await runSetup(m.deps);
    expect(result.problems).toEqual([]);

    const config = loadConfig(m.deps.configPath);
    expect(config.manager?.directory).toBe("~/ocd-manager");
    expect(config.claude.enabled).toBe(true);
    expect(config.profiles["oc"]).toMatchObject({
      harness: "opencode",
      model: "anthropic/claude-sonnet-x",
      permissionPolicy: "ask",
    });
    expect(config.profiles["cc"]).toMatchObject({ harness: "claude", model: "sonnet" });
    expect(config.repos["my-app"]).toEqual({ path: "~/code/my-app", profile: "oc" });
    expect(readFileSync(m.deps.configPath, "utf8")).toContain("// OpenCode sessions started");

    const manager = join(m.home, "ocd-manager");
    expect(readFileSync(join(manager, "AGENTS.md"), "utf8")).toBe("# OCD manager\n");
    const plugin = parse(readFileSync(join(manager, ".opencode", "opencode.jsonc"), "utf8")) as {
      plugins: string[];
    };
    expect(plugin.plugins).toEqual([join(m.ocdRoot, "packages", "plugin")]);

    const link = join(m.home, ".local", "bin", "ocd");
    expect(readlinkSync(link)).toBe(m.cliPath);
    expect(m.calls).toContainEqual(["/usr/local/bin/node", m.cliPath, "service", "install"]);
    expect(m.calls).toContainEqual(["/bin/opencode", "reload"]);
    // Not a checkout: no self-update.
    expect(m.builds).toEqual([]);

    const before = readFileSync(m.deps.configPath, "utf8");
    m.calls.length = 0;
    m.asked.length = 0;
    expect((await runSetup(m.deps)).problems).toEqual([]);
    expect(readFileSync(m.deps.configPath, "utf8")).toBe(before);
    expect(m.asked).toEqual([]);
    expect(m.calls.some((c) => c.includes("install") || c.includes("reload"))).toBe(false);
  });

  it("only fills in what an existing config lacks, keeping its comments", async () => {
    const m = machine({ tools: ["codex"] });
    mkdirSync(m.ocdHome, { recursive: true });
    writeFileSync(
      m.deps.configPath,
      '{\n  // my settings\n  "concurrency": 3,\n  "profiles": { "mine": { "harness": "opencode", "model": "a/b" } },\n}\n',
    );
    await runSetup(m.deps);
    const text = readFileSync(m.deps.configPath, "utf8");
    expect(text).toContain("// my settings");
    const config = loadConfig(m.deps.configPath);
    expect(config.concurrency).toBe(3);
    expect(config.manager?.directory).toBe("~/ocd-manager");
    expect(config.repos["my-app"]).toMatchObject({ profile: "mine" });
    // Codex is installed but off: asked, and left off by default.
    expect(m.asked.some((q) => q.includes("Codex is installed but off"))).toBe(true);
    expect(config.codex.enabled).toBe(false);
    expect(Object.keys(config.profiles)).toEqual(["mine"]);
  });

  it("stops on an invalid config without touching it", async () => {
    const m = machine();
    mkdirSync(m.ocdHome, { recursive: true });
    writeFileSync(m.deps.configPath, '{ "concurrency": "many" }');
    const result = await runSetup(m.deps);
    expect(result.problems.join("\n")).toMatch(/concurrency/);
    expect(readFileSync(m.deps.configPath, "utf8")).toBe('{ "concurrency": "many" }');
    expect(existsSync(join(m.home, "ocd-manager"))).toBe(false);
  });

  it("links an existing config file instead of creating one", async () => {
    const m = machine({
      answers: { "Create one, or link": "link", "Path of the existing": "~/dotfiles/ocd.jsonc" },
    });
    mkdirSync(join(m.home, "dotfiles"));
    const file = join(m.home, "dotfiles", "ocd.jsonc");
    writeFileSync(file, '{ "manager": { "directory": "~/mgr" } }\n');
    await runSetup(m.deps);
    expect(lstatSync(m.deps.configPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(m.deps.configPath)).toBe(file);
    expect(existsSync(join(m.home, "mgr", "AGENTS.md"))).toBe(true);
  });

  it("merges the plugin into an existing OpenCode config, replacing an old OCD plugin path", async () => {
    const m = machine();
    const opencode = join(m.home, "ocd-manager", ".opencode");
    mkdirSync(opencode, { recursive: true });
    writeFileSync(
      join(opencode, "opencode.jsonc"),
      '{\n  // mine\n  "theme": "dark",\n  "plugins": ["other-plugin", "/old/ocd/packages/plugin"],\n}\n',
    );
    writeFileSync(join(m.home, "ocd-manager", "AGENTS.md"), "my own");
    await runSetup(m.deps);
    const text = readFileSync(join(opencode, "opencode.jsonc"), "utf8");
    expect(text).toContain("// mine");
    expect(text).toContain('"theme": "dark"');
    expect(text).toContain('"other-plugin"');
    expect(text).not.toContain("/old/ocd");
    expect(text).toContain(join(m.ocdRoot, "packages", "plugin"));
    expect(readFileSync(join(m.home, "ocd-manager", "AGENTS.md"), "utf8")).toBe("my own");
  });

  it("from a checkout, turns on self-update and points everything at the install", async () => {
    const m = machine({ checkout: true, tools: ["pnpm"] });
    const result = await runSetup(m.deps);
    expect(result.problems).toEqual([]);
    expect(m.builds).toEqual([expect.objectContaining({ enabled: true, path: m.ocdRoot })]);
    const config = loadConfig(m.deps.configPath);
    expect(config.selfUpdate).toMatchObject({ enabled: true, path: m.ocdRoot });
    // pnpm is on PATH: the default build commands stay.
    expect(config.selfUpdate.build[0]).toBe("pnpm install --frozen-lockfile");
    const current = join(m.ocdHome, "install", "current", "packages", "cli", "dist", "ocd.mjs");
    expect(readlinkSync(join(m.home, ".local", "bin", "ocd"))).toBe(current);
    expect(m.calls).toContainEqual(["/usr/local/bin/node", current, "service", "install"]);
    const plugin = readFileSync(join(m.home, "ocd-manager", ".opencode", "opencode.jsonc"), "utf8");
    expect(plugin).toContain(join(m.ocdHome, "install", "current", "packages", "plugin"));
  });

  it("builds with the pinned pnpm through npx when pnpm is not installed", async () => {
    const m = machine({ checkout: true });
    writeFileSync(
      join(m.ocdRoot, "package.json"),
      JSON.stringify({ devEngines: { packageManager: { name: "pnpm", version: "12.11.2" } } }),
    );
    await runSetup(m.deps);
    expect(loadConfig(m.deps.configPath).selfUpdate.build).toEqual([
      "npx --yes pnpm@12.11.2 install --frozen-lockfile",
      "npx --yes pnpm@12.11.2 run build",
    ]);
  });

  it("changes nothing outside OCD's home when every question is declined", async () => {
    const m = machine({
      checkout: true,
      answers: {
        "Keep OCD up to date": false,
        "Create the manager directory": false,
        "Put `ocd` on your PATH": false,
        "Install the background service": false,
        "Let the manager dispatch": false,
      },
    });
    const result = await runSetup(m.deps);
    expect(existsSync(join(m.home, "ocd-manager"))).toBe(false);
    expect(existsSync(join(m.home, ".local"))).toBe(false);
    expect(m.calls.some((c) => c.includes("install"))).toBe(false);
    expect(m.builds).toEqual([]);
    expect(result.problems.join("\n")).toMatch(/nowhere to run/);
  });

  it("starts the OpenCode service when asked, and stops early without OpenCode", async () => {
    const m = machine({
      run: (_cmd, args) =>
        args.join(" ") === "service status" ? { code: 1, stdout: "", stderr: "down" } : undefined,
    });
    await runSetup(m.deps);
    expect(m.calls).toContainEqual(["/bin/opencode", "service", "start"]);

    const bare = machine();
    bare.deps.locate = (name) => (name === "git" ? "/bin/git" : null);
    const result = await runSetup(bare.deps);
    expect(result.problems).toEqual([expect.stringMatching(/OpenCode not found/)]);
    expect(existsSync(bare.deps.configPath)).toBe(false);
  });

  it("warns when ~/.local/bin is not on the login PATH, and leaves a non-link ocd alone", async () => {
    const m = machine();
    m.deps.loginPath = async () => "/usr/bin:/bin";
    const bin = join(m.home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const other = join(m.root, "elsewhere");
    writeFileSync(other, "");
    symlinkSync(other, join(bin, "ocd"));
    const result = await runSetup(m.deps);
    expect(readlinkSync(join(bin, "ocd"))).toBe(m.cliPath);
    expect(result.problems.join("\n")).toMatch(/not on your login shell's PATH/);

    const n = machine();
    const nbin = join(n.home, ".local", "bin");
    mkdirSync(nbin, { recursive: true });
    writeFileSync(join(nbin, "ocd"), "#!/bin/sh\n");
    await runSetup(n.deps);
    expect(lstatSync(join(nbin, "ocd")).isSymbolicLink()).toBe(false);
  });
});

describe("setup helpers", () => {
  it("reads answers from a terminal: empty takes the default, numbers pick from the list", async () => {
    const replies = ["", "n", "Y", "", "2", "some/other-model", ""];
    const rl = { question: async () => replies.shift()! } as unknown as Interface;
    const p = terminalPrompter(rl, () => undefined);
    expect(await p.confirm("a", true)).toBe(true);
    expect(await p.confirm("b", true)).toBe(false);
    expect(await p.confirm("c", false)).toBe(true);
    expect(await p.text("d", "~/ocd-manager")).toBe("~/ocd-manager");
    expect(await p.choose("e", ["x/1", "x/2"], "x/1")).toBe("x/2");
    expect(await p.choose("f", ["x/1"], "x/1")).toBe("some/other-model");
    expect(await p.choose("g", ["x/1"], "x/1")).toBe("x/1");
  });

  describe("notification prerequisite", () => {
    const install = {
      question: "Install the notifier?",
      command: "/bin/fetch",
      args: ["notifier"],
      installed: "notifier installed",
      failed: "notifier install failed",
      declined: "notifications are plain",
    };
    const missing: NotifierPrerequisite = { ready: false, summary: "notifier missing", install };

    it("runs the platform's install command after consent, and reports it as given", async () => {
      const m = machine({ prerequisite: missing });
      await runSetup(m.deps);
      expect(m.asked).toContain("Install the notifier?");
      expect(m.calls).toContainEqual(["/bin/fetch", "notifier"]);
      expect(m.out.join("\n")).toContain("notifier installed");
    });

    it("does not run it when declined", async () => {
      const m = machine({ prerequisite: missing, answers: { "Install the notifier?": false } });
      await runSetup(m.deps);
      expect(m.calls).not.toContainEqual(["/bin/fetch", "notifier"]);
      expect(m.out.join("\n")).toContain("notifications are plain");
    });

    it("reports what is found or missing without asking when there is nothing to install", async () => {
      const found = machine({ prerequisite: { ready: true, summary: "notifier /bin/n" } });
      await runSetup(found.deps);
      expect(found.out.join("\n")).toContain("notifier /bin/n");
      const bare = machine({ prerequisite: { ready: false, summary: "no notifier here" } });
      await runSetup(bare.deps);
      expect(bare.asked.some((q) => q.includes("notifier"))).toBe(false);
      expect(bare.out.join("\n")).toContain("no notifier here");
    });

    it("opens the one-time approval step the platform asks for", async () => {
      let opened = 0;
      const m = machine({
        approval: {
          message: "approve it",
          open: async () => {
            opened++;
          },
        },
      });
      await runSetup(m.deps);
      expect(opened).toBe(1);
      expect(m.out.join("\n")).toContain("approve it");
    });
  });

  it("lists Codex's listed models in its order", () => {
    expect(
      codexModels(
        JSON.stringify({
          models: [
            { slug: "b", visibility: "list", priority: 2 },
            { slug: "hidden", visibility: "hide", priority: 0 },
            { slug: "a", visibility: "list", priority: 0 },
          ],
        }),
      ),
    ).toEqual(["a", "b"]);
    expect(codexModels("not json")).toEqual([]);
  });

  it("writes a starter config the daemon accepts", () => {
    const root = mkdtempSync(join(tmpdir(), "ocd-starter-"));
    dirs.push(root);
    const file = join(root, "ocd.jsonc");
    writeFileSync(
      file,
      starterConfig({
        manager: "~/m",
        tools: { codex: true, tmux: true },
        profiles: { codex: { harness: "codex", model: "gpt-x", permissionPolicy: "ask" } },
        repos: {},
      }),
    );
    const config = loadConfig(file);
    expect(config.codex.enabled).toBe(true);
    expect(config.tmux.enabled).toBe(true);
    expect(config.claude.enabled).toBe(false);
    expect(config.repos).toEqual({});
  });
});
