#!/usr/bin/env bash
# Prints what `ocd` says for help, usage errors and a supervisor that is not
# running, so two versions of the CLI can be compared:
#
#   scripts/characterize-cli.sh > before.txt
#   (change the CLI)
#   scripts/characterize-cli.sh > after.txt && diff before.txt after.txt
#
# It runs the CLI from source against a throwaway HOME and OCD_HOME with no
# supervisor. Nothing here reaches the real system: no setup run, no service
# manager, no harness, no notification.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Not under $TMPDIR: a long one pushes the supervisor socket past the
# Unix socket path limit and every case fails the same way.
WORK="$(mktemp -d /tmp/ocd-char.XXXX)"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/home/.ocd/workspaces/repo/task"

ocd() {
	local home=(OCD_HOME="$WORK/ocd")
	[[ -n "${NO_OCD_HOME:-}" ]] && home=()
	(
		cd "${CWD:-$WORK}" &&
			env -i PATH="$PATH" HOME="$WORK/home" ${home[@]+"${home[@]}"} TERM=dumb \
				node --conditions=source "$ROOT/packages/cli/src/ocd.ts" "$@" </dev/null
	)
}

case_() {
	printf '$ ocd %s\n' "$*" | sed "s|$WORK|<tmp>|g"
	ocd "$@" >"$WORK/out" 2>"$WORK/err"
	local code=$?
	sed "s|$WORK|<tmp>|g" "$WORK/out"
	sed "s|$WORK|<tmp>|g; s|^\(    at \).*|\1…|" "$WORK/err" | sed 's/^/stderr: /'
	printf 'exit %s\n\n' "$code"
}

case_
case_ --help
case_ -h
case_ --json
case_ bogus
case_ --nope
for command in setup daemon service stop restart status pause resume update usage doctor focus \
	repo profile manager spill dispatch task attention memory decision briefing outbox; do
	case_ "$command" --help
done
case_ task peek x --help

case_ setup
case_ service bogus
case_ update bogus
case_ repo bogus
case_ repo add
case_ repo add only-name
case_ repo add demo "$WORK/home"
case_ repo remove demo
case_ profile bogus
case_ dispatch
case_ dispatch repo
case_ dispatch repo title --instructions fix extra words
case_ task
case_ task show
case_ task bogus x
case_ task peek x --limit many
case_ task peek x --follow --before c1
case_ task peek x --follow --interval 0
case_ task send x
case_ task request-changes x
case_ task merge x --method yolo
case_ task resume x
case_ task resume x --mode sideways
case_ task giveback x
case_ task land x --direct --wait --commit
case_ task land x --base b
case_ task land x --method squash --draft
case_ attention bogus
case_ attention resolve
case_ attention resolve x
case_ memory
case_ memory add global
case_ memory search
case_ memory confirm
case_ decision
case_ decision add

for command in stop status pause resume usage "usage --refresh" spill "update" "update status" \
	"update check" "update apply" "update rollback" "repo" "repo list" "profile" manager \
	"task list" "task show x" "task peek x" "task diff x" "task cancel x" "task accept x" \
	"task merge x" "task land x" "task pr x" "task takeover x" "task cleanup x" \
	"task resume x --mode reattach" "task giveback x --mode review" "task send x hi" \
	"task request-changes x more" "dispatch repo title --instructions fix" "attention" \
	"attention list --all" "attention resolve x --deny" "attention resolve x --approve" \
	"memory add global fact" "memory search fact" "memory list" "memory confirm m1" \
	"memory forget m1" "decision add chose" briefing outbox "status --json"; do
	# shellcheck disable=SC2086
	case_ $command
done

# Without OCD_HOME, from inside one of the live OCD's worktrees.
NO_OCD_HOME=1 CWD="$WORK/home/.ocd/workspaces/repo/task" case_ status
