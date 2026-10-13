// Minimal stand-in for `codex app-server` (0.162.1 protocol subset) used by
// adapter tests. Directives in the prompt pick behaviour: [approve-cmd],
// [edit], [limit], [hang]. Never calls a model.
import { createInterface } from "node:readline";

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
let threadId = null;
let nextServerId = 1000;
let turnSeq = 0;
let active = null; // { id, waitingFor, text }
const notify = (method, params) => send({ method, params });
const report = '```ocd-report\n{"summary":"codex did it"}\n```';

function startTurn(text) {
  const turn = { id: `turn_${++turnSeq}`, text };
  active = turn;
  notify("turn/started", { threadId, turn: { id: turn.id, status: "inProgress", items: [] } });
  if (text.includes("[hang]")) return;
  if (text.includes("[limit]")) {
    notify("error", {
      threadId,
      turnId: turn.id,
      willRetry: false,
      error: { message: "Usage limit reached", codexErrorInfo: "usageLimitExceeded" },
    });
    return complete(turn, "failed", {
      message: "Usage limit reached",
      codexErrorInfo: "usageLimitExceeded",
    });
  }
  if (text.includes("[approve-cmd]") || text.includes("[edit]")) {
    const edit = text.includes("[edit]");
    const itemId = `item_${turn.id}`;
    notify("item/started", {
      threadId,
      turnId: turn.id,
      item: edit
        ? {
            type: "fileChange",
            id: itemId,
            changes: [{ path: "src/a.ts", kind: { type: "update" }, diff: "" }],
          }
        : { type: "commandExecution", id: itemId },
    });
    turn.waitingFor = nextServerId++;
    send({
      id: turn.waitingFor,
      method: edit ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval",
      params: edit
        ? { threadId, turnId: turn.id, itemId, reason: "outside workspace" }
        : {
            threadId,
            turnId: turn.id,
            itemId,
            command: "npm publish",
            cwd: process.cwd(),
            reason: "network",
          },
    });
    return;
  }
  finish(turn, `All done.\n${report}`);
}

function finish(turn, text) {
  notify("item/completed", {
    threadId,
    turnId: turn.id,
    item: { type: "agentMessage", id: `msg_${turn.id}`, text, phase: "final_answer" },
  });
  complete(turn, "completed", null, [{ type: "agentMessage", text }]);
}

function complete(turn, status, error, items = []) {
  active = null;
  notify("turn/completed", { threadId, turn: { id: turn.id, status, error, items } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined && m.id !== undefined) {
    // Response to our approval request.
    if (active && m.id === active.waitingFor) {
      const turn = active;
      notify("serverRequest/resolved", { threadId, requestId: m.id });
      finish(
        turn,
        m.result?.decision === "accept" ? `Approved and done.\n${report}` : "Declined; stopping.",
      );
    }
    return;
  }
  const reply = (result) => send({ id: m.id, result });
  switch (m.method) {
    case "initialize":
      return reply({
        userAgent: "fake-codex/0.162.1",
        codexHome: "/tmp",
        platformFamily: "unix",
        platformOs: "macos",
      });
    case "initialized":
      return;
    case "account/read":
      return reply({
        account: process.env.FAKE_CODEX_LOGGED_OUT
          ? null
          : { type: "chatgpt", email: "x@example.com", planType: "pro" },
        requiresOpenaiAuth: true,
      });
    case "thread/start":
      threadId = `thr_${process.pid}`;
      process.stderr.write(`thread/start ${JSON.stringify(m.params)}\n`);
      return reply({ thread: { id: threadId, status: { type: "idle" }, cwd: m.params.cwd } });
    case "thread/resume":
      threadId = m.params.threadId;
      return reply({ thread: { id: threadId, status: { type: "idle" }, cwd: m.params.cwd } });
    case "turn/start":
      reply({ turn: { id: `turn_${turnSeq + 1}`, status: "inProgress", items: [] } });
      return startTurn(m.params.input.map((i) => i.text).join("\n"));
    case "turn/steer":
      return reply({ turnId: active?.id });
    case "turn/interrupt": {
      const turn = active;
      if (turn) complete(turn, "interrupted", null);
      return reply({});
    }
    default:
      return send({ id: m.id, error: { code: -32601, message: `unknown ${m.method}` } });
  }
});
