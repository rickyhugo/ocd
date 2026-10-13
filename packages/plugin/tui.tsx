/** @jsxImportSource @opentui/solid */
// OCD's OpenCode TUI plugin (loaded from <plugin dir>/tui; the host compiles
// this Solid JSX). It is the human's view: it reads OCD as the human actor, so
// looking at it never changes which session receives manager updates.
//
// - Sidebar: one line, "▸ OCD  ! 1  ✓ 2  ● 3" (needs you, review, running).
//   Anything waiting on you is always listed; expand for collapsible sections.
//   When nothing is open: "OCD idle" and what finished today. Click a row for
//   actions that fit its state, including accept and clean up.
// - /task: pick an OCD task and send the manager a message about it.
import { OcdClient, resolveOcdPaths, type Attention, type OcdApiError, type Task } from "@ocd/core";
import { Plugin } from "@opencode/plugin/tui";
import { For, Show, createMemo, createSignal } from "solid-js";

import {
  actionsFor,
  buildSidebar,
  type Row,
  type Section,
  type SectionKey,
  type Tone,
} from "./src/sidebar-model.ts";
import { matchTasks } from "./src/task-match.ts";

const POLL_MS = 4000;
const MAX_ROWS = 8;
/** Usable width of a sidebar row; titles get what the glyph and detail leave. */
const ROW_WIDTH = 36;

