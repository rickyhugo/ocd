// Best-effort secret detection. It guards memory, attention reasons, and logs;
// it is not a substitute for keeping credentials out of worker environments.
const SECRET_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  {
    name: "private key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  },
  { name: "Anthropic key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: "OpenAI-style key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  {
    name: "GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  },
  { name: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  { name: "npm token", pattern: /\bnpm_[A-Za-z0-9]{30,}/g },
  { name: "Google API key", pattern: /\bAIza[A-Za-z0-9_-]{30,}/g },
  { name: "Stripe key", pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  {
    name: "basic auth",
    pattern: /\bauthori[sz]ation\b["']?\s*[:=]\s*["']?Basic\s+[A-Za-z0-9+/]{8,}={0,2}/gi,
  },
  { name: "URL credentials", pattern: /(?<=:\/\/)[^\s/:@]+:[^\s/@]+(?=@)/g },
  {
    name: "secret flag",
    pattern:
      /--(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|auth[_-]?token)\s+["']?[^\s"'-][^\s"']{5,}/gi,
  },
  {
    // The key may carry a prefix (GITHUB_TOKEN, MY_API_KEY, AWS_SECRET_ACCESS_KEY)
    // and be quoted (JSON), but must end with the secret word ("max_tokens" is not one).
    name: "credential assignment",
    pattern:
      /(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?(?!\[REDACTED\])[^\s"']{6,}/gi,
  },
];

export function findSecrets(text: string): string[] {
  const found = new Set<string>();
  for (const { name, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) found.add(name);
  }
  return [...found];
}

export function redact(text: string): string {
  let out = text;
  for (const { pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

/** Pino redaction paths for structured log fields. */
export const LOG_REDACT_PATHS = [
  "password",
  "*.password",
  "token",
  "*.token",
  "authorization",
  "*.authorization",
  "headers.authorization",
  "req.headers.authorization",
  "apiKey",
  "*.apiKey",
  "env",
  "*.env",
];

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/* oxlint-disable no-control-regex -- these patterns exist to remove control characters */
// Terminal escape sequences (CSI, OSC, and two-byte escapes).
const ESCAPE_SEQUENCES =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-_])/g;
// Zero-width and bidirectional formatting characters that can disguise text.
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
// C0 and C1 controls other than tab and line breaks, which are handled per line.
const CONTROLS = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g;
/* oxlint-enable no-control-regex */

/**
 * Text that is safe to show outside a terminal-aware viewer: no escape
 * sequences, control or invisible formatting characters, collapsed whitespace,
 * no blank lines. Lines are joined with spaces unless `multiline` is set.
 */
export function plainText(text: string, options: { multiline?: boolean } = {}): string {
  const lines = text
    .replace(ESCAPE_SEQUENCES, "")
    .replace(INVISIBLE, "")
    .replace(CONTROLS, "")
    .split(/\r\n|[\n\r\v\f\u2028\u2029]/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return lines.join(options.multiline ? "\n" : " ");
}

const CLIP_MARK = "\n…[clipped]…\n";

/** Keeps the start and the end (where command output ends) of a long text. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = Math.max(0, max - CLIP_MARK.length);
  const head = Math.ceil(room * 0.6);
  return `${text.slice(0, head)}${CLIP_MARK}${text.slice(text.length - (room - head))}`;
}

/**
 * Redacts and bounds untrusted text for display. Long input is clipped
 * generously first (bounding regex work), then redacted, then clipped to
 * `max`, so a clip boundary never exposes part of a secret that redaction
 * would have caught in the whole text.
 */
export function sanitizeText(text: string, max: number): { text: string; truncated: boolean } {
  const redacted = redact(clip(text, max * 4));
  return { text: clip(redacted, max), truncated: text.length > max * 4 || redacted.length > max };
}

const SECRET_KEY =
  /pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|authori[sz]ation|cookie/i;

/** JSON-renders a structured value, dropping values stored under secret-looking keys. */
export function sanitizeValue(value: unknown, max: number): { text: string; truncated: boolean } {
  if (typeof value === "string") return sanitizeText(value, max);
  let json: string;
  try {
    json =
      JSON.stringify(value, (key, v: unknown) =>
        key && SECRET_KEY.test(key) && v !== null && typeof v !== "object" ? "[REDACTED]" : v,
      ) ?? "";
  } catch {
    json = String(value);
  }
  return sanitizeText(json, max);
}
