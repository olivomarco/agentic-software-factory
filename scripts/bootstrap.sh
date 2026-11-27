#!/usr/bin/env bash
# One environment for humans, the cloud agent and CI: the dev container
# (postCreateCommand), copilot-setup-steps.yml and ci.yml all run this script,
# so a Codespace behaves like the agent's runner. Keep it idempotent.
set -euo pipefail
cd "$(dirname "$0")/.."

node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt 22 ]; then
  echo "Node 22+ is required (found $(node -v))" >&2
  exit 1
fi

# The demo app is dependency-free. Stacks with dependencies install them here
# (npm ci, or the Maven/Gradle equivalent).
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
fi

# Interactive environments (Codespaces) also get the Copilot CLI, which loads
# the factory cockpit from .github/extensions.
if [ "${FACTORY_INSTALL_COPILOT_CLI:-false}" = "true" ] && ! command -v copilot >/dev/null; then
  npm install -g @github/copilot --no-audit --no-fund
fi
