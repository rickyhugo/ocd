import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import type { Interface } from "node:readline/promises";

import { Slug } from "@ocd/core";
import {
  ConfigError,
  SelfUpdater,
  createLogger,
  loadConfig,
  normalizeDirectory,
  type SupervisorConfig,
} from "@ocd/supervisor";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

import type { ServiceManager } from "./platform/index.ts";
import { FORMAT, portable, readConfig, writeConfig } from "./repo-config.ts";

// `ocd setup`: one command from a fresh machine to a working OCD, and the
// command to run again whenever something looks off. Each step says what it
// found (✓), what it will do (→) or why it skipped (–), and asks before
// changing anything outside OCD's home. Everything that touches the system
// goes through SetupDeps, so the steps are tested against a temp home.

const CONFIG_SCHEMA_URL =
  "https://raw.githubusercontent.com/rickyhugo/ocd/main/schema/ocd.schema.json";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command; never rejects. `interactive` shows its output (and lets it ask) instead of capturing it. */
export type Run = (
  cmd: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number; interactive?: boolean },
) => Promise<RunResult>;

export interface Prompter {
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  text(question: string, fallback: string): Promise<string>;
  /** One of `options` (by number or name), or anything typed; empty takes `fallback`. */
  choose(question: string, options: string[], fallback: string): Promise<string>;
}

export interface ServiceState {
  installed: boolean;
  loaded: boolean;
  /** The definition file's contents, when installed. */
  definition: string | null;
}

export interface SetupDeps {
  /** The user's home directory (`~`). */
  home: string;
  /** OCD's home (~/.ocd or OCD_HOME). */
  ocdHome: string;
  configPath: string;
  platform: "macos" | "linux" | "unsupported";
  nodeVersion: string;
  /** The Node binary running this CLI; the service runs the same one. */
  nodePath: string;
  cwd: string;
  /** Real path of the running CLI (`…/packages/cli/dist/ocd.mjs`). */
  cliPath: string;
  locate(name: string): string | null;
  run: Run;
  prompt: Prompter;
  say(line: string): void;
  /** PATH as the user's login shell sets it up; null when unreadable. */
  loginPath(): Promise<string | null>;
  /** The background service, or null where OCD has no service manager. */
  service(): Promise<ServiceState | null>;
  /** Builds OCD from its checkout into <ocdHome>/install (self-update's first install). */
  firstBuild(config: SupervisorConfig): Promise<{ sha: string | null; error: string | null }>;
  /** The starter AGENTS.md for the manager directory. */
  managerInstructions(): string;
}

/** Setup cannot continue; the message says what to do first. */
export class SetupStop extends Error {}

type Tool = "claude" | "codex" | "github" | "tmux";
const TOOLS: { key: Tool; label: string; binary: string; login: string[] | null; hint: string }[] =
  [
    {
      key: "claude",
      label: "Claude Code",
      binary: "claude",
      login: ["auth", "status", "--json"],
      hint: "run `claude` and /login",
    },
    {
      key: "codex",
      label: "Codex",
      binary: "codex",
      login: ["login", "status"],
      hint: "run `codex login`",
    },
    {
      key: "github",
      label: "GitHub CLI (pull requests)",
      binary: "gh",
      login: ["auth", "status"],
      hint: "run `gh auth login`",
    },
    { key: "tmux", label: "tmux", binary: "tmux", login: null, hint: "" },
  ];

interface Detected {
  path: string | null;
  ready: boolean;
}

const MACOS_NOTIFICATION_SETTINGS =
  "x-apple.systempreferences:com.apple.Notifications-Settings.extension";

export interface SetupResult {
  /** Things that are not right yet; empty when everything is set up. */
  problems: string[];
}

export async function runSetup(deps: SetupDeps): Promise<SetupResult> {
  return new Setup(deps).run();
}

class Setup {
  private readonly d: SetupDeps;
  private readonly problems: string[] = [];
  private opencode = "opencode";
  private detected = {} as Record<Tool, Detected>;
  private config!: SupervisorConfig;
  /** The CLI everything should run: the install's `current` link, or this checkout's build. */
  private target!: string;
  private reloadOpenCode = false;
  private created = false;

  constructor(deps: SetupDeps) {
    this.d = deps;
  }

  async run(): Promise<SetupResult> {
    try {
      await this.prerequisites();
      await this.configure();
      await this.install();
      await this.manager();
      await this.link();
      await this.service();
      await this.reload();
      await this.notifications();
      await this.finish();
    } catch (error) {
      if (!(error instanceof SetupStop)) throw error;
      this.bad(error.message);
      this.problems.push(error.message);
      this.d.say("\nFix that and run `ocd setup` again; it picks up where it stopped.");
    }
    return { problems: this.problems };
  }

