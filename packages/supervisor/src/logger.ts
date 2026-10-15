import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { LOG_REDACT_PATHS } from "@ocd/core";
import pino, { type Logger } from "pino";

export type { Logger };

/** Size-based rotation keeps log retention bounded without a background job. */
function rotate(file: string, maxBytes: number, keep: number): void {
  if (!existsSync(file) || statSync(file).size < maxBytes) return;
  for (let i = keep - 1; i >= 1; i -= 1) {
    if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
  }
  renameSync(file, `${file}.1`);
}

/**
 * Appends lines with synchronous writes (as `pino.destination({ sync: true })`
 * did, so lines are never lost or interleaved) and rotates once the file is
 * over `maxBytes`: close, rename the files down, reopen. That happens between
 * two writes, so no line spans two files.
 */
class RotatingFile {
  private readonly file: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private fd: number;
  private size: number;

  constructor(file: string, maxBytes: number, keep: number) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.keep = keep;
    mkdirSync(dirname(file), { recursive: true });
    rotate(file, maxBytes, keep);
    this.fd = openSync(file, "a");
    this.size = statSync(file).size;
  }

  write(line: string): void {
    const bytes = Buffer.from(line);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(this.fd, bytes, offset);
    this.size += bytes.length;
    if (this.size >= this.maxBytes) {
      closeSync(this.fd);
      rotate(this.file, this.maxBytes, this.keep);
      this.fd = openSync(this.file, "a");
      this.size = 0;
    }
  }
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
    streams.push({
      stream: new RotatingFile(file, options.maxBytes ?? 5_000_000, options.keep ?? 3),
    });
  }
  if (options.foreground) streams.push({ stream: process.stdout });
  return pino(
    { level: options.level ?? "info", redact: { paths: LOG_REDACT_PATHS, censor: "[REDACTED]" } },
    streams.length > 0 ? pino.multistream(streams) : pino.destination("/dev/null"),
  );
}
