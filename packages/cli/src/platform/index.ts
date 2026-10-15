import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LaunchdService } from "./launchd.ts";
import {
  FallbackNotifier,
  NoDesktopNotifier,
  NotifySendNotifier,
  OsascriptNotifier,
  TerminalNotifier,
  type DesktopNotifier,
} from "./notify.ts";
import { execCommand, locateBinary, type Exec } from "./exec.ts";
import { ensureNotifierApp } from "./notifier-app.ts";
import type { ServiceManager } from "./service.ts";
import { SystemdService } from "./systemd.ts";
import type { TerminalApp } from "./terminal.ts";

export * from "./exec.ts";
export * from "./focus.ts";
export * from "./launchd.ts";
export * from "./notifier-app.ts";
export * from "./notify.ts";
export * from "./service.ts";
export * from "./shell-env.ts";
export * from "./systemd.ts";
export * from "./terminal.ts";

/**
 * Everything OCD needs from the desktop: notifications, raising the terminal,
 * and running the supervisor as a background service. One implementation per
 * OS; the rest of OCD only sees this interface and never branches on the OS.
 */
export interface Platform {
  /** For display and logs only. */
  readonly name: string;
  /**
   * The best notifier available; clicking runs `onClick` where the backend
   * supports it. With `assets` (and `home`) notifications carry OCD's icon.
   */
  notifier(options?: NotifierOptions): Promise<DesktopNotifier>;
  /** What `ocd setup` checks, or offers to install, for notifications; null when there is nothing to check. */
  notifierPrerequisite(): NotifierPrerequisite | null;
  /** A one-time step the user takes before notifications show (granting permission), when one is pending for `home`. */
  notificationApproval(home: string): NotificationApproval | null;
  /** How to make notifications clickable, shown by `ocd doctor` while they are not; null when nothing can be done. */
  readonly clickableHint: string | null;
  /** Raises a terminal app's window; false when the platform cannot. */
  activate(app: TerminalApp): Promise<boolean>;
  /** Background service manager, or null where OCD has none. */
  readonly service: ServiceManager | null;
}

export interface NotifierOptions {
  onClick?: readonly string[] | undefined;
  /** Directory of OCD's shipped assets (see assetsDir); each platform picks the icon format it needs. */
  assets?: string | undefined;
  /** OCD's home; a platform may keep notifier state in <home>/notifier. */
  home?: string | undefined;
}

/** A notification dependency, found or not, for setup to report without knowing what it is. */
export interface NotifierPrerequisite {
  /** Notifications work as well as they can on this system. */
  ready: boolean;
  /** One line for the setup summary: what was found, or what is missing and what that costs. */
  summary: string;
  /** When not ready and fixable: the question to ask, and the command to run if the user agrees. */
  install?: {
    question: string;
    command: string;
    args: string[];
    /** Summary lines for the three outcomes. */
    installed: string;
    failed: string;
    declined: string;
  };
}

export interface NotificationApproval {
  /** What the user needs to do. */
  message: string;
  /** Opens the place to do it. */
  open(): Promise<void>;
}

/** OCD's shipped assets (packages/cli/assets), given the CLI module's own URL. */
export function assetsDir(moduleUrl: string): string {
  return join(dirname(fileURLToPath(moduleUrl)), "..", "assets");
}

/** Icon file names inside the assets directory, one per format a platform may need. */
export const ICON_FILES = { icns: "ocd.icns", png: "ocd-icon.png" } as const;

const MAC_NOTIFICATION_SETTINGS =
  "x-apple.systempreferences:com.apple.Notifications-Settings.extension";

export class MacPlatform implements Platform {
  readonly name = "macos";
  readonly service: ServiceManager;
  readonly clickableHint =
    "brew install terminal-notifier  # makes notifications open the manager session";
  private readonly exec: Exec;
  private readonly locate: (name: string) => string | null;

  constructor(
    options: {
      exec?: Exec;
      service?: ServiceManager;
      locate?: (name: string) => string | null;
    } = {},
  ) {
    this.exec = options.exec ?? execCommand;
    this.locate = options.locate ?? ((name) => locateBinary(name));
    this.service = options.service ?? new LaunchdService({ exec: this.exec });
  }

  async notifier(options: NotifierOptions = {}): Promise<DesktopNotifier> {
    const found = this.locate("terminal-notifier");
    // OCD's own copy of terminal-notifier carries its name and icon (see notifier-app.ts).
    const branded =
      found && options.assets && options.home
        ? await ensureNotifierApp({
            terminalNotifier: found,
            icns: join(options.assets, ICON_FILES.icns),
            home: options.home,
            exec: this.exec,
          })
        : null;
    const binary = branded ?? found;
    const osascript = new OsascriptNotifier({ exec: this.exec });
    return binary
      ? new FallbackNotifier(
          new TerminalNotifier({ binary, onClick: options.onClick, exec: this.exec }),
          osascript,
        )
      : osascript;
  }

