/** @jsxImportSource @opentui/solid */
// OCD's OpenCode TUI plugin (loaded from <plugin dir>/tui; the host compiles
// this Solid JSX). It is the human's view: it reads OCD as the human actor, so
// looking at the sidebar never changes which session receives manager updates.
//
// - Sidebar: live overview of ongoing work.
// - /task: pick an OCD task (fuzzy search) and talk to the manager about it.
import {
  OcdClient,
  resolveOcdPaths,
  type Attention,
  type SupervisorStatus,
  type Task,
} from "@ocd/core";
import { Plugin } from "@opencode/plugin/tui";

import { matchTasks } from "./src/task-match.ts";
import { For, Show, createSignal } from "solid-js";

const POLL_MS = 4000;
const MAX_ROWS = 12;

const GLYPH: Record<Task["state"], string> = {
  queued: "·",
  starting: "▶",
  running: "▶",
  blocked: "⏸",
  ready_for_review: "✓",
  needs_attention: "!",
  failed: "✗",
  interrupted: "⏹",
  completed: "✓",
  cancelled: "–",
};

const LABEL: Partial<Record<Task["state"], string>> = {
  ready_for_review: "review",
  needs_attention: "attention",
};

interface Overview {
  status: SupervisorStatus | null;
  tasks: Task[];
  attention: Attention[];
  error: string | null;
}

function short(id: string): string {
  return id.slice(-6);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function summary(o: Overview): string {
  const counts = o.status?.counts ?? {};
  const live = (counts.running ?? 0) + (counts.starting ?? 0) + (counts.blocked ?? 0);
  const parts = [`${live} running`];
  if (counts.queued) parts.push(`${counts.queued} queued`);
  if (counts.ready_for_review) parts.push(`${counts.ready_for_review} review`);
  if (o.status?.paused) parts.push("paused");
  return parts.join(" · ");
}

export default Plugin.define({
  id: "ocd.tui",
  setup(ctx) {
    const socketOption = ctx.options["socket"];
    const socketPath = typeof socketOption === "string" ? socketOption : resolveOcdPaths().socket;
    const client = new OcdClient({ socketPath, actor: "human", timeoutMs: 5000 });
    const theme = ctx.theme as unknown as Record<string, unknown>;
    const muted = theme["textMuted"];
    const accent = theme["primary"];
    const warning = theme["warning"];

    const [overview, setOverview] = createSignal<Overview>({
      status: null,
      tasks: [],
      attention: [],
      error: null,
    });

    const refresh = async () => {
      try {
        const [status, tasks, attention] = await Promise.all([
          client.status(),
          client.listTasks({ open: true, limit: 50 }),
          client.listAttention({ status: "open", limit: 50 }),
        ]);
        setOverview({ status, tasks, attention, error: null });
      } catch (error) {
        setOverview((o) => ({
          ...o,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);

    const removeSidebar = ctx.ui.slot({
      append: "sidebar.content",
      render: () => (
        <box flexDirection="column" paddingTop={1}>
          <text>
            <b>OCD</b>
          </text>
          <Show
            when={!overview().error}
            fallback={<text fg={muted as never}>supervisor not running</text>}
          >
            <text fg={muted as never}>{summary(overview())}</text>
            <Show when={overview().attention.some((a) => a.resolvableBy === "human")}>
              <text fg={warning as never}>
                {`! ${overview().attention.filter((a) => a.resolvableBy === "human").length} need you (ocd attention list)`}
              </text>
            </Show>
            <For each={overview().tasks.slice(0, MAX_ROWS)}>
              {(task) => (
                <box flexDirection="row">
                  <text
                    fg={(task.state === "running" ? accent : muted) as never}
                  >{`${GLYPH[task.state]} `}</text>
                  <text>{`${clip(task.title, 26)} `}</text>
                  <text fg={muted as never}>
                    {`${task.repo} ${short(task.id)}${LABEL[task.state] ? ` ${LABEL[task.state]}` : ""}`}
                  </text>
                </box>
              )}
            </For>
            <Show when={overview().tasks.length > MAX_ROWS}>
              <text
                fg={muted as never}
              >{`… ${overview().tasks.length - MAX_ROWS} more (/task to search)`}</text>
            </Show>
          </Show>
        </box>
      ),
    });

    /** Picks a task: direct match from the typed query, else a searchable list. */
    const pickTask = async (query: string): Promise<Task | undefined> => {
      const all = await client.listTasks({ limit: 100 });
      const matches = query ? matchTasks(all, query) : [];
      if (matches.length === 1) return matches[0];
      return ctx.ui.dialog.select<Task>({
        title: "OCD task",
        placeholder: "Search by title, repo or id",
        options: (matches.length > 0 ? matches : all).map((t) => ({
          title: `${GLYPH[t.state]} ${t.title}`,
          description: `${t.repo} · ${t.state} · ${t.id}`,
          value: t,
        })),
        search: (q, options) => {
          const hits = new Set(
            matchTasks(
              options.map((o) => o.value),
              q,
            ).map((t) => t.id),
          );
          return options.filter((o) => hits.has(o.value.id));
        },
      });
    };

    ctx.keymap.layer(() => ({
      commands: [
        {
          id: "ocd.task.reference",
          title: "OCD: talk about a task",
          description: "Pick an OCD task and send the manager a message about it",
          group: "OCD",
          palette: true,
          slash: { name: "task", arguments: true },
          run: async (input) => {
            const route = ctx.ui.router.current();
            if (route.type !== "session") {
              ctx.ui.toast.show({ message: "Open the manager session first", variant: "warning" });
              return;
            }
            const raw = (input ?? "").trim();
            // "/task <id or words> -- <message>" or "/task <id> <message>"
            const [head, ...rest] = raw.includes(" -- ")
              ? raw.split(" -- ")
              : [raw.split(/\s+/)[0] ?? "", raw.split(/\s+/).slice(1).join(" ")];
            const task = await pickTask(head ?? "");
            if (!task) return;
            const message =
              (rest.join(" -- ").trim() || undefined) ??
              (await ctx.ui.dialog.prompt({
                title: `About: ${clip(task.title, 50)}`,
                description: `${task.repo} · ${task.state} · ${task.id}`,
                placeholder: "What should the manager do?",
              }));
            if (!message) return;
            await ctx.client.session.prompt({
              sessionID: route.sessionID,
              text: `Regarding OCD task ${task.id} ("${task.title}", repo ${task.repo}, ${task.state}): ${message}`,
            });
          },
        },
      ],
    }));

    return () => {
      clearInterval(timer);
      removeSidebar();
    };
  },
});