const GLYPH: Record<Task["state"], string> = {
  queued: "·",
  starting: "●",
  running: "●",
  blocked: "‖",
  ready_for_review: "✓",
  needs_attention: "!",
  failed: "✗",
  interrupted: "■",
  completed: "✓",
  cancelled: "–",
};

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export default Plugin.define({
  id: "ocd.tui",
  setup(ctx) {
    const socketOption = ctx.options["socket"];
    const socketPath = typeof socketOption === "string" ? socketOption : resolveOcdPaths().socket;
    const client = new OcdClient({ socketPath, actor: "human", timeoutMs: 5000 });
    const theme = ctx.theme as unknown as Record<string, unknown>;
    const color = (key: string) => (theme[key] ?? theme["textMuted"]) as never;
    const TONE: Record<Tone, string> = {
      warning: "warning",
      success: "success",
      accent: "primary",
      error: "error",
      muted: "textMuted",
    };
    const tone = (t: Tone) => color(TONE[t]);

    const [tasks, setTasks] = createSignal<Task[]>([]);
    const [finished, setFinished] = createSignal<Task[]>([]);
    const [attention, setAttention] = createSignal<Attention[]>([]);
    const [now, setNow] = createSignal(Date.now());
    const [online, setOnline] = createSignal(true);
    const [hovered, setHovered] = createSignal<string | null>(null);
    // Durable: which sections the human opened or closed survives restarts.
    const [ui, setUi] = ctx.storage.store<{
      expanded: boolean;
      sections: Partial<Record<SectionKey, boolean>>;
    }>("ocd.sidebar", { initial: { expanded: false, sections: {} } });

    const refresh = async () => {
      try {
        const [open, done, items] = await Promise.all([
          client.listTasks({ open: true, limit: 100 }),
          client.listTasks({ state: ["completed", "cancelled"], limit: 20 }),
          client.listAttention({ status: "open", limit: 100 }),
        ]);
        setTasks(open);
        setFinished(done);
        setAttention(items);
        setOnline(true);
      } catch {
        setOnline(false);
      }
      setNow(Date.now());
    };
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);

    const model = createMemo(() => buildSidebar(tasks(), attention(), now(), finished()));
    const toggle = () => void setUi((d) => void (d.expanded = !d.expanded));
    const isOpen = (s: Section) => ui.sections[s.key] ?? s.openByDefault;
    const toggleSection = (s: Section) => void setUi((d) => void (d.sections[s.key] = !isOpen(s)));

    const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
    const toast = (text: string, variant: "success" | "warning" | "error" = "success") =>
      ctx.ui.toast.show({ title: "OCD", message: text, variant });
    const fail = (error: unknown) => toast(message(error), "error");

    /** Sends the manager (the current session) a message about one task. */
    const askAbout = async (task: Task, text?: string) => {
      const route = ctx.ui.router.current();
      if (route.type !== "session") {
        toast("Open the manager session first", "warning");
        return;
      }
      const body =
        text ??
        (await ctx.ui.dialog.prompt({
          title: clip(task.title, 60),
          description: `${task.repo} · ${task.state} · ${task.id}`,
          placeholder: "Message for the manager about this task",
        }));
      if (!body) return;
      await ctx.client.session.prompt({
        sessionID: route.sessionID,
        text: `Regarding OCD task ${task.id} ("${task.title}", repo ${task.repo}, ${task.state}): ${body}`,
      });
    };

    const details = (row: Row) => {
      const task = row.task;
      const item = row.attention;
      return ctx.ui.dialog.alert({
        title: row.title,
        message: [
          item ? `${item.kind}: ${item.reason}` : "",
          item?.kind === "permission"
            ? `Approve or deny from a terminal:\n  ocd attention resolve ${item.id} --approve\n  ocd attention resolve ${item.id} --deny`
            : "",
          task ? `${task.state} · ${task.repo} · ${task.harness} ${task.model}` : "",
          task ? `id ${task.id}${task.branch ? ` · branch ${task.branch}` : ""}` : "",
          task?.workspacePath ? `worktree ${task.workspacePath}` : "",
          task?.pullRequestUrl ? `PR ${task.pullRequestUrl}` : "",
          task?.result?.reported ? `\n${clip(task.result.reported.summary, 600)}` : "",
          task?.error ? `\nError: ${clip(task.error, 400)}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      });
    };

    /** Why OCD refused to remove a worktree, short enough for a toast. */
    const keptReason = (error: unknown, task: Task) => {
      // Duck-typed: the host may load @ocd/core more than once.
      const code = (error as Partial<OcdApiError> | null)?.code;
      const force = `or discard it: ocd task cleanup ${task.id} --force`;
      if (code === "workspace_dirty")
        return `it has uncommitted changes. Open a PR first, ${force}`;
      if (code === "unmerged_commits")
        return `its commits exist on no other branch. Open a PR first, ${force}`;
      return message(error);
    };

    /**
     * Accept and clean up run directly against OCD as the human. Cleanup never
     * forces: OCD keeps a worktree with uncommitted files or commits that exist
     * on no other branch or remote, and says so.
     */
    const runDirect = async (task: Task, kind: "accept" | "accept_clean" | "clean") => {
      if (kind !== "clean") await client.acceptTask(task.id);
      if (kind === "accept") {
        toast(`Accepted “${clip(task.title, 40)}”; worktree kept`);
      } else {
        try {
          await client.cleanupTask(task.id);
          toast(
            kind === "clean"
              ? `Removed the worktree of “${clip(task.title, 40)}”`
              : `Accepted and cleaned up “${clip(task.title, 40)}”`,
          );
        } catch (error) {
          toast(
            `${kind === "clean" ? "Kept" : "Accepted, but kept"} the worktree: ${keptReason(error, task)}`,
            "warning",
          );
        }
      }
      await refresh();
    };

    const rowActions = async (row: Row) => {
      try {
        const actions = actionsFor(row);
        const picked = await ctx.ui.dialog.select<number>({
          title: clip(row.title, 60),
          options: actions.map((a, i) => ({ title: a.label, value: i })),
        });
        const action = picked === undefined || picked === null ? undefined : actions[picked];
        if (!action) return;
        if ("message" in action) {
          if (row.task) await askAbout(row.task, action.message);
        } else if (action.kind === "message") {
          if (row.task) await askAbout(row.task);
        } else if (action.kind === "details") {
          await details(row);
        } else if (row.task) {
          await runDirect(row.task, action.kind);
        }
      } catch (error) {
        fail(error);
      }
    };

    const muted = () => color("textMuted");

    const RowView = (props: { row: Row; indent: string }) => (
      <box
        flexDirection="row"
        backgroundColor={hovered() === props.row.key ? color("backgroundElement") : "transparent"}
        onMouseOver={() => setHovered(props.row.key)}
        onMouseOut={() => setHovered((k) => (k === props.row.key ? null : k))}
        // On release: a dialog opened on press is dismissed by the release landing on its backdrop.
        onMouseUp={() => void rowActions(props.row)}
      >
        <text fg={tone(props.row.tone)}>{`${props.indent}${props.row.glyph} `}</text>
        <box flexGrow={1}>
          <text fg={props.row.tone === "muted" ? muted() : color("text")} wrapMode="none">
            {clip(
              props.row.title,
              Math.max(8, ROW_WIDTH - props.indent.length - 2 - props.row.meta.length - 1),
            )}
          </text>
        </box>
        <text fg={muted()}>{` ${props.row.meta}`}</text>
      </box>
    );

    const removeSidebar = ctx.ui.slot({
      append: "sidebar.content",
      render: () => (
        <box flexDirection="column" paddingTop={1}>
          <Show
            when={online()}
            fallback={
              <box flexDirection="column">
                <box flexDirection="row">
                  <text>
                    <b>OCD</b>
                  </text>
                  <text fg={color("error")}>{"  offline"}</text>
                </box>
                <text fg={muted()}>start it: ocd daemon · ocd restart</text>
              </box>
            }
          >
            <Show
              when={!model().idle}
              fallback={
                // Nothing open: no sections to expand, just what finished lately.
                <box flexDirection="column">
                  <box flexDirection="row">
                    <text>
                      <b>OCD</b>
                    </text>
                    <text fg={muted()}>
                      {model().recent.length
                        ? `  idle · ${model().recent.length} done today`
                        : "  idle"}
                    </text>
                  </box>
                  <For each={model().recent.slice(0, 3)}>
                    {(row) => <RowView row={row} indent="" />}
                  </For>
                </box>
              }
            >
              {/* One line: chevron, name, and a count per kind of open work. */}
              <box flexDirection="row" onMouseDown={() => toggle()}>
                <text fg={muted()}>{ui.expanded ? "▾ " : "▸ "}</text>
                <text>
                  <b>OCD</b>
                </text>
                <For each={model().counts}>
                  {(c) => <text fg={tone(c.tone)}>{`  ${c.glyph} ${c.count}`}</text>}
                </For>
              </box>
              {/* Collapsed: only what waits on the human. */}
              <Show when={!ui.expanded}>
                <For each={model().urgent.slice(0, 3)}>
                  {(row) => <RowView row={row} indent="  " />}
                </For>
              </Show>
              <Show when={ui.expanded}>
                <For each={model().sections}>
                  {(section) => (
                    <box flexDirection="column" marginTop={1}>
                      <box flexDirection="row" onMouseDown={() => toggleSection(section)}>
                        <text fg={muted()}>{isOpen(section) ? "▾ " : "▸ "}</text>
                        <text fg={tone(section.tone)}>{section.label}</text>
                        <text fg={muted()}>{` ${section.rows.length}`}</text>
                      </box>
                      <Show when={isOpen(section)}>
                        <For each={section.rows.slice(0, MAX_ROWS)}>
                          {(row) => <RowView row={row} indent="  " />}
                        </For>
                        <Show when={section.rows.length > MAX_ROWS}>
                          <text fg={muted()}>
                            {`    +${section.rows.length - MAX_ROWS} more · /task`}
                          </text>
                        </Show>
                      </Show>
                    </box>
                  )}
                </For>
              </Show>
            </Show>
          </Show>
        </box>
      ),
    });

    ctx.keymap.layer(() => ({
      // Reachable while typing in the prompt, not only in the base mode.
      mode: "global",
      commands: [
        {
          id: "ocd.task",
          title: "OCD: message the manager about a task",
          group: "OCD",
          palette: true,
          // No arguments: OpenCode only runs argument-taking slash commands when
          // text follows the name, so a bare "/task" would reach the model.
          slash: { name: "task" },
          run: async () => {
            try {
              const all = await client.listTasks({ limit: 100 });
              const task = await ctx.ui.dialog.select<Task>({
                title: "OCD task",
                placeholder: "Search by title, repo or id",
                options: all.map((t) => ({
                  title: `${GLYPH[t.state]} ${t.title}`,
                  description: `${t.repo} · ${t.state}`,
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
              if (task) await askAbout(task);
            } catch (error) {
              fail(error);
            }
          },
        },
        {
          id: "ocd.sidebar.toggle",
          title: "OCD: expand or collapse the sidebar section",
          group: "OCD",
          palette: true,
          run: () => toggle(),
        },
      ],
    }));

    return () => {
      clearInterval(timer);
      removeSidebar();
    };
  },
});
