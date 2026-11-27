#!/usr/bin/env bash
# One factory tick: starts the dispatcher sweep and the risk gate sweep on the
# default branch. Run it from any reliable scheduler (cron, an Azure Logic App,
# a Kubernetes CronJob) every 5-10 minutes; see docs/external-timer.md.
#
# Usage: FACTORY_TICK_TOKEN=... scripts/factory-tick.sh OWNER/REPO [BRANCH]
#   FACTORY_TICK_TOKEN  fine-grained token for this repository only, with
#                       "Actions: Read and write" and nothing else
set -euo pipefail
repo="${1:?usage: factory-tick.sh OWNER/REPO [BRANCH]}"
branch="${2:-main}"
: "${FACTORY_TICK_TOKEN:?set FACTORY_TICK_TOKEN}"
for workflow in dispatch.yml risk-gate.yml; do
  curl -fsS -X POST \
    -H "Authorization: Bearer $FACTORY_TICK_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/$repo/actions/workflows/$workflow/dispatches" \
    -d "{\"ref\":\"$branch\"}"
  echo "started $workflow on $repo@$branch"
done