  // ── output ──

  private section(title: string): void {
    this.d.say(`\n${title}`);
  }
  private ok(line: string): void {
    this.d.say(`  ✓ ${line}`);
  }
  private doing(line: string): void {
    this.d.say(`  → ${line}`);
  }
  private skip(line: string): void {
    this.d.say(`  – ${line}`);
  }
  private bad(line: string): void {
    this.d.say(`  ✗ ${line}`);
  }
  private warn(line: string): void {
    this.d.say(`  ! ${line}`);
    this.problems.push(line);
  }

  /** `~/…` for paths under the home directory. */
  private show(path: string): string {
    return portable(path, this.d.home);
  }

  private expand(path: string): string {
    const expanded =
      path === "~" || path.startsWith("~/") ? join(this.d.home, path.slice(1)) : path;
    return resolve(this.d.cwd, expanded);
  }

  // ── a. prerequisites ──

  private async prerequisites(): Promise<void> {
    this.section("Prerequisites");
    const major = Number(this.d.nodeVersion.replace(/^v/, "").split(".")[0]);
    if (!(major >= 24)) throw new SetupStop(`Node ${this.d.nodeVersion} is too old; OCD needs 24+`);
    this.ok(`Node ${this.d.nodeVersion.replace(/^v/, "")}`);

    const git = this.d.locate("git");
    if (!git) throw new SetupStop("git not found; install git");
    this.ok(`git ${git}`);

    const opencode = this.d.locate("opencode");
    if (!opencode)
      throw new SetupStop(
        "OpenCode not found; install it (https://opencode.ai) so `opencode` runs",
      );
    this.opencode = opencode;
    this.ok(`OpenCode ${opencode}`);
    const status = await this.d.run(opencode, ["service", "status"], { timeoutMs: 15_000 });
    if (status.code === 0) {
      this.ok(
        `OpenCode service running${status.stdout.trim() ? ` (${status.stdout.trim()})` : ""}`,
      );
    } else if (
      await this.d.prompt.confirm(
        "OpenCode's background service is not running; the manager and OpenCode workers run in it. Start it (opencode service start)?",
        true,
      )
    ) {
      const started = await this.d.run(opencode, ["service", "start"], { timeoutMs: 60_000 });
      if (started.code === 0) this.ok("OpenCode service started");
      else this.warn(`OpenCode service did not start: ${tail(started)}`);
    } else this.warn("OpenCode service not running; start it with `opencode service start`");

    await this.notifierPrerequisite();

    for (const tool of TOOLS) {
      const path = this.d.locate(tool.binary);
      const ready =
        path !== null &&
        (tool.login === null ||
          (await this.d.run(path, tool.login, { timeoutMs: 20_000 })).code === 0);
      this.detected[tool.key] = { path, ready };
      if (!path) this.skip(`${tool.label}: not installed (optional)`);
      else if (!ready) this.skip(`${tool.label}: ${path}, not logged in (${tool.hint})`);
      else this.ok(`${tool.label}: ${path}${tool.login ? ", logged in" : ""}`);
    }
  }

  private async notifierPrerequisite(): Promise<void> {
    if (this.d.platform === "linux") {
      if (this.d.locate("notify-send")) this.ok("notify-send (desktop notifications)");
      else this.skip("notify-send not found: no desktop notifications (install libnotify)");
      return;
    }
    if (this.d.platform !== "macos") return;
    const found = this.d.locate("terminal-notifier");
    if (found) {
      this.ok(`terminal-notifier ${found}`);
      return;
    }
    const brew = this.d.locate("brew");
    const fallback = "notifications use osascript: no OCD icon, and clicking one does nothing";
    if (!brew) {
      this.skip(`${fallback} (install terminal-notifier for both)`);
      return;
    }
    if (
      await this.d.prompt.confirm(
        "Install terminal-notifier with Homebrew? Notifications then carry OCD's name and icon and open the manager when clicked",
        true,
      )
    ) {
      const r = await this.d.run(brew, ["install", "terminal-notifier"], {
        interactive: true,
        timeoutMs: 15 * 60_000,
      });
      if (r.code === 0) this.ok("terminal-notifier installed");
      else this.warn(`brew install terminal-notifier failed; ${fallback}`);
    } else this.skip(fallback);
  }

  // ── b. configuration ──

  private load(path = this.d.configPath): SupervisorConfig {
    try {
      return loadConfig(path);
    } catch (error) {
      if (error instanceof ConfigError) throw new SetupStop(error.message);
      throw error;
    }
  }

