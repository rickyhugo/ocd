import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Slug } from "@ocd/core";
import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  type ParseError,
} from "jsonc-parser";

// `ocd repo add|remove` edit ocd.jsonc in place: the file stays the source of
// truth (comments and formatting are kept) and the supervisor hot-reloads it.

const FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2 } };

function readConfig(path: string): { text: string; json: Record<string, unknown> } {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "{}\n";
  const errors: ParseError[] = [];
  const json = (parse(text, errors, { allowTrailingComma: true }) ?? {}) as Record<string, unknown>;
  if (errors.length) throw new Error(`${path} has syntax errors; fix them before editing it here`);
  return { text, json };
}

/** Writes through a symlink (ocd.jsonc usually links into a git repo) atomically. */
function writeConfig(path: string, text: string): void {
  const target = existsSync(path) ? realpathSync(path) : path;
  const temp = join(dirname(target), `.${Date.now()}.ocd.jsonc.tmp`);
  writeFileSync(temp, text, { mode: existsSync(target) ? statSync(target).mode & 0o777 : 0o600 });
  renameSync(temp, target);
}

/** `~/x` for paths under the home directory, so the config stays portable. */
function portable(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function addRepo(
  configPath: string,
  name: string,
  rawPath: string,
  profile: string | undefined,
): { path: string } {
  if (!Slug.safeParse(name).success)
    throw new Error(`"${name}" is not a valid repo name (lowercase letters, digits, - and _)`);
  const expanded = rawPath.startsWith("~/") ? join(homedir(), rawPath.slice(2)) : rawPath;
  const absolute = resolve(expanded);
  if (!existsSync(absolute)) throw new Error(`${absolute} does not exist`);
  let top: string;
  try {
    top = execFileSync("git", ["-C", absolute, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(`${absolute} is not a git repository`);
  }
  const { text, json } = readConfig(configPath);
  const repos = (json["repos"] ?? {}) as Record<string, unknown>;
  if (Object.hasOwn(repos, name))
    throw new Error(`repo "${name}" is already declared in ${configPath}`);
  const profiles = (json["profiles"] ?? {}) as Record<string, unknown>;
  if (profile && !Object.hasOwn(profiles, profile))
    throw new Error(
      `no profile "${profile}" in ${configPath} (have: ${Object.keys(profiles).join(", ") || "none"})`,
    );
  const entry = { path: portable(top), ...(profile ? { profile } : {}) };
  writeConfig(configPath, insertEntry(text, name, entry));
  return { path: top };
}

/**
 * Adds `"name": { … }` on its own line after the last repo, in the same
 * indentation, leaving every other byte of the file as it was.
 */
function insertEntry(text: string, name: string, entry: Record<string, string>): string {
  const repos = findNodeAtLocation(parseTree(text, [], { allowTrailingComma: true })!, ["repos"]);
  const last = repos?.children?.at(-1);
  if (!repos || repos.type !== "object" || !last) {
    return applyEdits(text, modify(text, ["repos", name], entry, FORMAT));
  }
  const lineStart = text.lastIndexOf("\n", last.offset) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart))![0];
  const value = `{ ${Object.entries(entry)
    .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(", ")} }`;
  const at = last.offset + last.length;
  return `${text.slice(0, at)},\n${indent}${JSON.stringify(name)}: ${value}${text.slice(at)}`;
}

export function removeRepo(configPath: string, name: string): void {
  const { text, json } = readConfig(configPath);
  if (!Object.hasOwn((json["repos"] ?? {}) as Record<string, unknown>, name))
    throw new Error(`no repo "${name}" in ${configPath}`);
  // No formatting options: only the entry (and its comma) is removed.
  writeConfig(configPath, applyEdits(text, modify(text, ["repos", name], undefined, {})));
}
