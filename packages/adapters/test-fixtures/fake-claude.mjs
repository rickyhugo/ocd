// Minimal stand-in for `claude -p --input-format stream-json ...` (2.1.296
// protocol subset) used by adapter tests. Directives in the prompt pick
// behaviour: [perm], [limit], [hang], [todos], [usage], [subagent-wakeup],
// [mapping], [queued], [bg-perm], [report-early], [no-report]. Never calls a
// model.
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
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
/** A background subagent's permission request: { id, answered(behavior) }. */
let subagentAsk = null;
let hanging = false;
// [queue] / [fold]: a turn held open until the next message arrives, which
// Claude Code then either runs as a turn of its own after this one ([queue],
// e.g. sent during text generation) or folds into this turn ([fold], e.g.
// sent while a tool runs). Recorded from 2.1.299.
let held = null;

function result(text, extra = {}) {
  hanging = false;
  send({ type: "result", subtype: "success", is_error: false, result: text, ...extra });
}

// Background work as Claude Code 2.1.300 streams it (OCD tasks t_mv9kega7a68bcf
// and t_mv9m80r6e1495a): a subagent started with run_in_background and a
// ScheduleWakeup outlive the turn, and Claude Code itself runs a new turn for
// each subagent's completion notice.
let toolSeq = 0;
const say = (text) => send({ type: "assistant", message: { content: [{ type: "text", text }] } });
function callTool(name, input, output, whileRunning = () => {}) {
  const id = `toolu_${name}_${++toolSeq}`;
  send({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
  whileRunning(id);
  send({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
    tool_use_result: output,
  });
}
function launchSubagent(taskId) {
  callTool(
    "Agent",
    { description: taskId, run_in_background: true },
    { status: "async_launched", isAsync: true, agentId: taskId },
    (id) =>
      send({
        type: "system",
        subtype: "task_started",
        task_id: taskId,
        tool_use_id: id,
        description: taskId,
        task_type: "local_agent",
        is_backgrounded: true,
      }),
  );
}
function scheduleWakeup() {
  callTool(
    "ScheduleWakeup",
    { delaySeconds: 1200, prompt: "check on the subagent" },
    { scheduledFor: Date.now() + 1_200_000, clampedDelaySeconds: 1200, wasClamped: false },
  );
}
function stopWakeups() {
  callTool(
    "ScheduleWakeup",
    { stop: true },
    {
      scheduledFor: 0,
      clampedDelaySeconds: 0,
      wasClamped: false,
      stopped: true,
      cancelledWakeups: 1,
    },
  );
}
function subagentFinished(taskId) {
  send({
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    status: "completed",
    output_file: "",
    summary: `Agent "${taskId}" finished`,
  });
}
/** The turn Claude Code starts by itself for a subagent's completion notice. */
function notificationTurn(taskId, work) {
  send({
    type: "user",
    origin: { kind: "task-notification" },
    message: { role: "user", content: `<task-notification>${taskId}</task-notification>` },
  });
  work();
}
/** Holds background work until the test drops `.ocd-release` into the worker's directory. */
function onRelease(fn) {
  const timer = setInterval(() => {
    if (!existsSync(".ocd-release")) return;
    clearInterval(timer);
    unlinkSync(".ocd-release");
    fn();
  }, 20);
}
const finalText = (prompt, text) => (prompt.includes("[no-report]") ? text : `${text}\n${report}`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.type === "control_response" && subagentAsk && m.response.request_id === subagentAsk.id) {
    const { answered } = subagentAsk;
    subagentAsk = null;
    return answered(m.response.response.behavior);
  }
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
  // Like Claude Code with --replay-user-messages: echo the message as it is consumed.
  const consume = () =>
    args.includes("--replay-user-messages") &&
    send({ type: "user", isReplay: true, message: m.message, parent_tool_use_id: null });
  const text = m.message.content.map((c) => c.text).join("\n");
  if (held === "queue") {
    held = null;
    result("first turn done");
  } else if (held === "fold") {
    held = null;
    consume();
    return result(`folded: ${text}\n${report}`);
  }
  consume();
  if (text.includes("[queue]") || text.includes("[fold]")) {
    held = text.includes("[queue]") ? "queue" : "fold";
    return send({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } });
  }
  send({
    type: "system",
    subtype: "init",
    model: flag("--model"),
    permissionMode: flag("--permission-mode"),
  });
  send({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } });
  if (text.includes("[args]")) return result(`args: ${args.join(" ")}`);
  if (text.includes("[subagent-wakeup]")) {
    writeFileSync("server.txt", "ported\n");
    launchSubagent("scripts");
    scheduleWakeup();
    const status = "Status: the server is ported. One scripts subagent is still working.";
    say(status);
    result(status);
    return onRelease(() => {
      subagentFinished("scripts");
      notificationTurn("scripts", () => {
        writeFileSync("scripts.txt", "ported\n");
        stopWakeups();
        const done = finalText(text, "The scripts are ported too.");
        say(done);
        result(done);
      });
    });
  }
  if (text.includes("[mapping]")) {
    launchSubagent("api-map");
    launchSubagent("agent-map");
    const first =
      "Instant-chat side is mapped. Still waiting on the api/ and agent/ mapping agents before I write the plan.";
    say(first);
    result(first);
    setTimeout(() => {
      subagentFinished("api-map");
      notificationTurn("api-map", () => {
        say("The api/ map is in. Waiting on the agent/ map.");
        result("The api/ map is in. Waiting on the agent/ map.");
      });
    }, 100);
    return void setTimeout(() => {
      subagentFinished("agent-map");
      notificationTurn("agent-map", () => {
        const done = finalText(text, "Both maps are in. Here is the plan.");
        say(done);
        result(done);
      });
    }, 250);
  }
  if (text.includes("[report-early]")) {
    // The worker reports while a background shell it started still runs.
    launchSubagent("dev-server");
    return result(`Done; the dev server is still up.\n${report}`);
  }
  if (text.includes("[queued]")) {
    // The subagent finishes while the turn is still running: its notice is
    // queued as the next turn, and the result says so.
    launchSubagent("quick");
    subagentFinished("quick");
    result("Launched a quick check.", { queued_turn_count: 1 });
    return notificationTurn("quick", () => result(`The check passed.\n${report}`));
  }
  if (text.includes("[bg-perm]")) {
    // A background subagent asks for a permission and is still waiting for the
    // answer when the worker's own turn ends.
    launchSubagent("tests");
    subagentAsk = {
      id: "req-subagent",
      answered: (behavior) => {
        subagentFinished("tests");
        notificationTurn("tests", () => result(`Tests ran (${behavior}).\n${report}`));
      },
    };
    send({
      type: "control_request",
      request_id: subagentAsk.id,
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "npm test" },
        tool_use_id: "toolu_sub_1",
      },
    });
    return result("Waiting on the test subagent.");
  }
  if (text.includes("[transcript]")) {
    // Claude Code emits one assistant message per content block, sharing message.id.
    const block = (uuid, content) =>
      send({ type: "assistant", uuid, message: { id: "msg_1", role: "assistant", content } });
    block("u1", [{ type: "thinking", thinking: "PRIVATE-THOUGHT", signature: "sig" }]);
    block("u2", [{ type: "text", text: "Let me run the tests" }]);
    const call = [
      {
        type: "tool_use",
        id: "toolu_9",
        name: "Bash",
        input: { command: "TOKEN=abcdef123456 npm test" },
      },
    ];
    block("u3", call);
    block("u3", call); // delivered twice
    send({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { text: "PARTIAL" } },
    });
    send({
      type: "user",
      uuid: "u4",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_9",
            content: [{ type: "text", text: "3 passed ghp_abcdefghijklmnopqrstuvwxyz0123" }],
            is_error: false,
          },
        ],
      },
    });
    block("u5", "not-an-array");
    block("u6", [null, { type: 5 }, { type: "redacted_thinking", data: "ENCRYPTED" }]);
    block("u7", [{ type: "text", text: "All tests pass" }]);
    return result(`All tests pass\n${report}`);
  }
  if (text.includes("[usage]")) {
    // As Claude Code 2.1.299 sends with every turn (utilization is a fraction).
    send({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        resetsAt: 1792003800,
        rateLimitType: "five_hour",
        overageStatus: "rejected",
        isUsingOverage: false,
        unifiedWindows: {
          five_hour: { utilization: 0.83, resetsAt: 1792003800 },
          seven_day: { utilization: 0.63, resetsAt: 1792267200 },
        },
      },
      uuid: "rl-1",
      session_id: "",
    });
    return result(`Used some.\n${report}`);
  }
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
  if (text.includes("[todos]")) {
    // The task tools of 2.1.296: a call, then its result with `tool_use_result`.
    const call = (id, name, input, output, extra = {}) => {
      send({
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id, name, input }] },
        ...extra,
      });
      send({
        type: "user",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
        tool_use_result: output,
        ...extra,
      });
    };
    call(
      "tu_1",
      "TaskCreate",
      { subject: "Read the code", description: "d" },
      {
        task: { id: "1", subject: "Read the code" },
      },
    );
    call(
      "tu_2",
      "TaskCreate",
      { subject: "Fix the bug", description: "d" },
      {
        task: { id: "2", subject: "Fix the bug" },
      },
    );
    call(
      "tu_3",
      "TaskUpdate",
      { taskId: "1", status: "completed" },
      { success: true, taskId: "1" },
    );
    // A subagent's own task list is not the worker's checklist.
    call(
      "tu_4",
      "TaskCreate",
      { subject: "Subagent step", description: "d" },
      {
        task: { id: "9", subject: "Subagent step" },
      },
      { parent_tool_use_id: "toolu_agent" },
    );
    call(
      "tu_5",
      "TaskUpdate",
      { taskId: "2", status: "in_progress" },
      { success: true, taskId: "2" },
    );
    return result(`Working on it.\n${report}`);
  }
  if (text.includes("[perm-die]")) {
    send({
      type: "control_request",
      request_id: "req-die",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "x" } },
    });
    return void setTimeout(() => process.exit(1), 100);
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
