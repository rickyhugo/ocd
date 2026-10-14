#!/bin/sh
# Installs OCD on a fresh machine, then runs `ocd setup`:
#
#   curl -fsSL https://raw.githubusercontent.com/rickyhugo/ocd/main/scripts/install.sh | sh
#
# Arguments go to `ocd setup` (`| sh -s -- --yes` takes every default). Needs
# git and Node.js 24+. The checkout lives in $OCD_SRC (default ~/.ocd/src);
# running this again fast-forwards it, rebuilds, and checks the setup.
set -eu

repo=${OCD_REPO:-https://github.com/rickyhugo/ocd.git}
src=${OCD_SRC:-${OCD_HOME:-$HOME/.ocd}/src}

say() { printf '%s\n' "$*"; }
die() {
	printf 'ocd install: %s\n' "$*" >&2
	exit 1
}

command -v git >/dev/null 2>&1 || die "git is required"
command -v node >/dev/null 2>&1 || die "Node.js 24 or newer is required (https://nodejs.org)"
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 24 ] || die "Node.js 24 or newer is required (found $(node --version))"

if [ -d "$src/.git" ]; then
	say "Updating $src"
	git -C "$src" pull --ff-only --quiet ||
		die "could not fast-forward $src; sort it out there and run this again"
elif [ -e "$src" ]; then
	die "$src exists but is not a git checkout; move it or set OCD_SRC"
else
	say "Cloning $repo into $src"
	mkdir -p "$(dirname "$src")"
	git clone --quiet "$repo" "$src"
fi

# The pnpm version OCD pins; npx fetches it when this machine has another (or none).
pnpm_version=$(cd "$src" && node -p '
	const p = require("./package.json");
	(p.devEngines?.packageManager?.version ?? (p.packageManager ?? "").replace(/^pnpm@/, "").replace(/\+.*/, "")) || "latest"
')
if command -v pnpm >/dev/null 2>&1 && [ "$(pnpm --version 2>/dev/null)" = "$pnpm_version" ]; then
	pnpm_run() { (cd "$src" && pnpm "$@"); }
else
	pnpm_run() { (cd "$src" && NPM_CONFIG_LOGLEVEL=error npx --yes "pnpm@$pnpm_version" "$@"); }
fi
say "Installing dependencies and building OCD (pnpm $pnpm_version)"
pnpm_run install --frozen-lockfile
pnpm_run run build

# Under `curl | sh` stdin is the script itself: setup's questions read the terminal.
cli="$src/packages/cli/dist/ocd.mjs"
if [ -t 0 ]; then
	exec node "$cli" setup "$@"
elif (: </dev/tty) 2>/dev/null; then
	exec node "$cli" setup "$@" </dev/tty
else
	exec node "$cli" setup "$@"
fi
