import { OcdClient, resolveOcdPaths } from "@ocd/core";
import { Plugin } from "@opencode/plugin";

import { BriefingCache } from "./briefing.ts";
import { buildTools, runTool } from "./tools.ts";

export { BriefingCache } from "./briefing.ts";
export { buildTools, runTool, type OcdTool, type ToolCallContext } from "./tools.ts";

/**
 * OCD's OpenCode V2 plugin. A global plugin loads in every session, including
 * workers; the supervisor accepts control calls only from sessions in the
 * manager directory configured in ocd.jsonc. Options: { "socket": "/path/to/ocd.sock" }.
 */
export default Plugin.define({
  id: "ocd",
  async setup(ctx) {
    const socketOption = ctx.options["socket"];
    const socketPath = typeof socketOption === "string" ? socketOption : resolveOcdPaths().socket;
    const clientFor = (sessionId: string, directory: string) =>
      new OcdClient({ socketPath, actor: "manager", sessionId, directory, timeoutMs: 15_000 });
    const tools = buildTools(clientFor);

    const toolRegistration = await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "ocd",
        description:
          "OCD control plane: delegate tasks to workers, handle attention requests, and keep durable memory.",
      });
      for (const tool of tools) {
        editor.add({
          name: tool.name,
          description: tool.description,
          input: tool.input,
          options: { namespace: "ocd" },
          execute: async (input, toolContext) => ({
            content: await runTool(tool, input, {
              sessionID: toolContext.sessionID,
              callID: toolContext.id,
              directory: ctx.location.directory,
            }),
          }),
        });
      }
    });

    const briefing = new BriefingCache(socketPath, ctx.location.directory);
    const hookRegistration = await ctx.session.hook("context", async (event) => {
      const text = await briefing.forSession(event.sessionID);
      if (text) event.system.push({ type: "text", text });
    });

    return async () => {
      await hookRegistration.dispose();
      await toolRegistration.dispose();
    };
  },
});
