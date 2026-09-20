#!/usr/bin/env bash
# Copy Claude Code session transcripts somewhere Claude Code does not manage.
#
# Written after a 233 MB transcript disappeared from
# ~/.claude-personal/projects between 2026-09-16 and 2026-09-20. Nothing here
# deleted it; it was the largest session on the machine and then it was gone.
#
# Two reasons this matters beyond sentiment. The measurement scripts in this
# repo read these files, so a vanished transcript silently changes a published
# number — false-accusation-rate.ts prints a sha256 per input for exactly that
# reason. And a report's hash only proves it matches the file it read; if the
# file is gone, the receipt cannot be checked against anything.
#
# Additive by design: --ignore-existing never overwrites and never deletes, so
# a rotation upstream cannot propagate here. That also means the mirror grows
# and is never pruned, which is the intended trade.
#
# Usage:   bash scripts/backup-transcripts.sh [destination]
# Default: ~/Documents/claude-transcripts
set -uo pipefail

DEST="${1:-$HOME/Documents/claude-transcripts}"
mkdir -p "$DEST"

copied=0
skipped=0
bytes=0

for root in "$HOME"/.claude*/projects; do
  [ -d "$root" ] || continue
  # Employer sessions are included here deliberately — this is a local backup
  # on Shilpa's own machine, not a published artefact. Nothing in this script
  # sends anything anywhere.
  while IFS= read -r src; do
    rel="${src#"$HOME"/}"
    out="$DEST/$rel"
    mkdir -p "$(dirname "$out")"
    if [ -f "$out" ] && [ "$(stat -f%z "$out")" -ge "$(stat -f%z "$src")" ]; then
      skipped=$((skipped + 1))
      continue
    fi
    cp "$src" "$out" && {
      copied=$((copied + 1))
      bytes=$((bytes + $(stat -f%z "$src")))
    }
  done < <(find "$root" -name '*.jsonl' -type f 2>/dev/null)
done

printf 'backed up %d transcripts (%.0f MB), %d already current\n' \
  "$copied" "$(echo "$bytes / 1048576" | bc -l)" "$skipped"
printf 'destination: %s  (total %s)\n' "$DEST" "$(du -sh "$DEST" 2>/dev/null | cut -f1)"
