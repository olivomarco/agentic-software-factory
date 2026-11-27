#!/usr/bin/env bash
# Prepares a GitHub repository for the factory: labels, the copilot-agent
# environment (holds the agent token, usable from the default branch only),
# the branch rulesets for the default branch and factory/** and, optionally,
# the agent token, CODEOWNERS owner and a Project board.
# Safe to re-run (labels, rulesets and settings are updated in place).
#
# Usage: scripts/setup-repo.sh [--repo OWNER/REPO] [--owner @team] [--no-ruleset] [--admin-bypass] [--project TITLE]
#   --repo        target repository (default: the current directory's remote)
#   --owner       replace the placeholder owner in .github/CODEOWNERS (local edit, commit it yourself)
#   --no-ruleset  skip the branch rulesets
#   --admin-bypass let repository admins merge a pull request into the default
#                 branch past its ruleset (pull requests only, never direct
#                 pushes). For solo repositories, where the only code owner
#                 cannot approve their own pull request. Re-run without it to remove.
#   --project     create (or reuse) a user/org Project with this title and link it
#                 (needs the 'project' scope: gh auth refresh -s project)
# Environment:
#   GH_AW_AGENT_TOKEN  if set, stored as a secret of the copilot-agent environment
#                      (a token allowed to assign the Copilot cloud agent)
# Needs: gh (logged in, admin on the repository), python3.
set -euo pipefail

repo=""
owner=""
ruleset=true
admin_bypass=false
project=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="$2"; shift 2 ;;
    --owner) owner="$2"; shift 2 ;;
    --no-ruleset) ruleset=false; shift ;;
    --admin-bypass) admin_bypass=true; shift ;;
    --project) project="$2"; shift 2 ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

root="$(cd "$(dirname "$0")/.." && pwd)"
gh auth status >/dev/null 2>&1 || { echo "Run 'gh auth login' first." >&2; exit 1; }
[ -n "$repo" ] || repo="$(cd "$root" && gh repo view --json nameWithOwner --jq .nameWithOwner)"
echo "Repository: $repo"

echo "== Labels"
create_label() { gh label create "$1" --repo "$repo" --color "$2" --description "$3" --force >/dev/null && echo "  $1"; }
# Triage state machine (Matt Pocock's triage skill, see docs/agents/triage-labels.md)
create_label "bug"                d73a4a "Something is broken"
create_label "enhancement"        a2eeef "New feature or improvement"
create_label "needs-triage"       ededed "A maintainer needs to evaluate this"
create_label "needs-info"         d93f0b "Waiting on the reporter for more information"
create_label "ready-for-agent"    0e8a16 "Fully specified: the dispatcher hands it to the cloud agent"
create_label "ready-for-human"    1d76db "Needs human implementation"
create_label "wontfix"            ffffff "Will not be actioned"
create_label "possible-duplicate" cfd3d7 "Triage found a likely duplicate"
create_label "triage"             5319e7 "Re-run triage on this issue"
# Spec and delivery
create_label "spec"               c5def5 "The issue carries a spec (## Spec) waiting for approval"
create_label "spec:approved"      0e8a16 "Human gate: break the spec into tickets"
create_label "status:in-progress" fbca04 "The cloud agent is working on this"
create_label "documentation"      0075ca "Docs, glossary or ADR"
# Risk gate
# Describe pull requests (risk gate + actions/labeler, grouped by .github/release.yml)
create_label "refactor"           d4c5f9 "Restructures code without changing behaviour"
create_label "tests"              bfd4f2 "Adds or changes tests"
create_label "ci"                 ededed "Workflows and automation"
create_label "dependencies"       0366d6 "Dependency or build changes"
create_label "factory"            5319e7 "Touches the factory itself (.github, scripts, devcontainer)"
create_label "door:one-way"       b60205 "Hard to roll back (Merge Danger): always reviewed by a human"
create_label "risk:low"           c2e0c6 "Small, no sensitive paths: merges automatically"
create_label "risk:high"          e99695 "Needs a human approval before merge"
create_label "hold"               b60205 "Never merge automatically"
create_label "human-approved"     0e8a16 "A human approved the current head (cleared on push)"
create_label "needs-human"        b60205 "The review fix loop gave up: a human resolves and approves"
create_label "lane:local"         5319e7 "Spec built locally with implement-spec; the dispatcher skips its tickets"

