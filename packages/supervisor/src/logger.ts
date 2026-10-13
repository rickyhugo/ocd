import { existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

import { LOG_REDACT_PATHS } from "@ocd/core";
import pino, { type Logger } from "pino";

export type { Logger };

/** Size-based rotation at startup keeps log retention bounded without a background job. */
function rotate(file: string, maxBytes: number, keep: number): void {
  if (!existsSync(file) || statSync(file).size < maxBytes) return;
  for (let i = keep - 1; i >= 1; i -= 1) {
    if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
  }
  renameSync(file, `${file}.1`);
}

export function createLogger(options: {
  logsDir?: string;
  foreground?: boolean;
  level?: string;
  maxBytes?: number;
  keep?: number;
}): Logger {
  const streams: pino.StreamEntry[] = [];
  if (options.logsDir) {
    const file = join(options.logsDir, "supervisor.log");
    rotate(file, options.maxBytes ?? 5_000_000, options.keep ?? 3);
    streams.push({ stream: pino.destination({ dest: file, mkdir: true, sync: true }) });
  }
  if (options.foreground) streams.push({ stream: process.stdout });
  return pino(
    { level: options.level ?? "info", redact: { paths: LOG_REDACT_PATHS, censor: "[REDACTED]" } },
    streams.length > 0 ? pino.multistream(streams) : pino.destination("/dev/null"),
  );
}
