#!/usr/bin/env bash
# Creates the sample issues from samples/issues.md in the current repository.
# Each "# Title" line starts an issue; the lines below it are the body.
# Usage: samples/create-issues.sh [--dry-run]
set -euo pipefail

file="$(dirname "$0")/issues.md"
dry_run=false
[ "${1:-}" = "--dry-run" ] && dry_run=true

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

python3 - "$file" "$tmp" <<'PY'
import re, sys, pathlib
text = pathlib.Path(sys.argv[1]).read_text()
out = pathlib.Path(sys.argv[2])
for i, chunk in enumerate(re.split(r"(?m)^# ", text)[1:], 1):
    title, _, body = chunk.partition("\n")
    (out / f"{i:02d}.title").write_text(title.strip())
    (out / f"{i:02d}.body").write_text(body.strip() + "\n")
PY

for t in "$tmp"/*.title; do
  n="$(basename "$t" .title)"
  title="$(cat "$t")"
  if $dry_run; then
    echo "would create: $title"
  else
    gh issue create --title "$title" --body-file "$tmp/$n.body"
  fi
done
