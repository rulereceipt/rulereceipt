#!/usr/bin/env bash
# Fetches the real public rule files listed in rule_file_corpus.md into
# corpus/ for the classifier regression run (scripts/corpus-report.ts).
#
# Both rule_file_corpus.md and corpus/ are gitignored on purpose: they're
# copies of other projects' files, not ours to redistribute in a public
# repo. This script IS committed so the run is reproducible by anyone who
# builds their own corpus list.
#
# Usage: bash scripts/fetch-corpus.sh [max_files]   (default 60)
set -uo pipefail

CORPUS_LIST="rule_file_corpus.md"
OUT_DIR="corpus"
MAX="${1:-60}"

[ -f "$CORPUS_LIST" ] || { echo "missing $CORPUS_LIST"; exit 1; }
mkdir -p "$OUT_DIR"

fetched=0
skipped=0
failed=0

while read -r url; do
  [ "$fetched" -ge "$MAX" ] && break
  # github.com/OWNER/REPO/blob/SHA/PATH -> raw.githubusercontent.com/OWNER/REPO/SHA/PATH
  # (sed, not bash substitution: the bash form silently left a literal
  # backslash in the URL and every fetch 404'd — caught by getting 0 files)
  raw="$(echo "$url" | sed -e 's#//github\.com/#//raw.githubusercontent.com/#' -e 's#/blob/#/#')"
  # flat, collision-free local name derived from the URL path
  name="$(echo "${url#https://github.com/}" | tr '/' '_')"
  target="$OUT_DIR/$name"

  if [ -s "$target" ]; then
    skipped=$((skipped + 1))
    continue
  fi

  if curl -sfL --max-time 20 "$raw" -o "$target" && [ -s "$target" ]; then
    fetched=$((fetched + 1))
  else
    rm -f "$target"
    failed=$((failed + 1))
  fi
done < <(grep "^https://github.com" "$CORPUS_LIST")

echo "fetched=$fetched already_present=$skipped failed=$failed total_in_corpus_dir=$(ls -1 "$OUT_DIR" | wc -l | tr -d ' ')"
