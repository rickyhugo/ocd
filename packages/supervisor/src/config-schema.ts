import { z } from "zod";

import { SupervisorConfig } from "./config.ts";

export const CONFIG_SCHEMA_URL =
  "https://raw.githubusercontent.com/rickyhugo/ocd/main/schema/ocd.schema.json";

/**
 * JSON Schema for ocd.jsonc, generated from the same Zod schema the daemon
 * validates with, so editors and the daemon cannot disagree.
 */
export function configJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(SupervisorConfig, {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  // Zod refinements are not exported; encode the OpenCode model format explicitly.
  const profiles = (schema["properties"] as Record<string, Record<string, unknown>>)["profiles"]!;
  const entry = profiles["additionalProperties"] as Record<string, unknown>;
  entry["allOf"] = [
    {
      if: { properties: { harness: { const: "opencode" } } },
      // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema keyword, never awaited
      then: {
        properties: {
          model: {
            pattern: "^[^/\\s]+/\\S+$",
            description: "OpenCode models are written provider/model",
          },
        },
      },
    },
  ];
  return {
    ...schema,
    $id: CONFIG_SCHEMA_URL,
    title: "OCD configuration (ocd.jsonc)",
  };
}
