/** @jsxImportSource @opentui/solid */
// OCD's OpenCode TUI plugin (loaded from <plugin dir>/tui; the host compiles
// this Solid JSX). It is the human's view: it reads OCD as the human actor, so
// looking at it never changes which session receives manager updates.
//
// - Sidebar: one line, "▸ OCD  ! 1  ✓ 2  ● 3" (needs you, review, running).
//   Anything waiting on you is always listed; expand for collapsible sections.
//   When nothing is open: "OCD idle" and what finished today. Click a row for
//   actions that fit its state, including accept and clean up. A running row's
//   chevron expands a small scrollable panel: the worker's checklist, recent
//   milestones and a recorded PR (read-only).
// - Manual mode: /takeover (or a row action) stops OCD driving a worker and
//   opens its session in a tmux window; /giveback hands it back to the manager.
// - /task: pick an OCD task and send the manager a message about it.
// - /spill: a read-only snapshot of all open work, straight from the supervisor.
import {
  OcdClient,
  TAKEOVER_STATES,
  buildSpill,
  collectSpill,
  describeLandResult,
  formatLandPlan,
  formatSpill,
  resolveOcdPaths,
  type Attention,
  type LandPlan,
  type LandResult,
  type OcdApiError,
  type TakeOverResult,
  type Task,
} from "@ocd/core";
import { Plugin } from "@opencode/plugin/tui";
import { For, Index, Show, createMemo, createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";

import {
  canExpand,
  panelHeight,
  panelScrolls,
  progressLines,
  progressTargets,
  pruneExpanded,
  toggleExpanded,
  type ProgressState,
} from "./src/progress-model.ts";
import {
  actionsFor,
  buildSidebar,
  landable,
  landingActions,
  type Row,
  type Section,
  type SectionKey,
  type SidebarModel,
  type Tone,
} from "./src/sidebar-model.ts";
import { openSessionWindow, shellLine } from "./src/session-window.ts";
import { matchTasks } from "./src/task-match.ts";

const POLL_MS = 4000;
const MAX_ROWS = 8;
/** Entries per /spill section; `ocd spill` in a terminal lists every one. */
const SPILL_ROWS = 8;
/** Usable width of a sidebar row; titles get what the glyph and detail leave. */
const ROW_WIDTH = 36;
/** Progress panel lines start under the row's title. */
const PANEL_INDENT = 4;

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
  manual: "◆",
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
      info: "info",
    };
    const tone = (t: Tone) => color(TONE[t]);

    const [now, setNow] = createSignal(Date.now());
    // Reconciled by key, so rows (and an open panel's scroll position) survive refreshes.
    const [model, setModel] = createStore<SidebarModel>(buildSidebar([], [], now()));
    const [online, setOnline] = createSignal(true);
    const [hovered, setHovered] = createSignal<string | null>(null);
    // Session-only: which running tasks show their progress panel.
    const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
    const [progress, setProgress] = createSignal<Record<string, ProgressState>>({});
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
        setNow(Date.now());
        setModel(reconcile(buildSidebar(open, items, now(), done), { key: "key" }));
        setExpanded((e) =>
          pruneExpanded(
            e,
            open.map((t) => t.id),
          ),
        );
        setOnline(true);
      } catch {
        setOnline(false);
        setNow(Date.now());
        return;
      }
      await refreshProgress();
    };

    const toggle = () => void setUi((d) => void (d.expanded = !d.expanded));
    const isOpen = (s: Section) => ui.sections[s.key] ?? s.openByDefault;
    const toggleSection = (s: Section) => void setUi((d) => void (d.sections[s.key] = !isOpen(s)));

    /** Running rows on screen; only their open panels are fetched. */
    const visibleRunning = (): Row[] => {
      const section = model.sections.find((s) => s.key === "running");
      return ui.expanded && section && isOpen(section) ? section.rows.slice(0, MAX_ROWS) : [];
    };
    /** One read-only request per open, visible panel; a failed one keeps what it showed. */
    const refreshProgress = async (ids = progressTargets(expanded(), visibleRunning())) => {
      const fetched = await Promise.all(
        ids.map(async (id): Promise<[string, ProgressState | null]> => [
          id,
          await client.taskProgress(id).catch(() => null),
        ]),
      );
      const keep = new Set(progressTargets(expanded(), visibleRunning()));
      setProgress((old) => {
        const next: Record<string, ProgressState> = {};
        for (const id of keep) if (old[id]) next[id] = old[id];
        for (const [id, p] of fetched) if (keep.has(id)) next[id] = p ?? next[id] ?? "unavailable";
        return next;
      });
    };
    const toggleProgress = (id: string) => {
      setExpanded((e) => toggleExpanded(e, id));
      if (expanded().has(id)) void refreshProgress([id]);
    };

    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);

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
          item?.kind === "land" ? formatLandPlan(item.operation as LandPlan) : "",
          item?.kind === "permission" || item?.kind === "land"
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
    const keptReason = (error: unknown) => {
      // Duck-typed: the host may load @ocd/core more than once.
      const code = (error as Partial<OcdApiError> | null)?.code;
      if (code === "workspace_dirty")
        return "it has uncommitted changes. Commit and land them, or discard the work";
      if (code === "unmerged_commits")
        return "its commits are not in the base branch yet. Land them, or discard the work";
      return message(error);
    };

    /**
     * Accept and clean up run directly against OCD as the human. Cleanup never
     * forces: OCD keeps a worktree whose work is not in the base branch yet,
     * and says so.
     */
    const runDirect = async (task: Task, kind: "accept" | "clean") => {
      if (kind === "accept") {
        await client.acceptTask(task.id);
        toast(`Accepted “${clip(task.title, 40)}”; worktree kept`);
      } else {
        try {
          await client.cleanupTask(task.id);
          toast(`Removed the worktree of “${clip(task.title, 40)}”`);
        } catch (error) {
          toast(`Kept the worktree: ${keptReason(error)}`, "warning");
        }
      }
      await refresh();
    };

    /** Whether the supervisor has pull requests on; asked when a menu opens, never cached. */
    const pullRequestsOn = async () => (await client.status()).pullRequests ?? false;

    const landed = (task: Task, r: LandResult) =>
      toast(
        `“${clip(task.title, 40)}”: ${describeLandResult(r)}`,
        r.landed ? "success" : "warning",
      );

    /** Through a pull request: each run goes as far as GitHub allows. */
    const land = async (task: Task) => {
      landed(task, await client.landTask(task.id));
      await refresh();
    };

    /** A push straight to the base branch, only after the human confirms this exact plan. */
    const confirmPush = (plan: LandPlan) =>
      ctx.ui.dialog.confirm({
        title: `Push to ${plan.remote}/${plan.base}?`,
        message: formatLandPlan(plan),
        label: { confirm: "Push" },
      });

    const landDirect = async (task: Task) => {
      const plan = await client.landPlan(task.id);
      if (plan.blocker) return toast(plan.blocker.message, "warning");
      if (!(await confirmPush(plan))) return;
      landed(task, await client.landTask(task.id, { direct: true, confirm: plan.head }));
      await refresh();
    };

    /** The manager asked to push directly; the human confirms or declines. */
    const answerPush = async (attention: Attention, task: Task | null, approve: boolean) => {
      if (approve && !(await confirmPush(attention.operation as LandPlan))) return;
      await client.resolveAttention(attention.id, approve ? { type: "approve" } : { type: "deny" });
      toast(
        approve
          ? `Pushed “${clip(task?.title ?? attention.reason, 40)}”`
          : "Declined the push; the manager was told",
      );
      await refresh();
    };

    const discard = async (task: Task) => {
      const ok = await ctx.ui.dialog.confirm({
        title: `Discard “${clip(task.title, 40)}”?`,
        message: `${task.state === "completed" || task.state === "cancelled" ? "" : "The task is cancelled, then its "}worktree and branch are deleted, including uncommitted changes and commits that exist nowhere else.${task.workspacePath ? `\n\n${task.workspacePath}` : ""}`,
        label: { confirm: "Discard" },
      });
      if (!ok) return;
      await client.discardTask(task.id);
      toast(`Discarded “${clip(task.title, 40)}”`);
      await refresh();
    };

    /** Opens a taken-over session: a tmux window when tmux is on and the TUI runs in it, else the command to run. */
    const openSession = async (r: TakeOverResult) => {
      const window = r.tmux
        ? await openSessionWindow({
            taskId: r.task.id,
            cwd: r.cwd,
            command: r.command,
            sessionEnv: r.env,
          })
        : null;
      if (window) {
        toast(`Opened in tmux window ${window}; it keeps running if you close the terminal`);
        return;
      }
      await ctx.ui.dialog.alert({
        title: "Drive the session yourself",
        message: `Run this in a terminal (inside tmux it keeps running after you close the terminal):\n\n${shellLine(r.cwd, r.command, r.env)}\n\nHand it back from the sidebar or with /giveback.`,
      });
    };

    /** Manual mode: OCD stops driving the worker, the manager is told, and the session opens for you. */
    const takeOver = async (task: Task) => {
      if (task.state !== "manual") {
        const live = task.state === "running" || task.state === "blocked";
        const ok = await ctx.ui.dialog.confirm({
          title: `Take over “${clip(task.title, 40)}”?`,
          message: `${live ? "The worker's current turn is interrupted and OCD stops driving it. " : "OCD stops driving it. "}The manager is told to leave it alone until you give it back.`,
          label: { confirm: "Take over" },
        });
        if (!ok) return;
      }
      const result = await client.takeOverTask(task.id);
      await refresh();
      await openSession(result);
    };

    const giveBack = async (task: Task, mode: "continue" | "review") => {
      const note = await ctx.ui.dialog.prompt({
        title:
          mode === "continue" ? "Give back: the worker continues" : "Give back: ready for review",
        description: "Optional note for the worker and the manager: what you did, what is left.",
        placeholder: "Note (optional)",
      });
      if (note === undefined) return;
      await client.giveBackTask(task.id, { mode, ...(note.trim() ? { note: note.trim() } : {}) });
      toast(
        mode === "continue"
          ? `Handed back “${clip(task.title, 40)}”; the worker continues`
          : `Handed back “${clip(task.title, 40)}” for review`,
      );
      await refresh();
    };

    const rowActions = async (row: Row) => {
      try {
        const actions = actionsFor(row, { pullRequests: await pullRequestsOn() });
        const picked = await ctx.ui.dialog.select<number>({
          title: clip(row.title, 60),
          options: actions.map((a, i) => ({ title: a.label, value: i })),
        });
        const action = picked === undefined || picked === null ? undefined : actions[picked];
        if (!action) return;
        const task = row.task;
        if ("message" in action) {
          if (task) await askAbout(task, action.message);
          return;
        }
        switch (action.kind) {
          case "message":
            if (task) await askAbout(task);
            return;
          case "details":
            await details(row);
            return;
          case "takeover":
          case "open":
            if (task) await takeOver(task);
            return;
          case "giveback_continue":
            if (task) await giveBack(task, "continue");
            return;
          case "giveback_review":
            if (task) await giveBack(task, "review");
            return;
          case "land":
            if (task) await land(task);
            return;
          case "land_direct":
            if (task) await landDirect(task);
            return;
          case "land_confirm":
          case "land_decline":
            if (row.attention)
              await answerPush(row.attention, task, action.kind === "land_confirm");
            return;
          case "discard":
            if (task) await discard(task);
            return;
          default:
            if (task) await runDirect(task, action.kind);
        }
      } catch (error) {
        fail(error);
      }
    };

    /** Searchable task picker; null when cancelled or nothing qualifies. */
    const pickTask = async (title: string, filter: (t: Task) => boolean = () => true) => {
      const all = (await client.listTasks({ limit: 100 })).filter(filter);
      if (!all.length) {
        toast("No task qualifies", "warning");
        return null;
      }
      return (
        (await ctx.ui.dialog.select<Task>({
          title,
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
        })) ?? null
      );
    };

    /**
     * /spill: what is running, waiting, queued and ready for review. Reads the
     * supervisor as the human (list and inspect only) and shows the result;
     * nothing is sent to the manager or the workers.
     */
    const spill = async () => {
      const text = formatSpill(buildSpill(await collectSpill(client)), {
        maxPerSection: SPILL_ROWS,
        continuation: "ocd spill",
      });
      await ctx.ui.dialog.alert({ title: "OCD: open work", message: text });
    };

    const muted = () => color("textMuted");

    /** A running task's progress: bounded height, scrolls on its own, never acts on the worker. */
    const ProgressPanel = (props: { row: Row }) => {
      const lines = createMemo(() =>
        props.row.task ? progressLines(props.row.task, progress()[props.row.key], now()) : [],
      );
      return (
        <scrollbox
          height={panelHeight(lines())}
          marginLeft={PANEL_INDENT}
          scrollY
          // Only an overflowing panel keeps the wheel from also scrolling the sidebar.
          onMouseScroll={(e) => {
            if (panelScrolls(lines())) e.stopPropagation();
          }}
        >
          {/* By index: live updates change lines in place instead of rebuilding the list. */}
          <Index each={lines()}>
            {(line) => (
              <box flexDirection="row">
                <text fg={tone(line().tone)}>{`${line().glyph} `}</text>
                <box flexGrow={1}>
                  <text fg={line().tone === "muted" ? muted() : color("text")} wrapMode="none">
                    {clip(
                      line().text,
                      Math.max(8, ROW_WIDTH - PANEL_INDENT - 2 - (line().meta.length + 1)),
                    )}
                  </text>
                </box>
                <text fg={muted()}>{line().meta ? ` ${line().meta}` : ""}</text>
              </box>
            )}
          </Index>
        </scrollbox>
      );
    };

    const RowView = (props: { row: Row; indent: string }) => {
      // Only rows inside a section have room for the chevron, which takes the indent's place.
      const expandable = () => props.indent.length >= 2 && canExpand(props.row);
      const open = () => expandable() && expanded().has(props.row.key);
      return (
        <box flexDirection="column">
          <box
            flexDirection="row"
            backgroundColor={
              hovered() === props.row.key ? color("backgroundElement") : "transparent"
            }
            onMouseOver={() => setHovered(props.row.key)}
            onMouseOut={() => setHovered((k) => (k === props.row.key ? null : k))}
            // On release: a dialog opened on press is dismissed by the release landing on its backdrop.
            onMouseUp={() => void rowActions(props.row)}
          >
            <Show
              when={expandable()}
              fallback={
                <text fg={tone(props.row.tone)}>{`${props.indent}${props.row.glyph} `}</text>
              }
            >
              {/* Chevron and status glyph only expand or collapse; they never open the row's actions. */}
              <box
                flexDirection="row"
                onMouseUp={(e) => {
                  e.stopPropagation();
                  toggleProgress(props.row.key);
                }}
              >
                <text fg={muted()}>{`${props.indent.slice(2)}${open() ? "▾" : "▸"} `}</text>
                <text fg={tone(props.row.tone)}>{`${props.row.glyph} `}</text>
              </box>
            </Show>
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
          <Show when={open()}>
            <ProgressPanel row={props.row} />
          </Show>
        </box>
      );
    };

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
              when={!model.idle}
              fallback={
                // Nothing open: no sections to expand, just what finished lately.
                <box flexDirection="column">
                  <box flexDirection="row">
                    <text>
                      <b>OCD</b>
                    </text>
                    <text fg={muted()}>
                      {model.recent.length
                        ? `  idle · ${model.recent.length} done today`
                        : "  idle"}
                    </text>
                  </box>
                  <For each={model.recent.slice(0, 3)}>
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
                <For each={model.counts}>
                  {(c) => <text fg={tone(c.tone)}>{`  ${c.glyph} ${c.count}`}</text>}
                </For>
              </box>
              {/* Collapsed: only what waits on the human. */}
              <Show when={!ui.expanded}>
                <For each={model.urgent.slice(0, 3)}>
                  {(row) => <RowView row={row} indent="  " />}
                </For>
              </Show>
              <Show when={ui.expanded}>
                <For each={model.sections}>
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
              const task = await pickTask("OCD task");
              if (task) await askAbout(task);
            } catch (error) {
              fail(error);
            }
          },
        },
        {
          id: "ocd.spill",
          title: "OCD: summary of all open work (read-only)",
          group: "OCD",
          palette: true,
          slash: { name: "spill" },
          run: async () => {
            try {
              await spill();
            } catch (error) {
              fail(error);
            }
          },
        },
        {
          id: "ocd.takeover",
          title: "OCD: take over a worker's session (manual mode)",
          group: "OCD",
          palette: true,
          slash: { name: "takeover" },
          run: async () => {
            try {
              const task = await pickTask(
                "Take over which task?",
                (t) => !!t.sessionId && (t.state === "manual" || TAKEOVER_STATES.has(t.state)),
              );
              if (task) await takeOver(task);
            } catch (error) {
              fail(error);
            }
          },
        },
        {
          id: "ocd.land",
          title: "OCD: land a finished task (pull request or direct push)",
          group: "OCD",
          palette: true,
          slash: { name: "land" },
          run: async () => {
            try {
              const task = await pickTask("Land which task?", landable);
              if (!task) return;
              const routes = landingActions({ pullRequests: await pullRequestsOn() });
              const route = await ctx.ui.dialog.select<"land" | "land_direct">({
                title: clip(task.title, 60),
                options: routes.map((r) => ({ title: r.label, value: r.kind })),
              });
              if (route === "land") await land(task);
              else if (route === "land_direct") await landDirect(task);
            } catch (error) {
              fail(error);
            }
          },
        },
        {
          id: "ocd.giveback",
          title: "OCD: give a manual task back to the manager",
          group: "OCD",
          palette: true,
          slash: { name: "giveback" },
          run: async () => {
            try {
              const task = await pickTask("Give back which task?", (t) => t.state === "manual");
              if (!task) return;
              const mode = await ctx.ui.dialog.select<"continue" | "review">({
                title: clip(task.title, 60),
                options: [
                  { title: "Let the worker continue", value: "continue" },
                  { title: "Ready for review", value: "review" },
                ],
              });
              if (mode) await giveBack(task, mode);
            } catch (error) {
              fail(error);
            }
          },
        },
        {
          id: "ocd.progress",
          title: "OCD: show or hide a running task's progress",
          group: "OCD",
          palette: true,
          run: async () => {
            try {
              const task = await pickTask("Progress of which task?", (t) =>
                ["running", "starting", "blocked"].includes(t.state),
              );
              if (!task) return;
              const opening = !expanded().has(task.id);
              // Opening from the keyboard also opens the sidebar and its Running section.
              if (opening)
                await setUi((d) => {
                  d.expanded = true;
                  d.sections.running = true;
                });
              toggleProgress(task.id);
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