  private async configure(): Promise<void> {
    this.section("Configuration");
    const path = this.d.configPath;
    let link: string | null = null;
    try {
      if (lstatSync(path).isSymbolicLink()) link = readlinkSync(path);
    } catch {
      // nothing there
    }
    if (!existsSync(path)) {
      if (link !== null)
        throw new SetupStop(
          `${path} links to ${link}, which does not exist; fix or remove the link`,
        );
      const how = await this.d.prompt.choose(
        `No config at ${this.show(path)}. Create one, or link an existing file (for example in a config repo)?`,
        ["create", "link"],
        "create",
      );
      if (how === "link") await this.linkConfig();
      else await this.createConfig();
    }
    this.config = this.load();
    // A config made just now already has what the answers gave it.
    if (!this.created) await this.fillGaps();
    this.config = this.load();
    const c = this.config;
    this.ok(
      `${this.show(path)}${link ? ` → ${link}` : ""}: manager ${c.manager?.directory ?? "-"}, ${count(Object.keys(c.repos).length, "repo")}, ${count(Object.keys(c.profiles).length, "profile")}`,
    );
  }

  private async linkConfig(): Promise<void> {
    const answer = await this.d.prompt.text("Path of the existing ocd.jsonc", "");
    if (!answer) throw new SetupStop("no config file given");
    const from = this.expand(answer);
    if (!existsSync(from)) throw new SetupStop(`${from} does not exist`);
    this.load(from);
    mkdirSync(dirname(this.d.configPath), { recursive: true, mode: 0o700 });
    symlinkSync(from, this.d.configPath);
    this.doing(`linked ${this.show(this.d.configPath)} → ${this.show(from)}`);
  }

  private async askManagerDirectory(): Promise<string> {
    return this.d.prompt.text(
      "Manager directory (OpenCode sessions started there act as the OCD manager)",
      "~/ocd-manager",
    );
  }

  private async createConfig(): Promise<void> {
    const manager = await this.askManagerDirectory();
    const tools: Partial<Record<Tool, boolean>> = {};
    for (const tool of TOOLS) {
      if (!this.detected[tool.key]?.ready) continue;
      tools[tool.key] = await this.d.prompt.confirm(`Use ${tool.label}?`, true);
    }
    const profiles: Record<string, Record<string, string>> = {};
    const oc = await this.pickModel("opencode");
    if (oc) profiles["oc"] = { harness: "opencode", model: oc, permissionPolicy: "ask" };
    if (tools.claude) {
      const model = await this.pickModel("claude");
      if (model) profiles["cc"] = { harness: "claude", model, permissionPolicy: "ask" };
    }
    if (tools.codex) {
      const model = await this.pickModel("codex");
      if (model) profiles["codex"] = { harness: "codex", model, permissionPolicy: "ask" };
    }
    const profile = Object.keys(profiles)[0];
    const repos = await this.askRepos(new Set(), profile);
    const text = starterConfig({ manager, tools, profiles, repos });
    mkdirSync(dirname(this.d.configPath), { recursive: true, mode: 0o700 });
    writeFileSync(this.d.configPath, text, { mode: 0o600 });
    this.created = true;
    this.doing(`wrote ${this.show(this.d.configPath)}`);
    if (!profile)
      this.warn(
        "no profile yet (no model was chosen); add one under profiles in ocd.jsonc before dispatching",
      );
  }

  /** Offers what an existing config lacks, editing it in place (comments kept). */
  private async fillGaps(): Promise<void> {
    const c = this.config;
    const edits: { path: (string | number)[]; value: unknown; said: string }[] = [];
    if (!c.manager) {
      const directory = await this.askManagerDirectory();
      edits.push({
        path: ["manager"],
        value: { directory },
        said: `manager directory ${directory}`,
      });
    }
    const enabled = new Set<string>(["opencode"]);
    for (const tool of TOOLS) {
      if (c[tool.key].enabled) enabled.add(tool.key);
      else if (
        this.detected[tool.key]?.ready &&
        (await this.d.prompt.confirm(
          `${tool.label} is installed but off in ocd.jsonc. Turn it on?`,
          false,
        ))
      ) {
        enabled.add(tool.key);
        edits.push({ path: [tool.key, "enabled"], value: true, said: `turned on ${tool.label}` });
      }
    }
    const used = new Set(Object.values(c.profiles).map((p) => p.harness));
    const names = new Set(Object.keys(c.profiles));
    let firstProfile = Object.keys(c.profiles)[0];
    for (const harness of ["opencode", "claude", "codex"] as const) {
      if (!enabled.has(harness) || used.has(harness)) continue;
      if (
        !(await this.d.prompt.confirm(
          `No profile runs ${harnessLabel(harness)} workers. Add one?`,
          harness === "opencode",
        ))
      )
        continue;
      const model = await this.pickModel(harness);
      if (!model) continue;
      const name = unique(
        harness === "opencode" ? "oc" : harness === "claude" ? "cc" : "codex",
        names,
      );
      names.add(name);
      firstProfile ??= name;
      edits.push({
        path: ["profiles", name],
        value: { harness, model, permissionPolicy: "ask" },
        said: `profile ${name} (${harness} ${model})`,
      });
    }
    if (Object.keys(c.repos).length === 0) {
      const repos = await this.askRepos(new Set(), firstProfile);
      for (const [name, repo] of Object.entries(repos))
        edits.push({ path: ["repos", name], value: repo, said: `repo ${name} (${repo.path})` });
    }
    if (edits.length === 0) return;
    let { text } = readConfig(this.d.configPath);
    for (const edit of edits) text = applyEdits(text, modify(text, edit.path, edit.value, FORMAT));
    writeConfig(this.d.configPath, text);
    for (const edit of edits) this.doing(`added ${edit.said}`);
  }