echo "== Repository settings"
gh repo edit "$repo" --enable-squash-merge --delete-branch-on-merge >/dev/null
echo "  squash merge on, delete head branches after merge"
# Workflows get a read-only GITHUB_TOKEN unless they ask for more, and Actions
# may not approve pull requests.
gh api -X PUT "repos/$repo/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false >/dev/null
echo "  default GITHUB_TOKEN permissions: read"

if [ -n "$owner" ]; then
  echo "== CODEOWNERS"
  sed -i -E "s|^(\S+) @\S+|\1 $owner|" "$root/.github/CODEOWNERS"
  echo "  owner set to $owner (commit and push this change before enabling the ruleset)"
fi

echo "== Agent environment"
# Only workflows running on the default branch (dispatch) can read the token, so
# Copilot's PR branches cannot, even when their workflow runs need no approval.
env_name="copilot-agent"
default_branch="$(gh repo view "$repo" --json defaultBranchRef --jq .defaultBranchRef.name)"
gh api -X PUT "repos/$repo/environments/$env_name" --input - >/dev/null <<JSON
{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
JSON
if ! gh api "repos/$repo/environments/$env_name/deployment-branch-policies" \
    --jq '.branch_policies[].name' | grep -qx "$default_branch"; then
  gh api -X POST "repos/$repo/environments/$env_name/deployment-branch-policies" \
    -f name="$default_branch" -f type=branch >/dev/null
fi
echo "  $env_name (branch: $default_branch)"

if [ -n "${GH_AW_AGENT_TOKEN:-}" ]; then
  gh secret set GH_AW_AGENT_TOKEN --repo "$repo" --env "$env_name" --body "$GH_AW_AGENT_TOKEN" >/dev/null
  echo "  GH_AW_AGENT_TOKEN stored in $env_name"
elif ! gh secret list --repo "$repo" --env "$env_name" --json name --jq '.[].name' | grep -qx GH_AW_AGENT_TOKEN; then
  echo "  GH_AW_AGENT_TOKEN missing: assigning the cloud agent will fail until you run"
  echo "    gh secret set GH_AW_AGENT_TOKEN --repo $repo --env $env_name"
fi
if gh secret list --repo "$repo" --json name --jq '.[].name' | grep -qx GH_AW_AGENT_TOKEN; then
  echo "  WARNING: GH_AW_AGENT_TOKEN is also a repository secret, readable from any branch."
  echo "    Delete it once the environment secret is set: gh secret delete GH_AW_AGENT_TOKEN --repo $repo"
fi

if $ruleset; then
  echo "== Branch rulesets"
  err="$(mktemp)"
  prepared="$(mktemp)"
  fallback="$(mktemp)"
  trap 'rm -f "$err" "$prepared" "$fallback"' EXIT
  if ! all="$(gh api "repos/$repo/rulesets" --jq '.[] | "\(.id) \(.name)"' 2>"$err")"; then
    cat "$err" >&2
    echo "  Rulesets are unavailable for $repo (private repo on a free plan, or no admin rights)." >&2
    echo "  Make the repository public, upgrade the plan, or re-run with --no-ruleset." >&2
    exit 1
  fi

  for file in "$root/docs/ruleset-main.json" "$root/docs/ruleset-factory.json"; do
    name="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["name"])' "$file")"
    existing="$(printf '%s\n' "$all" | while read -r id n; do [ "$n" = "$name" ] && echo "$id"; done || true)"
    apply() {
      if [ -n "$existing" ]; then
        gh api -X PUT "repos/$repo/rulesets/$existing" --input "$1" >/dev/null
      else
        gh api -X POST "repos/$repo/rulesets" --input "$1" >/dev/null
      fi
    }
    # Admins (role id 5) may bypass the default branch's ruleset through a pull
    # request only; every other ruleset, and every run without the flag, has none.
    python3 - "$file" "$prepared" "$admin_bypass" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
main = "~DEFAULT_BRANCH" in d["conditions"]["ref_name"]["include"]
d["bypass_actors"] = (
    [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request"}]
    if sys.argv[3] == "true" and main
    else []
)
json.dump(d, open(sys.argv[2], "w"))
PY
    if apply "$prepared" 2>"$err"; then
      $admin_bypass && [ "$file" = "$root/docs/ruleset-main.json" ] && bypass_note=" (admins may bypass via pull request)" || bypass_note=""
      echo "  '$name' applied$bypass_note"
      continue
    fi
    # The copilot_code_review rule is not available on every plan.
    python3 - "$prepared" "$fallback" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["rules"] = [r for r in d["rules"] if r["type"] != "copilot_code_review"]
json.dump(d, open(sys.argv[2], "w"))
PY
    if apply "$fallback" 2>>"$err"; then
      echo "  '$name' applied WITHOUT copilot_code_review (not accepted here)."
      echo "  Enable automatic Copilot code review in the repository settings."
    else
      cat "$err" >&2
      echo "  Could not apply '$name'. You need admin rights on $repo." >&2
      exit 1
    fi
  done
fi

if [ -n "$project" ]; then
  echo "== Project board"
  powner="${repo%%/*}"
  number="$(gh project list --owner "$powner" --format json --jq ".projects[] | select(.title==\"$project\") | .number" | head -1)"
  if [ -z "$number" ]; then
    number="$(gh project create --owner "$powner" --title "$project" --format json --jq .number)"
    echo "  created '$project' (#$number)"
  fi
  gh project link "$number" --owner "$powner" --repo "$repo" >/dev/null 2>&1 || true
  gh variable set FACTORY_PROJECT_URL --repo "$repo" \
    --body "$(gh project view "$number" --owner "$powner" --format json --jq .url)" >/dev/null
  echo "  '$project' (#$number) linked; URL stored in the FACTORY_PROJECT_URL variable"
  echo "  In the project's Workflows tab, turn on 'Auto-add to project' for this repository."
fi

cat <<EOF

Still manual:
  - Enable the Copilot cloud agent and decide on "Require approval for workflow runs":
    https://github.com/$repo/settings/copilot
    Turning it off lets Copilot's PR checks start automatically; the agent token stays
    out of reach because only $default_branch can use the $env_name environment.
  - Push the compiled workflows (.github/workflows/*.lock.yml) to the default branch.
  - Copilot code review (https://github.com/$repo/settings/copilot): review effort
    "Adaptive". It reads .github/skills/code-review; open a test PR and check its
    [Spec] comments quote the ticket. If they do not, add the GitHub MCP server
    under Copilot > MCP servers so the review can read issues.
  - Codespaces prebuilds (https://github.com/$repo/settings/codespaces): add a
    configuration for $default_branch with .devcontainer/devcontainer.json, and
    set an idle timeout and a 2-core machine limit in your codespaces policies.
  - Replace the placeholder owner in .github/CODEOWNERS if you did not pass --owner.
  - Optional repository variables (Settings > Secrets and variables > Actions > Variables):
    FACTORY_MAX_ACTIVE (3), FACTORY_MAX_FIX_ROUNDS (2), FACTORY_REQUIRE_COPILOT_REVIEW (true),
    FACTORY_AUTO_MERGE_DEFAULT_BRANCH (true), FACTORY_AUTO_MERGE_INTEGRATION (false).
EOF
