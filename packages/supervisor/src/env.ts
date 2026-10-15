const BASE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
];

/** Only selected variables reach worker and verification processes; unrelated credentials are not inherited. */
export function filteredEnv(
  allowlist: readonly string[] = [],
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...BASE_ENV_KEYS, ...allowlist]) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
