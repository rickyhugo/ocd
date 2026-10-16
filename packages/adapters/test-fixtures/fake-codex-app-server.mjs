// Minimal stand-in for `codex app-server` (0.162.1 protocol subset) used by
// adapter tests. Directives in the prompt pick behaviour: [approve-cmd],
// [edit], [limit], [hang], [plan], [usage], [subagent]. Never calls a model.
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

// FAKE_CODEX_PIDFILE: write this process's pid there. FAKE_CODEX_FAIL=<method>:
// answer that request with an error.
if (process.env.FAKE_CODEX_PIDFILE)
  writeFileSync(process.env.FAKE_CODEX_PIDFILE, String(process.pid));

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
let threadId = null;
let nextServerId = 1000;
let turnSeq = 0;
let active = null; // { id, waitingFor, text }
let threadParams = null;
const notify = (method, params) => send({ method, params });
const report = '```ocd-report\n{"summary":"codex did it"}\n```';
// Weekly window usage; [usage] in a turn raises it and sends account/rateLimits/updated.
let usedPercent = Number(process.env.FAKE_CODEX_USED ?? 22);
const snapshot = () => ({
  limitId: "codex",
  limitName: null,
  primary: { usedPercent, windowDurationMins: 10080, resetsAt: 1792477564 },
  secondary: null,
  credits: { hasCredits: true, unlimited: false, balance: null },
  planType: "pro",
  rateLimitReachedType: usedPercent >= 100 ? "rate_limit_reached" : null,
});
// The shape codex 0.162.1 returned on a real account.
const rateLimits = () => ({
  ordinaryUsageAllowed: usedPercent < 100,
  rateLimits: snapshot(),
  rateLimitsByLimitId: { codex: snapshot() },
  rateLimitResetCredits: null,
  accountId: "acct",
  rateLimitUpsell: null,
});

