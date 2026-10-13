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
import type { ServiceManager } from "./service.ts";
import { SystemdService } from "./systemd.ts";
import type { TerminalApp } from "./terminal.ts";

export * from "./exec.ts";
export * from "./focus.ts";
export * from "./launchd.ts";
export * from "./notify.ts";
export * from "./service.ts";
export * from "./systemd.ts";
export * from "./terminal.ts";

/**
 * Everything OCD needs from the desktop: notifications, raising the terminal,
 * and running the supervisor as a background service. One implementation per
 * OS; the rest of OCD only sees this interface.
 */
export interface Platform {
  readonly name: "macos" | "linux" | "unsupported";
  /** The best notifier available; clicking runs `onClick` where the backend supports it. */
  notifier(options?: { onClick?: readonly string[] | undefined }): Promise<DesktopNotifier>;
  /** Raises a terminal app's window; false when the platform cannot. */
  activate(app: TerminalApp): Promise<boolean>;
  /** Background service manager, or null where OCD has none. */
  readonly service: ServiceManager | null;
}

export class MacPlatform implements Platform {
  readonly name = "macos";
  readonly service: ServiceManager;
  private readonly exec: Exec;

  constructor(options: { exec?: Exec; service?: ServiceManager } = {}) {
    this.exec = options.exec ?? execCommand;
    this.service = options.service ?? new LaunchdService({ exec: this.exec });
  }

  async notifier(
    options: { onClick?: readonly string[] | undefined } = {},
  ): Promise<DesktopNotifier> {
    const binary = locateBinary("terminal-notifier");
    const osascript = new OsascriptNotifier({ exec: this.exec });
    return binary
      ? new FallbackNotifier(
          new TerminalNotifier({ binary, onClick: options.onClick, exec: this.exec }),
          osascript,
        )
      : osascript;
  }

  async activate(app: TerminalApp): Promise<boolean> {
    if (!app.macBundle) return false;
    return (await this.exec("/usr/bin/open", ["-b", app.macBundle])).code === 0;
  }
}

export class LinuxPlatform implements Platform {
  readonly name = "linux";
  readonly service: ServiceManager;
  private readonly exec: Exec;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: { exec?: Exec; env?: NodeJS.ProcessEnv; service?: ServiceManager } = {}) {
    this.exec = options.exec ?? execCommand;
    this.env = options.env ?? process.env;
    this.service =
      options.service ??
      new SystemdService({ exec: this.exec, systemctl: locateBinary("systemctl") ?? "systemctl" });
  }

  async notifier(
    options: { onClick?: readonly string[] | undefined } = {},
  ): Promise<DesktopNotifier> {
    const binary = locateBinary("notify-send");
    if (!binary) return new NoDesktopNotifier("install libnotify for notify-send");
    // Actions arrived in libnotify 0.7.9; older versions reject the flag.
    const help = await this.exec(binary, ["--help"]);
    return new NotifySendNotifier({
      binary,
      onClick: options.onClick,
      supportsActions: help.stdout.includes("--action"),
      exec: this.exec,
    });
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
      const path = locateBinary(binary);
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

export class UnsupportedPlatform implements Platform {
  readonly name = "unsupported";
  readonly service = null;

  async notifier(): Promise<DesktopNotifier> {
    return new NoDesktopNotifier(`no notifier for ${process.platform}`);
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
