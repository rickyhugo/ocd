#!/usr/bin/env bash
# Opt-in real smoke test: runs ONE tiny OpenCode worker task through OCD.
# It spends model tokens and creates a session in your OpenCode service.
# It uses a throwaway OCD_HOME and git repo and never touches ~/.ocd.
#
#   scripts/smoke-opencode.sh --yes-spend-tokens provider/model
set -euo pipefail

if [[ "${1:-}" != "--yes-spend-tokens" || -z "${2:-}" ]]; then
  echo "usage: $0 --yes-spend-tokens provider/model" >&2
  exit 2
fi
MODEL="$2"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d /tmp/ocd-smoke.XXXXXX)"
export OCD_HOME="$WORK/home"
OCD=(node "$ROOT/packages/cli/dist/ocd.mjs")

mkdir -p "$OCD_HOME"
echo '{"notifications": {"enabled": false}}' > "$OCD_HOME/config.json"
git init -q -b main "$WORK/repo"
git -C "$WORK/repo" -c user.email=smoke@example.com -c user.name=smoke commit -q --allow-empty -m init

"${OCD[@]}" daemon > "$WORK/daemon.log" 2>&1 &
DAEMON=$!
trap '"${OCD[@]}" stop >/dev/null 2>&1 || kill $DAEMON 2>/dev/null; echo "artifacts: $WORK"' EXIT
sleep 2

"${OCD[@]}" profile add smoke --harness opencode --model "$MODEL" --permission deny
"${OCD[@]}" repo add smoke "$WORK/repo" --profile smoke
"${OCD[@]}" dispatch smoke "Smoke test" --key "smoke-$(date +%s)" \
  --instructions "Create a file HELLO.md containing exactly the line: hello from ocd. Do not run any other commands." \
  --criteria "HELLO.md exists"

for _ in $(seq 1 120); do
  STATE="$("${OCD[@]}" task list --all --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0]?.state??""))')"
  echo "state: $STATE"
  case "$STATE" in ready_for_review|needs_attention|failed|blocked|interrupted) break ;; esac
  sleep 5
done

ID="$("${OCD[@]}" task list --all --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].id))')"
"${OCD[@]}" task show "$ID"