function startTurn(text) {
  const turn = { id: `turn_${++turnSeq}`, text };
  active = turn;
  notify("turn/started", { threadId, turn: { id: turn.id, status: "inProgress", items: [] } });
  if (text.includes("[usage]")) {
    usedPercent = 85;
    // Sparse, as the real one: clients re-read or merge.
    notify("account/rateLimits/updated", { rateLimits: { ...snapshot(), planType: null } });
  }
  if (text.includes("[hang]")) return;
  if (text.includes("[die]")) return void setTimeout(() => process.exit(1), 50);
  if (text.includes("[malformed]")) {
    // Valid JSON of the wrong shape must not take the adapter down.
    send(null);
    send([1]);
    send(7);
    notify("turn/started", { threadId });
    notify("item/started", {});
    notify("item/completed", {});
    notify("item/completed", { item: null });
    notify("turn/completed", { threadId });
    return finish(turn, `Survived.\n${report}`);
  }
  if (text.includes("[commentary]") || text.includes("[items-only]")) {
    const say = (id, text) => ({ type: "agentMessage", id, text, phase: null });
    const items = [say("m_a", "Earlier commentary"), say("m_b", `Final answer\n${report}`)];
    if (text.includes("[commentary]"))
      for (const item of items) notify("item/completed", { threadId, turnId: turn.id, item });
    return complete(turn, "completed", null, items);
  }
  if (text.includes("[params]")) return finish(turn, JSON.stringify(threadParams));
  if (text.includes("[subagent]")) {
    // As codex 0.162.1 with spawn_agent (OCD task t_mv9nrfjt595f76): the
    // child's thread streams over the parent's connection, and its turn ends
    // while the parent's turn goes on.
    const child = `${threadId}-child`;
    const childTurn = { id: "turn_child", status: "inProgress", items: [] };
    notify("turn/started", { threadId: child, turn: childTurn });
    notify("item/completed", {
      threadId: child,
      turnId: childTurn.id,
      item: {
        type: "agentMessage",
        id: "msg_child",
        text: "Second opinion, no report",
        phase: null,
      },
    });
    notify("turn/completed", { threadId: child, turn: { ...childTurn, status: "completed" } });
    return void setTimeout(() => finish(turn, `Reviewed with a second opinion.\n${report}`), 200);
  }
  if (text.includes("[plan]")) {
    notify("turn/plan/updated", {
      threadId,
      turnId: turn.id,
      explanation: "Private-ish narration that OCD leaves out",
      plan: [
        { step: "Inspect the adapter", status: "completed" },
        { step: "Add the handler", status: "inProgress" },
        { step: "Write tests", status: "pending" },
      ],
    });
    return finish(turn, `Planned.\n${report}`);
  }
  if (text.includes("[transcript]")) {
    const item = (method, item, ms) =>
      notify(method, {
        threadId,
        turnId: turn.id,
        item,
        ...(method === "item/started" ? { startedAtMs: ms } : { completedAtMs: ms }),
      });
    const user = {
      type: "userMessage",
      id: "u_1",
      clientId: null,
      content: [{ type: "text", text }],
    };
    item("item/started", user, 1000);
    item("item/completed", user, 1000);
    notify("item/reasoning/textDelta", { threadId, itemId: "r_1", delta: "RAW-DELTA" });
    item(
      "item/completed",
      {
        type: "reasoning",
        id: "r_1",
        summary: ["Checked the failing test"],
        content: ["RAW-REASONING"],
      },
      2000,
    );
    item(
      "item/completed",
      { type: "reasoning", id: "r_2", summary: [], content: ["RAW-ONLY"] },
      2500,
    );
    item(
      "item/completed",
      { type: "agentMessage", id: "m_1", text: "Running the tests", phase: null },
      3000,
    );
    const cmd = {
      type: "commandExecution",
      id: "c_1",
      command: "npm test",
      cwd: "/w",
      status: "inProgress",
      aggregatedOutput: null,
      exitCode: null,
    };
    item("item/started", cmd, 4000);
    notify("item/agentMessage/delta", { threadId, itemId: "m_2", delta: "PARTIAL" });
    item(
      "item/completed",
      { ...cmd, status: "completed", aggregatedOutput: "ok AKIAABCDEFGHIJKLMNOP", exitCode: 0 },
      5000,
    );
    item(
      "item/completed",
      { ...cmd, status: "completed", aggregatedOutput: "ok AKIAABCDEFGHIJKLMNOP", exitCode: 0 },
      5000,
    );
    item(
      "item/completed",
      {
        type: "fileChange",
        id: "f_1",
        changes: [
          { path: "src/a.ts", kind: { type: "update", move_path: null }, diff: "DIFF-BODY" },
        ],
        status: "completed",
      },
      6000,
    );
    item(
      "item/completed",
      {
        type: "mcpToolCall",
        id: "x_1",
        server: "docs",
        tool: "search",
        status: "failed",
        arguments: { q: "x" },
        result: null,
        error: { message: "boom" },
      },
      6500,
    );
    item("item/completed", { type: "contextCompaction", id: "cc_1" }, 6600);
    item("item/completed", { type: "agentMessage" }, 6700);
    return finish(turn, `Tests pass.\n${report}`);
  }
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
  if (process.env.FAKE_CODEX_FAIL === m.method)
    return send({ id: m.id, error: { code: -32000, message: `${m.method} failed` } });
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
    case "account/rateLimits/read":
      return reply(rateLimits());
    case "thread/start":
      threadId = `thr_${process.pid}`;
      threadParams = m.params;
      process.stderr.write(`thread/start ${JSON.stringify(m.params)}\n`);
      return reply({ thread: { id: threadId, status: { type: "idle" }, cwd: m.params.cwd } });
    case "thread/resume":
      threadId = m.params.threadId;
      threadParams = { resumed: true, ...m.params };
      return reply({ thread: { id: threadId, status: { type: "idle" }, cwd: m.params.cwd } });
    case "turn/start": {
      const text = m.params.input.map((i) => i.text).join("\n");
      const id = `turn_${turnSeq + 1}`;
      // [early] finishes the turn before replying, as a fast real turn can.
      if (text.includes("[early]")) {
        startTurn(text);
        return reply({ turn: { id, status: "completed", items: [] } });
      }
      reply({ turn: { id, status: "inProgress", items: [] } });
      return startTurn(text);
    }
    case "turn/steer":
      // As codex 0.162.1: steering a turn that already ended is refused.
      if (!active)
        return send({ id: m.id, error: { code: -32600, message: "no active turn to steer" } });
      return reply({ turnId: active.id });
    case "turn/interrupt": {
      // As codex 0.162.1: acknowledged first, the turn completes just after.
      const turn = active;
      reply({});
      if (turn) setTimeout(() => complete(turn, "interrupted", null), 30);
      return;
    }
    default:
      return send({ id: m.id, error: { code: -32601, message: `unknown ${m.method}` } });
  }
});
