#!/usr/bin/env bash
# Opt-in real smoke test: runs ONE tiny worker task through OCD with a real
# harness. It spends model tokens / subscription quota. It uses a throwaway
# OCD_HOME and git repo and never touches ~/.ocd.
#
#   scripts/smoke.sh --yes-spend-tokens opencode provider/model
#   scripts/smoke.sh --yes-spend-tokens claude sonnet
#   scripts/smoke.sh --yes-spend-tokens codex gpt-5-codex#low
set -euo pipefail

if [[ "${1:-}" != "--yes-spend-tokens" || -z "${2:-}" || -z "${3:-}" ]]; then
	echo "usage: $0 --yes-spend-tokens opencode|claude|codex model" >&2
	exit 2
fi
HARNESS="$2"
MODEL="$3"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d /tmp/ocd-smoke.XXXXXX)"
export OCD_HOME="$WORK/home"
OCD=(node "$ROOT/packages/cli/dist/ocd.mjs")

git init -q -b main "$WORK/repo"
git -C "$WORK/repo" -c user.email=smoke@example.com -c user.name=smoke commit -q --allow-empty -m init
mkdir -p "$OCD_HOME"
cat >"$OCD_HOME/ocd.jsonc" <<JSON
{
  "notifications": { "enabled": false },
  "backups": { "intervalHours": 0 },
  "repos": { "smoke": { "path": "$WORK/repo", "profile": "smoke" } },
  "profiles": { "smoke": { "harness": "$HARNESS", "model": "$MODEL", "permissionPolicy": "deny" } }
}
JSON

"${OCD[@]}" daemon >"$WORK/daemon.log" 2>&1 &
DAEMON=$!
trap '"${OCD[@]}" stop >/dev/null 2>&1 || kill $DAEMON 2>/dev/null; echo "artifacts: $WORK"' EXIT
sleep 2

"${OCD[@]}" dispatch smoke "Smoke test" --key "smoke-$(date +%s)" \
	--instructions "Create a file HELLO.md containing exactly the line: hello from ocd. Do not run any other commands." \
	--criteria "HELLO.md exists"

# shellcheck disable=SC2066
for _ in "$(seq 1 120)"; do
	STATE="$("${OCD[@]}" task list --all --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0]?.state??""))')"
	echo "state: $STATE"
	case "$STATE" in ready_for_review | needs_attention | failed | blocked | interrupted) break ;; esac
	sleep 5
done

ID="$("${OCD[@]}" task list --all --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].id))')"
"${OCD[@]}" task show "$ID"
