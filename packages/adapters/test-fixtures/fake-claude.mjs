// Minimal stand-in for `claude -p --input-format stream-json ...` (2.1.296
// protocol subset) used by adapter tests. Directives in the prompt pick
// behaviour: [perm], [limit], [hang]. Never calls a model.
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("2.1.296 (Claude Code)");
  process.exit(0);
}
if (args[0] === "auth") {
  console.log(JSON.stringify({ loggedIn: !process.env.FAKE_CLAUDE_LOGGED_OUT }));
  process.exit(process.env.FAKE_CLAUDE_LOGGED_OUT ? 1 : 0);
}
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (!args.includes("--verbose")) {
  process.stderr.write(
    "Error: When using --print, --output-format=stream-json requires --verbose\n",
  );
  process.exit(1);
}
const sessionId = flag("--session-id") ?? flag("--resume");
process.stderr.write(`args ${JSON.stringify(args)}\n`);
const send = (m) => process.stdout.write(`${JSON.stringify({ session_id: sessionId, ...m })}\n`);
const report = '```ocd-report\n{"summary":"claude did it"}\n```';
let waiting = null;
let hanging = false;

function result(text, extra = {}) {
  hanging = false;
  send({ type: "result", subtype: "success", is_error: false, result: text, ...extra });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.type === "control_response" && waiting && m.response.request_id === waiting) {
    waiting = null;
    const r = m.response.response;
    return result(
      r.behavior === "allow" ? `Ran ${r.updatedInput.command}.\n${report}` : `Denied: ${r.message}`,
    );
  }
  if (m.type === "control_request" && m.request.subtype === "interrupt") {
    send({
      type: "control_response",
      response: { subtype: "success", request_id: m.request_id, response: {} },
    });
    if (hanging || waiting) {
      if (waiting) send({ type: "control_cancel_request", request_id: waiting });
      waiting = null;
      hanging = false;
      send({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["aborted"],
        terminal_reason: "aborted_streaming",
      });
    }
    return;
  }
  if (m.type !== "user") return;
  const text = m.message.content.map((c) => c.text).join("\n");
  send({
    type: "system",
    subtype: "init",
    model: flag("--model"),
    permissionMode: flag("--permission-mode"),
  });
  send({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } });
  if (text.includes("[args]")) return result(`args: ${args.join(" ")}`);
  if (text.includes("[hang]")) {
    hanging = true;
    return;
  }
  if (text.includes("[limit]")) {
    send({
      type: "assistant",
      error: "rate_limit",
      message: { content: [{ type: "text", text: "You've hit your usage limit · resets 5pm" }] },
    });
    return send({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "You've hit your usage limit · resets 5pm",
      api_error_status: 429,
    });
  }
  if (text.includes("[perm]")) {
    waiting = `req-${Date.now()}`;
    return send({
      type: "control_request",
      request_id: waiting,
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "npm publish" },
        tool_use_id: "toolu_1",
        decision_reason: "rule",
      },
    });
  }
  result(`Done (effort ${flag("--effort") ?? "default"}).\n${report}`);
});
