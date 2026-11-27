#!/usr/bin/env bash
# Kill switch for the factory.
#
#   scripts/factory-pause.sh on  [--hard] [--repo OWNER/REPO]
#   scripts/factory-pause.sh off [--repo OWNER/REPO]
#   scripts/factory-pause.sh status [--repo OWNER/REPO]
#
# on      sets FACTORY_PAUSED=true: the dispatcher starts no agent sessions,
#         retries, review fix rounds or triage re-runs, and the risk gate
#         merges nothing. Everything else (labels, statuses, the board,
#         alerts) keeps running, and sessions already running finish.
# --hard  also disables every workflow that runs a model or acts on its own
#         (dispatch, risk gate, triage, spec, plan, architecture scout).
# off     clears the variable and enables those workflows again.
set -euo pipefail

mode="${1:-status}"
shift || true
repo=""
hard=false
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="$2"; shift 2 ;;
    --hard) hard=true; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$repo" ] || repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"

workflows=(dispatch.yml risk-gate.yml triage.lock.yml spec.lock.yml plan.lock.yml architecture-scout.lock.yml)

case "$mode" in
  on)
    gh variable set FACTORY_PAUSED --body true --repo "$repo"
    echo "FACTORY_PAUSED=true on $repo"
    if $hard; then
      for w in "${workflows[@]}"; do
        gh workflow disable "$w" --repo "$repo" 2>/dev/null && echo "  disabled $w" || echo "  $w: already disabled or missing"
      done
    fi
    ;;
  off)
    gh variable delete FACTORY_PAUSED --repo "$repo" 2>/dev/null || true
    for w in "${workflows[@]}"; do
      gh workflow enable "$w" --repo "$repo" 2>/dev/null && echo "  enabled $w" || true
    done
    echo "factory running on $repo"
    ;;
  status)
    paused="$(gh variable get FACTORY_PAUSED --repo "$repo" 2>/dev/null || echo false)"
    echo "FACTORY_PAUSED=$paused"
    gh workflow list --all --repo "$repo" --json name,path,state \
      -q '.[] | select(.path | test("dispatch|risk-gate|triage|spec|plan|architecture")) | "  \(.state)\t\(.name)"'
    ;;
  *) echo "usage: $0 on [--hard] | off | status [--repo OWNER/REPO]" >&2; exit 2 ;;
esac
