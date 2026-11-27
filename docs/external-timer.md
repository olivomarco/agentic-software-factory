# External timer

The dispatcher and the risk gate are sweeps: every run looks at all open work
and does what is due. Events start them as things happen (a ticket labelled
or closed, a plan finished, a pull request opened, edited, reviewed, merged,
CI finished, a cloud agent session finished). What events cannot cover is time
passing: an agent session that stalls without a sound, a ticket whose retry is
due, a pull request whose checks finished while a run was busy.

Each workflow has a GitHub `schedule` for that, but scheduled runs are best
effort: GitHub delays them under load and sometimes drops them. For unattended
operation, start both sweeps from a scheduler you trust as well. The GitHub
schedules stay as a fallback; extra runs are harmless (each workflow queues
behind its own concurrency group and finds nothing to do).

## Token

A fine-grained personal access token or GitHub App token for **this
repository only** with **Actions: Read and write** and nothing else. That is
enough to start a workflow (`workflow_dispatch`) on the default branch; it
cannot push code or read the agent token. Rotate it like any other secret.

## Options

**Any cron host.** `scripts/factory-tick.sh` starts both sweeps:

```bash
*/10 * * * * FACTORY_TICK_TOKEN=... /path/to/scripts/factory-tick.sh OWNER/REPO main
```

**Azure Logic App** (Consumption plan, about 8,600 actions a month at a
10-minute interval, cents per month). `docs/external-timer.logicapp.json` is the
workflow definition: a 10-minute recurrence and two HTTP calls, with secure
inputs so the token stays out of run history. Create it with the `logic`
extension of the Azure CLI, giving the parameters in a file you delete
afterwards (or set them in the portal's Logic app designer):

```bash
az extension add --name logic
python3 - OWNER/REPO "$FACTORY_TICK_TOKEN" > /tmp/tick.json <<'PY'
import json, sys
d = json.load(open("docs/external-timer.logicapp.json"))
d["parameters"] = {"repo": {"value": sys.argv[1]}, "token": {"value": sys.argv[2]}}
print(json.dumps(d))
PY
az logic workflow create --resource-group RG --location westeurope \
  --name factory-tick --definition /tmp/tick.json
rm /tmp/tick.json
```

For production keep the token in Key Vault and read it with a Key Vault
action and a managed identity instead of a workflow parameter.

## Checking it

`gh run list --workflow dispatch.yml --event workflow_dispatch` should show a
run every 10 minutes. If the timer stops, the factory still works, at the pace
of GitHub's schedules.
