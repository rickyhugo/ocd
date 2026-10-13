// Terminal apps OCD can bring forward, identified the way tmux reports its
// client (`#{client_termtype}`, e.g. "ghostty 1.3.1", or `#{client_termname}`,
// e.g. "xterm-kitty"), with the id each desktop uses to activate the window.

export interface TerminalApp {
  name: string;
  /** macOS bundle id, for `open -b`. */
  macBundle?: string;
  /** Linux window class / Wayland app id, for wmctrl, swaymsg or hyprctl. */
  linuxClass?: string;
}

const TERMINALS: (TerminalApp & { match: RegExp })[] = [
  {
    name: "ghostty",
    match: /ghostty/i,
    macBundle: "com.mitchellh.ghostty",
    linuxClass: "com.mitchellh.ghostty",
  },
  { name: "kitty", match: /kitty/i, macBundle: "net.kovidgoyal.kitty", linuxClass: "kitty" },
  {
    name: "wezterm",
    match: /wezterm/i,
    macBundle: "com.github.wez.wezterm",
    linuxClass: "org.wezfurlong.wezterm",
  },
  { name: "alacritty", match: /alacritty/i, macBundle: "org.alacritty", linuxClass: "Alacritty" },
  { name: "iterm2", match: /iterm/i, macBundle: "com.googlecode.iterm2" },
  { name: "terminal", match: /apple_terminal/i, macBundle: "com.apple.Terminal" },
  { name: "warp", match: /warp/i, macBundle: "dev.warp.Warp-Stable", linuxClass: "dev.warp.Warp" },
  { name: "foot", match: /^foot/i, linuxClass: "foot" },
  { name: "konsole", match: /konsole/i, linuxClass: "org.kde.konsole" },
];

/** The terminal behind a tmux client, from its termtype or termname; null when unknown. */
export function identifyTerminal(...hints: string[]): TerminalApp | null {
  for (const hint of hints) {
    const trimmed = hint.trim();
    if (!trimmed) continue;
    const found = TERMINALS.find((t) => t.match.test(trimmed));
    if (found) {
      const { match: _match, ...app } = found;
      return app;
    }
  }
  return null;
}

/** A user-configured app: used as both the macOS bundle id and the Linux window class. */
export function configuredTerminal(id: string): TerminalApp {
  return { name: id, macBundle: id, linuxClass: id };
}