  private async pickModel(harness: "opencode" | "claude" | "codex"): Promise<string | null> {
    let options: string[] = [];
    if (harness === "claude") options = ["sonnet", "opus", "haiku"];
    else if (harness === "opencode") {
      const r = await this.d.run(this.opencode, ["models"], { timeoutMs: 30_000 });
      options = r.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /^[^/\s]+\/\S+$/.test(l));
    } else {
      const codex = this.detected.codex?.path;
      const r = codex
        ? await this.d.run(codex, ["debug", "models"], { timeoutMs: 30_000 })
        : { code: 1, stdout: "", stderr: "" };
      options = codexModels(r.stdout);
    }
    const fallback =
      harness === "opencode"
        ? (options.find((m) => /sonnet/.test(m)) ?? options[0] ?? "")
        : (options[0] ?? "");
    const model = await this.d.prompt.choose(
      `Model for ${harnessLabel(harness)} workers${harness === "opencode" ? " (provider/model)" : ""}`,
      options,
      fallback,
    );
    if (!model) return null;
    if (harness === "opencode" && !/^[^/\s]+\/\S+$/.test(model)) {
      this.warn(`"${model}" is not a provider/model name; skipped`);
      return null;
    }
    return model;
  }

  /** The OCD checkout this CLI runs from, if it does (null when it runs from the install). */
  private checkoutRoot(): string | null {
    const root = resolve(dirname(this.d.cliPath), "..", "..", "..");
    return existsSync(join(root, ".git")) &&
      existsSync(join(root, "packages", "cli", "package.json"))
      ? root
      : null;
  }

  private gitRoot(path: string): string | null {
    // A repository root has its own .git (a directory, or a file in a worktree).
    return existsSync(join(path, ".git")) ? path : null;
  }

  private async askRepos(
    taken: Set<string>,
    profile: string | undefined,
  ): Promise<Record<string, { path: string; profile?: string }>> {
    const repos: Record<string, { path: string; profile?: string }> = {};
    const add = (path: string) => {
      const name = unique(repoName(path), taken);
      taken.add(name);
      repos[name] = { path: this.show(path), ...(profile ? { profile } : {}) };
      return name;
    };
    const cwd = this.gitRoot(this.d.cwd);
    const own = this.checkoutRoot();
    if (cwd && cwd !== own && !cwd.startsWith(this.d.ocdHome + sep)) {
      if (
        await this.d.prompt.confirm(
          `Let the manager dispatch work to ${this.show(cwd)} (as "${repoName(cwd)}")?`,
          true,
        )
      )
        add(cwd);
    }
    for (;;) {
      const answer = await this.d.prompt.text(
        "Another repository the manager may work in (path, empty to finish)",
        "",
      );
      if (!answer) break;
      const path = this.expand(answer);
      if (!this.gitRoot(path)) {
        this.skip(`${path} is not the root of a git repository`);
        continue;
      }
      this.doing(`repo ${add(path)}: ${this.show(path)}`);
    }
    return repos;
  }

  // ── d. install ──

  private get currentCli(): string {
    return join(this.d.ocdHome, "install", "current", "packages", "cli", "dist", "ocd.mjs");
  }

  private async install(): Promise<void> {
    this.section("Install");
    const builds = join(this.d.ocdHome, "install", "builds");
    let fromInstall = false;
    try {
      fromInstall = this.d.cliPath.startsWith(realpathSync(builds) + sep);
    } catch {
      // no builds yet
    }
    const su = this.config.selfUpdate;
    if (fromInstall || (su.enabled && existsSync(this.currentCli))) {
      this.target = this.currentCli;
      this.ok(
        `${su.enabled ? "self-update on; " : ""}OCD runs from ${this.show(dirname(dirname(dirname(dirname(this.currentCli)))))}`,
      );
      return;
    }
    const checkout = this.checkoutRoot();
    this.target = this.d.cliPath;
    if (!su.enabled) {
      if (!checkout) {
        this.skip(`self-update needs a git checkout of OCD; using ${this.show(this.d.cliPath)}`);
        return;
      }
      if (
        !(await this.d.prompt.confirm(
          `Keep OCD up to date from ${this.show(checkout)}? New commits on its default branch are built into ${this.show(join(this.d.ocdHome, "install"))}, smoke-tested and switched to (selfUpdate)`,
          true,
        ))
      ) {
        this.skip(
          `OCD runs from ${this.show(checkout)}; after pulling, \`pnpm run build\` and \`ocd restart\``,
        );
        return;
      }
      let { text } = readConfig(this.d.configPath);
      const set = (key: string, value: unknown) => {
        text = applyEdits(text, modify(text, ["selfUpdate", key], value, FORMAT));
      };
      const hadSelfUpdate = /"selfUpdate"\s*:/.test(text);
      set("enabled", true);
      set("path", this.show(checkout));
      if (!hadSelfUpdate)
        text = text.replace(
          /\n(\s*)"selfUpdate"\s*:/,
          '\n$1// OCD updates itself from this checkout, waiting while Claude Code / Codex workers run.\n$1"selfUpdate":',
        );
      // Builds run `pnpm`; without it on PATH, fetch the version OCD pins.
      if (!this.d.locate("pnpm")) {
        const pnpm = `npx --yes pnpm@${pinnedPnpm(checkout)}`;
        set("build", [`${pnpm} install --frozen-lockfile`, `${pnpm} run build`]);
      }
      writeConfig(this.d.configPath, text);
      this.doing(`turned on selfUpdate (following ${this.show(checkout)})`);
      this.config = this.load();
    }
    this.doing(`building OCD into ${this.show(join(this.d.ocdHome, "install"))} (a few minutes)…`);
    const built = await this.d.firstBuild(this.config);
    if (built.sha && existsSync(this.currentCli)) {
      this.target = this.currentCli;
      this.ok(`installed ${built.sha.slice(0, 7)}; OCD runs from the install from now on`);
    } else {
      this.warn(
        `the first build failed (${built.error ?? "unknown error"}); using ${this.show(this.d.cliPath)} for now (log: ${this.show(builds)})`,
      );
    }
  }

  private get pluginDir(): string {
    // <root>/packages/cli/dist/ocd.mjs → <root>/packages/plugin
    return join(dirname(dirname(dirname(this.target))), "plugin");
  }

  // ── c. manager directory ──

  private async manager(): Promise<void> {
    this.section("Manager");
    const configured = this.config.manager?.directory;
    if (!configured) {
      this.skip("no manager directory configured");
      return;
    }
    const dir = this.expand(configured);
    if (existsSync(dir)) this.ok(`manager directory ${this.show(dir)}`);
    else if (await this.d.prompt.confirm(`Create the manager directory ${this.show(dir)}?`, true)) {
      mkdirSync(dir, { recursive: true });
      this.doing(`created ${this.show(dir)}`);
    } else {
      this.warn(`${this.show(dir)} does not exist; the manager has nowhere to run`);
      return;
    }
    await this.pluginConfig(dir);
    const agents = join(dir, "AGENTS.md");
    if (existsSync(agents)) this.ok("AGENTS.md (kept as it is)");
    else if (
      await this.d.prompt.confirm("Write starter instructions for the manager (AGENTS.md)?", true)
    ) {
      writeFileSync(agents, this.d.managerInstructions());
      this.doing(`wrote ${this.show(agents)}`);
    }
  }

  /** Loads the OCD plugin in the manager directory only, keeping the rest of its OpenCode config. */
  private async pluginConfig(dir: string): Promise<void> {
    const json = join(dir, ".opencode", "opencode.json");
    const file = existsSync(json) ? json : join(dir, ".opencode", "opencode.jsonc");
    const existed = existsSync(file);
    let text = existed
      ? readFileSync(file, "utf8")
      : '{\n  "$schema": "https://opencode.ai/config.json",\n  // The OCD plugin: manager tools and briefing, loaded only in this directory.\n  "plugins": [],\n}\n';
    const errors: ParseError[] = [];
    const parsed = (parse(text, errors, { allowTrailingComma: true }) ?? {}) as Record<
      string,
      unknown
    >;
    if (errors.length) {
      this.warn(
        `${this.show(file)} has syntax errors; add "${this.pluginDir}" to its plugins yourself`,
      );
      return;
    }
    const plugins = Array.isArray(parsed["plugins"]) ? (parsed["plugins"] as unknown[]) : [];
    // An older OCD plugin path (a checkout or another install) is replaced, not duplicated.
    const others = plugins.filter((p) => typeof p !== "string" || !isOcdPlugin(p));
    const next = [...others, this.pluginDir];
    if (plugins.length === next.length && plugins.every((p, i) => p === next[i])) {
      this.ok(`OpenCode loads the OCD plugin from ${this.show(this.pluginDir)}`);
      return;
    }
    if (
      !(await this.d.prompt.confirm(
        `${existed ? "Point" : "Set up"} ${this.show(file)} to load the OCD plugin from ${this.show(this.pluginDir)}?`,
        true,
      ))
    ) {
      this.warn(`the manager has no OCD plugin; add "${this.pluginDir}" to plugins in ${file}`);
      return;
    }
    text = applyEdits(text, modify(text, ["plugins"], next, FORMAT));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    this.reloadOpenCode = true;
    this.doing(`${this.show(file)} loads ${this.show(this.pluginDir)}`);
  }

  // ── e. `ocd` on PATH ──

  private async link(): Promise<void> {
    this.section("Command");
    const binDir = join(this.d.home, ".local", "bin");
    const link = join(binDir, "ocd");
    let kind: "none" | "link" | "file" = "none";
    let points: string | null = null;
    try {
      const stat = lstatSync(link);
      kind = stat.isSymbolicLink() ? "link" : "file";
      if (kind === "link") points = resolve(binDir, readlinkSync(link));
    } catch {
      // not there
    }
    if (kind === "link" && points === this.target)
      this.ok(`${this.show(link)} → ${this.show(this.target)}`);
    else if (kind === "file")
      this.skip(
        `${this.show(link)} is a file, not a link; leaving it (it should run ${this.target})`,
      );
    else if (
      await this.d.prompt.confirm(
        kind === "link"
          ? `Repoint ${this.show(link)} (now ${points ? this.show(points) : "?"}) at ${this.show(this.target)}?`
          : `Put \`ocd\` on your PATH: link ${this.show(link)} → ${this.show(this.target)}?`,
        true,
      )
    ) {
      mkdirSync(binDir, { recursive: true });
      const tmp = `${link}.ocd-setup`;
      rmSync(tmp, { force: true });
      symlinkSync(this.target, tmp);
      renameSync(tmp, link);
      this.doing(`${this.show(link)} → ${this.show(this.target)}`);
    } else return;
    const path = await this.d.loginPath();
    if (path !== null && !path.split(delimiter).includes(binDir))
      this.warn(
        `${this.show(binDir)} is not on your login shell's PATH; add it in your shell profile: export PATH="$HOME/.local/bin:$PATH"`,
      );
  }

  // ── f. background service ──

  private async service(): Promise<void> {
    this.section("Background service");
    const state = await this.d.service();
    if (!state) {
      this.skip("no service manager here; run `ocd daemon` in a terminal");
      return;
    }
    // `service install` writes the stable path: the install's current link, or the checkout's real path.
    const cli = this.target === this.currentCli ? this.currentCli : realpathOr(this.target);
    const current =
      state.installed &&
      state.loaded &&
      !!state.definition?.includes(cli) &&
      state.definition.includes(this.d.nodePath);
    if (current) {
      this.ok("the supervisor runs in the background and starts at login");
      return;
    }
    if (
      !(await this.d.prompt.confirm(
        state.installed
          ? `Reinstall the background service so it runs ${this.show(cli)}? (restarts the supervisor)`
          : "Install the background service? The supervisor then runs in the background and starts at login",
        true,
      ))
    ) {
      this.skip("no background service; run `ocd daemon` in a terminal while you use OCD");
      return;
    }
    const r = await this.d.run(this.d.nodePath, [this.target, "service", "install"], {
      interactive: true,
      timeoutMs: 120_000,
    });
    if (r.code === 0) {
      this.reloadOpenCode = true;
      this.doing("background service installed");
    } else this.warn("`ocd service install` failed (see above)");
  }

  // ── g. OpenCode reload ──

  private async reload(): Promise<void> {
    if (!this.reloadOpenCode) return;
    this.section("OpenCode");
    const r = await this.d.run(this.opencode, ["reload"], { timeoutMs: 30_000 });
    if (r.code === 0) this.doing("reloaded OpenCode, so the manager picks up the plugin");
    else this.warn(`opencode reload failed: ${tail(r)}; run it yourself`);
  }

  // ── h. notifications ──

  private async notifications(): Promise<void> {
    this.section("Notifications");
    const appBefore = existsSync(join(this.d.ocdHome, "notifier", "OCD.app"));
    const r = await this.d.run(this.d.nodePath, [this.target, "doctor", "--notify"], {
      timeoutMs: 120_000,
    });
    const line = r.stdout
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("test notification"));
    if (line === "test notification sent") this.ok(line);
    else this.warn(line ?? `no test notification: ${tail(r)}`);
    if (this.d.platform === "macos" && !appBefore) {
      this.doing(
        'allow notifications for "OCD" in System Settings → Notifications (opening it now)',
      );
      await this.d.run("/usr/bin/open", [MACOS_NOTIFICATION_SETTINGS], { timeoutMs: 15_000 });
    }
  }

  // ── i. summary ──

  private async finish(): Promise<void> {
    this.section("Check (ocd doctor)");
    await this.d.run(this.d.nodePath, [this.target, "doctor"], {
      interactive: true,
      timeoutMs: 120_000,
    });
    const manager = this.config.manager?.directory ?? "~/ocd-manager";
    const repo = Object.keys(this.config.repos)[0];
    this.section(this.problems.length ? "Almost done" : "Done");
    for (const p of this.problems) this.d.say(`  ! ${p}`);
    this.d.say(
      [
        "  Open OpenCode in the manager directory and ask it for work:",
        `    cd ${manager} && opencode`,
        `    "In ${repo ?? "<repo>"}, fix …"`,
        "  More repositories: `ocd repo add <name> <path>`. Profiles and settings: ocd.jsonc.",
        "  Run `ocd setup` again any time to check or repair this setup.",
      ].join("\n"),
    );
  }
}

