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
  baseLabel,
  describeLandResult,
  describePendingUpdate,
  updateLine,
  usageLines,
  usageSummary,
  diffTotals,
  fileCounts,
  formatDiffStat,
  formatLandPlan,
  splitPatch,
  formatSpill,
  resolveOcdPaths,
  type Attention,
  type LandPlan,
  type LandResult,
  type OcdApiError,
  type TakeOverResult,
  type Task,
  type TaskDiff,
  type UpdateStatus,
  type UsageStatus,
} from "@ocd/core";
import { Plugin } from "@opencode/plugin/tui";
import type { ScrollBoxRenderable } from "@opentui/core";
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
  updateBanner,
  type Row,
  type Section,
  type SectionKey,
  type SidebarModel,
  type Tone,
} from "./src/sidebar-model.ts";
import { managerSessionFor } from "./src/manager-route.ts";
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
    // OCD's own update state (selfUpdate), shown as one line above the tasks.
    const [update, setUpdate] = createSignal<UpdateStatus | null>(null);
    // Subscription usage limits Claude Code and Codex reported, as one line.
    const [usage, setUsage] = createSignal<UsageStatus | null>(null);
    const [hovered, setHovered] = createSignal<string | null>(null);
    // Session-only: which running tasks show their progress panel.
    const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
    const [progress, setProgress] = createSignal<Record<string, ProgressState>>({});
    // Durable: which sections the human opened or closed survives restarts.
    const [ui, setUi] = ctx.storage.store<{
      expanded: boolean;
      sections: Partial<Record<SectionKey, boolean>>;
    }>("ocd.sidebar", { initial: { expanded: false, sections: {} } });

    // A tick is skipped while a refresh is in flight, so slow responses cannot
    // pile up or apply out of order.
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        await refreshOnce();
      } finally {
        refreshing = false;
      }
    };
    const refreshOnce = async () => {
      try {
        const [open, done, items, status] = await Promise.all([
          client.listTasks({ open: true, limit: 100 }),
          client.listTasks({ state: ["completed", "cancelled"], limit: 20 }),
          client.listAttention({ status: "open", limit: 100 }),
          client.status(),
        ]);
        setUpdate(status.update ?? null);
        setUsage(status.usage ?? null);
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
      const sessionID = managerSessionFor(
        route as { type: string; sessionID?: string },
        await client.getManager().catch(() => null),
      );
      if (!sessionID) {
        toast("Open the manager session first; this message is for the manager", "warning");
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
        sessionID,
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

    /** Picks a landing route for one task (the pull request route only when it is on), then lands. */
    const chooseLanding = async (task: Task) => {
      const routes = landingActions({ pullRequests: await pullRequestsOn() });
      const route = await ctx.ui.dialog.select<"land" | "land_direct">({
        title: clip(task.title, 60),
        options: routes.map((r) => ({ title: r.label, value: r.kind })),
      });
      if (route === "land") await land(task);
      else if (route === "land_direct") await landDirect(task);
    };

    /** Review feedback goes to the same worker session; the task comes back for review. */
    const requestChanges = async (task: Task) => {
      const feedback = await ctx.ui.dialog.prompt({
        title: `Request changes: ${clip(task.title, 40)}`,
        description: "The worker gets this as a follow-up; the task comes back for review.",
        placeholder: "What should change?",
      });
      if (!feedback?.trim()) return;
      await client.requestChanges(task.id, feedback.trim());
      toast(`Sent the feedback; “${clip(task.title, 40)}” is back with the worker`);
      await refresh();
    };

    // The diff opens in OpenCode's session panel, drawn with OpenTUI's diff
    // component. The supervisor produces it; nothing here touches git.
    const DIFF_PANEL = "ocd-diff";
    const [diffView, setDiffView] = createSignal<{ task: Task; diff: TaskDiff } | null>(null);
    const [split, setSplit] = createSignal(false);

    const openDiff = async (task: Task) => {
      const diff = await client.taskDiff(task.id);
      setDiffView({ task, diff });
      // Outside a session there is no panel: show the per-file summary instead.
      if (!ctx.ui.panel.open(DIFF_PANEL))
        await ctx.ui.dialog.alert({ title: clip(task.title, 60), message: formatDiffStat(diff) });
    };

    /** A task by id from the latest sidebar model; null once it is gone from it. */
    const liveTask = (id: string): Task | null => {
      for (const section of model.sections)
        for (const row of section.rows) if (row.task?.id === id) return row.task as Task;
      return null;
    };

    /** The theme's diff colours, where it defines them; OpenTUI's defaults otherwise. */
    const diffColors = () => {
      const pick = (key: string) => theme[key] as never;
      const entries = {
        fg: pick("text"),
        addedBg: pick("diffAddedBg"),
        removedBg: pick("diffRemovedBg"),
        contextBg: pick("diffContextBg"),
        addedSignColor: pick("diffHighlightAdded") ?? pick("diffAdded"),
        removedSignColor: pick("diffHighlightRemoved") ?? pick("diffRemoved"),
        lineNumberFg: pick("diffLineNumber"),
        addedLineNumberBg: pick("diffAddedLineNumberBg"),
        removedLineNumberBg: pick("diffRemovedLineNumberBg"),
      };
      return Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined));
    };

    const DiffPanel = (props: {
      view: { task: Task; diff: TaskDiff };
      focused: boolean;
      focus: () => void;
      close: () => void;
      toggleFullscreen: () => void;
    }) => {
      let scroll: ScrollBoxRenderable | undefined;
      const files = createMemo(() =>
        splitPatch(props.view.diff.patch).map((part) => ({
          ...part,
          file: props.view.diff.files.find((f) => f.path === part.path),
        })),
      );
      // The task as the sidebar last saw it, not as it was when the diff opened.
      const live = () => liveTask(props.view.task.id);
      const reviewable = () => live()?.state === "ready_for_review";
      const canLand = () => {
        const t = live();
        return !!t && landable(t);
      };
      /** Re-reads the task, runs the action if it still applies, and closes the panel once it no longer does. */
      const act = async (applies: (t: Task) => boolean, run: (t: Task) => Promise<unknown>) => {
        const { task } = await client.inspectTask(props.view.task.id);
        if (!applies(task)) {
          toast(`“${clip(task.title, 40)}” is now ${task.state}; nothing to do here`, "warning");
          await refresh();
          props.close();
          return;
        }
        await run(task);
        const after = (await client.inspectTask(task.id)).task;
        if (!applies(after)) props.close();
      };
      ctx.keymap.layer(() => ({
        enabled: () => props.focused,
        commands: [
          {
            title: "Diff: unified / side by side",
            group: "OCD diff",
            bind: "v",
            run: () => void setSplit((s) => !s),
          },
          {
            title: "Diff: scroll down",
            group: "OCD diff",
            bind: "j",
            run: () => scroll?.scrollBy(3),
          },
          {
            title: "Diff: scroll up",
            group: "OCD diff",
            bind: "k",
            run: () => scroll?.scrollBy(-3),
          },
          {
            title: "Diff: page down",
            group: "OCD diff",
            bind: "space",
            run: () => scroll?.scrollBy(20),
          },
          {
            title: "Diff: page up",
            group: "OCD diff",
            bind: "b",
            run: () => scroll?.scrollBy(-20),
          },
          {
            title: "Request changes…",
            group: "OCD diff",
            bind: "r",
            enabled: reviewable,
            run: () => void act((t) => t.state === "ready_for_review", requestChanges).catch(fail),
          },
          {
            title: "Land…",
            group: "OCD diff",
            bind: "l",
            enabled: canLand,
            run: () => void act(landable, chooseLanding).catch(fail),
          },
          {
            title: "Diff: fullscreen",
            group: "OCD diff",
            bind: "f",
            run: () => props.toggleFullscreen(),
          },
          { title: "Diff: close", group: "OCD diff", bind: "q", run: () => props.close() },
        ],
      }));
      const d = () => props.view.diff;
      return (
        <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
          <text fg={color("text")} wrapMode="none" flexShrink={0}>
            <b>{props.view.task.title}</b>
          </text>
          <text fg={muted()} wrapMode="none" flexShrink={0}>
            {`${d().branch ?? props.view.task.id} vs ${baseLabel(d())} · ${diffTotals(d())}${d().truncated ? " · truncated" : ""}`}
          </text>
          <text fg={muted()} wrapMode="none" flexShrink={0}>
            {`v split · j/k scroll${reviewable() ? " · r request changes" : ""}${canLand() ? " · l land" : ""} · f fullscreen · q close`}
          </text>
          <scrollbox
            ref={(r: ScrollBoxRenderable) => (scroll = r)}
            flexGrow={1}
            scrollY
            marginTop={1}
          >
            <Show when={files().length} fallback={<text fg={muted()}>No changes.</text>}>
              <For each={files()}>
                {(part) => (
                  <box flexDirection="column" marginBottom={1}>
                    <box flexDirection="row">
                      <text fg={color("text")} wrapMode="none">
                        <b>{part.path}</b>
                      </text>
                      <text fg={muted()} wrapMode="none">
                        {`  ${part.file ? fileCounts(part.file) : ""}${part.file?.uncommitted ? " · uncommitted" : ""}`}
                      </text>
                    </box>
                    <diff
                      diff={part.patch}
                      view={split() ? "split" : "unified"}
                      showLineNumbers
                      wrapMode="none"
                      {...diffColors()}
                    />
                  </box>
                )}
              </For>
            </Show>
          </scrollbox>
        </box>
      );
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
          case "diff":
            if (task) await openDiff(task);
            return;
          case "request_changes":
            if (task) await requestChanges(task);
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

    /** The pending update: apply it now (asking first when it interrupts workers), see what changed, or wait. */
    const updateMenu = async () => {
      const u = await client.updateStatus();
      setUpdate(u);
      if (!u?.enabled) return;
      if (!u.pending) {
        await ctx.ui.dialog.alert({ title: "OCD update", message: updateLine(u) ?? "" });
        return;
      }
      const n = u.blockedBy.length;
      const pick = await ctx.ui.dialog.select<"apply" | "changes" | "later">({
        title: `OCD update ${u.pending.sha.slice(0, 7)}`,
        options: [
          ...(u.cannotApply
            ? []
            : [
                {
                  title: n
                    ? `Apply now (interrupts ${n} worker${n === 1 ? "" : "s"})`
                    : "Apply now",
                  value: "apply" as const,
                },
              ]),
          { title: "What changed", value: "changes" as const },
          { title: n ? "Later: applies when they finish" : "Later", value: "later" as const },
        ],
      });
      if (pick === "changes") {
        await ctx.ui.dialog.alert({ title: "OCD update", message: describePendingUpdate(u) });
      } else if (pick === "apply") {
        if (
          n &&
          !(await ctx.ui.dialog.confirm({
            title: "Interrupt workers and update?",
            message: describePendingUpdate(u),
            label: { confirm: "Update now" },
          }))
        )
          return;
        await client.applyUpdate(n > 0);
        toast("Updating OCD: the supervisor restarts on the new version");
      }
    };

    const UpdateBanner = () => {
      const banner = createMemo(() => updateBanner(update()));
      return (
        <Show when={banner()}>
          {(b: () => NonNullable<ReturnType<typeof updateBanner>>) => (
            <box flexDirection="row" onMouseDown={() => void updateMenu().catch(fail)}>
              <text fg={tone(b().tone)}>{`${b().glyph} `}</text>
              <text fg={color("text")} wrapMode="none">
                {b().text}
              </text>
              <text fg={muted()} wrapMode="none">
                {b().meta ? `  ${b().meta}` : ""}
              </text>
            </box>
          )}
        </Show>
      );
    };

    /** Every reported window with its reset time; Codex is read fresh first. */
    const usageDialog = async () => {
      const u = await client.refreshUsage().catch(() => usage());
      if (u) setUsage(u);
      const lines = usageLines(u?.harnesses ?? [], Date.now());
      await ctx.ui.dialog.alert({
        title: "OCD: usage limits",
        message: lines.length
          ? lines.join("\n")
          : "Nothing reported yet. Claude Code reports its limits while a worker runs; Codex when it is enabled.",
      });
    };

    const UsageLine = () => {
      const summary = createMemo(() => usageSummary(usage(), now()));
      return (
        <Show when={summary()}>
          {(u: () => NonNullable<ReturnType<typeof usageSummary>>) => (
            <box flexDirection="row" onMouseDown={() => void usageDialog().catch(fail)}>
              <text fg={u().tone === "muted" ? muted() : tone(u().tone)} wrapMode="none">
                {`◔ ${u().text}`}
              </text>
            </box>
          )}
        </Show>
      );
    };

    const removeDiffPanel = ctx.ui.slot({
      append: "session.panel",
      render: (input) => (
        <Show when={input.name === DIFF_PANEL ? diffView() : null}>
          {(view: () => { task: Task; diff: TaskDiff }) => (
            <DiffPanel
              view={view()}
              focused={input.focused}
              focus={input.focus}
              close={input.close}
              toggleFullscreen={input.toggleFullscreen}
            />
          )}
        </Show>
      ),
    });

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
            <UpdateBanner />
            <UsageLine />
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
              if (task) await chooseLanding(task);
            } catch (error) {
              fail(error);
            }
          },
        },
        {
          id: "ocd.update",
          title: "OCD: update OCD (apply a pending version, see what changed)",
          group: "OCD",
          palette: true,
          slash: { name: "update" },
          run: async () => {
            try {
              await updateMenu();
            } catch (error) {
              fail(error);
            }
          },
        },
        {
          id: "ocd.limits",
          title: "OCD: usage limits (Claude Code, Codex)",
          group: "OCD",
          palette: true,
          slash: { name: "limits" },
          run: async () => {
            try {
              await usageDialog();
            } catch (error) {
              fail(error);
            }
          },
        },
        {
          id: "ocd.diff",
          title: "OCD: view a task's diff",
          group: "OCD",
          palette: true,
          slash: { name: "diff" },
          run: async () => {
            try {
              const task = await pickTask("Diff of which task?", (t) => !!t.workspacePath);
              if (task) await openDiff(task);
            } catch (error) {
              fail(error);
            }
          },
        },
        {
          id: "ocd.changes",
          title: "OCD: request changes on a task under review",
          group: "OCD",
          palette: true,
          slash: { name: "changes" },
          run: async () => {
            try {
              const task = await pickTask(
                "Request changes on which task?",
                (t) => t.state === "ready_for_review",
              );
              if (task) await requestChanges(task);
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
      removeDiffPanel();
    };
  },
});