  notifierPrerequisite(): NotifierPrerequisite {
    const found = this.locate("terminal-notifier");
    if (found) return { ready: true, summary: `terminal-notifier ${found}` };
    const fallback = "notifications use osascript: no OCD icon, and clicking one does nothing";
    const brew = this.locate("brew");
    if (!brew) return { ready: false, summary: `${fallback} (install terminal-notifier for both)` };
    return {
      ready: false,
      summary: fallback,
      install: {
        question:
          "Install terminal-notifier with Homebrew? Notifications then carry OCD's name and icon and open the manager when clicked",
        command: brew,
        args: ["install", "terminal-notifier"],
        installed: "terminal-notifier installed",
        failed: `brew install terminal-notifier failed; ${fallback}`,
        declined: fallback,
      },
    };
  }

  notificationApproval(home: string): NotificationApproval | null {
    // OCD's notifier app is new to the system until it has been built once.
    if (existsSync(join(home, "notifier", "OCD.app"))) return null;
    return {
      message: 'allow notifications for "OCD" in System Settings → Notifications (opening it now)',
      open: async () => {
        await this.exec("/usr/bin/open", [MAC_NOTIFICATION_SETTINGS]);
      },
    };
  }

  async activate(app: TerminalApp): Promise<boolean> {
    if (!app.macBundle) return false;
    return (await this.exec("/usr/bin/open", ["-b", app.macBundle])).code === 0;
  }
}

export class LinuxPlatform implements Platform {
  readonly name = "linux";
  readonly service: ServiceManager;
  readonly clickableHint =
    "libnotify 0.7.9+ (notify-send --action) makes notifications open the manager session";
  private readonly exec: Exec;
  private readonly env: NodeJS.ProcessEnv;
  private readonly locate: (name: string) => string | null;

  constructor(
    options: {
      exec?: Exec;
      env?: NodeJS.ProcessEnv;
      service?: ServiceManager;
      locate?: (name: string) => string | null;
    } = {},
  ) {
    this.exec = options.exec ?? execCommand;
    this.env = options.env ?? process.env;
    this.locate = options.locate ?? ((name) => locateBinary(name));
    this.service =
      options.service ??
      new SystemdService({ exec: this.exec, systemctl: this.locate("systemctl") ?? "systemctl" });
  }

  async notifier(options: NotifierOptions = {}): Promise<DesktopNotifier> {
    const binary = this.locate("notify-send");
    if (!binary) return new NoDesktopNotifier("install libnotify for notify-send");
    // Actions arrived in libnotify 0.7.9; older versions reject the flag.
    const help = await this.exec(binary, ["--help"]);
    return new NotifySendNotifier({
      binary,
      onClick: options.onClick,
      supportsActions: help.stdout.includes("--action"),
      ...(options.assets ? { icon: join(options.assets, ICON_FILES.png) } : {}),
      exec: this.exec,
    });
  }

  notifierPrerequisite(): NotifierPrerequisite {
    if (this.locate("notify-send"))
      return { ready: true, summary: "notify-send (desktop notifications)" };
    return {
      ready: false,
      summary: "notify-send not found: no desktop notifications (install libnotify)",
    };
  }

  notificationApproval(): null {
    return null;
  }

  /**
   * Window activation depends on the compositor: Hyprland and sway have IPC
   * for it, X11 has wmctrl. GNOME and KDE on Wayland do not let other
   * processes raise windows, so there only the tmux switch happens.
   */
  async activate(app: TerminalApp): Promise<boolean> {
    const cls = app.linuxClass;
    if (!cls) return false;
    const attempt = async (binary: string, args: string[]) => {
      const path = this.locate(binary);
      return path ? (await this.exec(path, args)).code === 0 : false;
    };
    if (this.env["HYPRLAND_INSTANCE_SIGNATURE"])
      return attempt("hyprctl", ["dispatch", "focuswindow", `class:^(${cls})$`]);
    if (this.env["SWAYSOCK"]) return attempt("swaymsg", [`[app_id="${cls}"] focus`]);
    if (this.env["DISPLAY"] && !this.env["WAYLAND_DISPLAY"])
      return attempt("wmctrl", ["-x", "-a", cls]);
    return false;
  }
}

/** Any other OS: no notifications, no service; `ocd daemon` in a terminal still works. */
export class UnsupportedPlatform implements Platform {
  readonly name = process.platform;
  readonly service = null;
  readonly clickableHint = null;

  async notifier(): Promise<DesktopNotifier> {
    return new NoDesktopNotifier(`no notifier for ${this.name}`);
  }

  notifierPrerequisite(): null {
    return null;
  }

  notificationApproval(): null {
    return null;
  }

  async activate(): Promise<boolean> {
    return false;
  }
}

export function currentPlatform(platform: NodeJS.Platform = process.platform): Platform {
  if (platform === "darwin") return new MacPlatform();
  if (platform === "linux") return new LinuxPlatform();
  return new UnsupportedPlatform();
}