// ── helpers ──

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function tail(r: RunResult): string {
  return (r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).split("\n").slice(-3).join(" ");
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function harnessLabel(harness: "opencode" | "claude" | "codex"): string {
  return harness === "opencode" ? "OpenCode" : harness === "claude" ? "Claude Code" : "Codex";
}

/** An OCD plugin entry (a checkout's or an install's packages/plugin). */
function isOcdPlugin(entry: string): boolean {
  return /(^|\/)packages\/plugin\/?$/.test(entry);
}

function repoName(path: string): string {
  const name = basename(path)
    .toLowerCase()
    .replace(/^\.+/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|-+$/g, "")
    .slice(0, 63);
  return Slug.safeParse(name).success ? name : "repo";
}

function unique(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name}-${i}`)) return `${name}-${i}`;
}

/** Listed Codex models, in Codex's own order (`codex debug models`). */
export function codexModels(stdout: string): string[] {
  try {
    const models = (
      JSON.parse(stdout) as { models?: { slug: string; visibility?: string; priority?: number }[] }
    ).models;
    return (models ?? [])
      .filter((m) => m.visibility === undefined || m.visibility === "list")
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
      .map((m) => m.slug);
  } catch {
    return [];
  }
}

/** The pnpm version the checkout pins (devEngines.packageManager). */
function pinnedPnpm(checkout: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")) as {
      devEngines?: { packageManager?: { version?: string } };
      packageManager?: string;
    };
    return (
      pkg.devEngines?.packageManager?.version ??
      /^pnpm@([^+]+)/.exec(pkg.packageManager ?? "")?.[1] ??
      "latest"
    );
  } catch {
    return "latest";
  }
}

/** A new ocd.jsonc, with comments that say what each part is for. */
export function starterConfig(input: {
  manager: string;
  tools: Partial<Record<Tool, boolean>>;
  profiles: Record<string, Record<string, string>>;
  repos: Record<string, { path: string; profile?: string }>;
}): string {
  const entries = (record: Record<string, unknown>) =>
    Object.entries(record)
      .map(([k, v]) => `    ${JSON.stringify(k)}: ${inline(v)},`)
      .join("\n");
  const tools = TOOLS.filter((t) => input.tools[t.key])
    .map((t) => `  ${JSON.stringify(t.key)}: { "enabled": true },`)
    .join("\n");
  return [
    "{",
    `  "$schema": ${JSON.stringify(CONFIG_SCHEMA_URL)},`,
    "  // OpenCode sessions started in this directory act as the OCD manager.",
    `  "manager": { "directory": ${JSON.stringify(input.manager)} },`,
    ...(tools
      ? [
          "  // Optional tools (off unless turned on): Claude Code / Codex workers, gh, tmux.",
          tools,
        ]
      : []),
    "  // Repositories the manager may dispatch to (`ocd repo add <name> <path>`).",
    `  "repos": {${Object.keys(input.repos).length ? `\n${entries(input.repos)}\n  ` : ""}},`,
    '  // Named recipes for running a worker. permissionPolicy "ask" sends each permission request to you.',
    `  "profiles": {${Object.keys(input.profiles).length ? `\n${entries(input.profiles)}\n  ` : ""}},`,
    "}",
    "",
  ].join("\n");
}

function inline(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value))
    return `{ ${Object.entries(value)
      .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
      .join(", ")} }`;
  return JSON.stringify(value);
}

// ── the real system ──

/** Prompts on a terminal; with `yes`, takes every default and says so. */
export function terminalPrompter(rl: Interface | null, say: (line: string) => void): Prompter {
  if (!rl)
    return {
      async confirm(question, defaultYes) {
        say(`  ? ${question} ${defaultYes ? "yes" : "no"} (--yes)`);
        return defaultYes;
      },
      async text(question, fallback) {
        if (fallback) say(`  ? ${question} ${fallback} (--yes)`);
        return fallback;
      },
      async choose(question, _options, fallback) {
        say(`  ? ${question} ${fallback || "(none)"} (--yes)`);
        return fallback;
      },
    };
  return {
    async confirm(question, defaultYes) {
      const a = (await rl.question(`  ? ${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `))
        .trim()
        .toLowerCase();
      return a === "" ? defaultYes : a.startsWith("y");
    },
    async text(question, fallback) {
      return (
        (await rl.question(`  ? ${question}${fallback ? ` [${fallback}]` : ""}: `)).trim() ||
        fallback
      );
    },
    async choose(question, options, fallback) {
      const shown = options.slice(0, 30);
      say(`  ? ${question}`);
      shown.forEach((o, i) => say(`      ${String(i + 1).padStart(2)}. ${o}`));
      if (options.length > shown.length)
        say(`      … ${options.length - shown.length} more; type any name`);
      const a = (
        await rl.question(`    number or name${fallback ? ` [${fallback}]` : ""}: `)
      ).trim();
      if (!a) return fallback;
      const n = Number(a);
      return Number.isInteger(n) && n >= 1 && n <= shown.length ? shown[n - 1]! : a;
    },
  };
}

export const runCommand: Run = (cmd, args, options = {}) =>
  new Promise((done) => {
    const timeout = options.timeoutMs ?? 30_000;
    if (options.interactive) {
      const child = spawn(cmd, args, { cwd: options.cwd, stdio: "inherit" });
      const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
      child.on("error", (error) => {
        clearTimeout(timer);
        done({ code: 127, stdout: "", stderr: error.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done({ code: code ?? 1, stdout: "", stderr: "" });
      });
      return;
    }
    execFile(
      cmd,
      args,
      { cwd: options.cwd, timeout, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error
          ? typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : 1
          : 0;
        done({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/** What the real `ocd setup` runs against. */
export function systemSetupDeps(input: {
  home: string;
  ocdHome: string;
  configPath: string;
  platform: SetupDeps["platform"];
  cliPath: string;
  service: ServiceManager | null;
  locate: (name: string) => string | null;
  loginPath: () => Promise<string | null>;
  prompt: Prompter;
  say: (line: string) => void;
}): SetupDeps {
  return {
    ...input,
    nodeVersion: process.versions.node,
    nodePath: process.execPath,
    cwd: process.cwd(),
    run: runCommand,
    async service() {
      if (!input.service) return null;
      const s = await input.service.status();
      let definition: string | null = null;
      try {
        definition = readFileSync(s.definition, "utf8");
      } catch {
        // not installed
      }
      return { installed: s.installed, loaded: s.loaded, definition };
    },
    async firstBuild(config) {
      const updater = new SelfUpdater({
        installDir: join(input.ocdHome, "install"),
        settings: () => config.selfUpdate,
        repoPath: (name) => {
          const repo = config.repos[name];
          return repo ? normalizeDirectory(repo.path) : null;
        },
        blockers: () => [],
        notify: () => undefined,
        restart: null,
        runningFrom: input.cliPath,
        logger: createLogger({ level: "silent" }),
      });
      try {
        const s = await updater.check();
        return {
          sha: s.current,
          error: s.lastError && s.lastError.sha !== s.current ? s.lastError.message : null,
        };
      } catch (error) {
        return { sha: null, error: error instanceof Error ? error.message : String(error) };
      }
    },
    managerInstructions() {
      return readFileSync(
        join(dirname(input.cliPath), "..", "assets", "manager-AGENTS.md"),
        "utf8",
      );
    },
  };
}
