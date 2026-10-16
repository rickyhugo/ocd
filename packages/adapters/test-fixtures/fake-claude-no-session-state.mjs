// fake-claude.mjs as a Claude Code build that ignores
// CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: it never reports session_state_changed.
delete process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS;
await import("./fake-claude.mjs");
