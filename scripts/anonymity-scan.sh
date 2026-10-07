#!/usr/bin/env bash
#
# Anonymity and secret scan for a public repository.
#
# Scans the working tree and the full git history for information that must not
# be published: a supplied deny-list of names, email addresses, IP addresses,
# internal hostnames, secret-like strings, and issue identifiers.
#
# The deny-list is provided out of band through the ANON_DENYLIST environment
# variable as a comma separated list. It is never stored in this repository.
#
# Usage:
#   ANON_DENYLIST="name-one,name-two" scripts/anonymity-scan.sh
#
# Exit status:
#   0  clean
#   1  one or more findings
#   2  not inside a git working tree

set -uo pipefail

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "anonymity-scan: not inside a git working tree" >&2
  exit 2
fi

denylist="${ANON_DENYLIST:-}"

# Uppercase prefixes that look like issue identifiers but are benign.
benign_prefixes="RFC|ISO|CVE|UTF|SHA|HTTP|HTTPS|TCP|UDP|TLS|WSS|WS|API|URL|URI|UUID|JSON|YAML|TOML|AGPL|GPL|LGPL|MIT|SQL|DOM|CSS|HTML|XML|CSV|PDF|PNG|JPEG|ID|IP|OS|UI|CLI|SDK"

patterns_file="$(mktemp)"
trap 'rm -f "$patterns_file"' EXIT

{
  # Secret-like strings.
  echo '(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'
  # Email addresses other than safe example and noreply domains.
  echo '\b[A-Za-z0-9._%+-]+@(?!(example\.invalid|example\.com|users\.noreply\.github\.com|noreply\.github\.com)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b'
  # IPv4 addresses other than loopback, unspecified, and broadcast.
  echo '\b(?!127\.0\.0\.1\b|0\.0\.0\.0\b|255\.255\.255\.255\b)(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}\b'
  # Internal hostname suffixes.
  echo '\b[A-Za-z0-9-]+\.(internal|local|lan|corp|intranet|private|home)\b'
  # Issue identifiers other than benign prefixes.
  echo "\b(?!(?:${benign_prefixes})-)[A-Z][0-9A-Z]{1,9}-[0-9]{1,6}\b"
  # Deny-list terms, case insensitive.
  if [ -n "$denylist" ]; then
    IFS=',' read -ra terms <<< "$denylist"
    for term in "${terms[@]}"; do
      term="${term#"${term%%[![:space:]]*}"}"
      term="${term%"${term##*[![:space:]]}"}"
      [ -z "$term" ] && continue
      esc="$(printf '%s' "$term" | sed 's/[][\\.^$*+?(){}|]/\\&/g')"
      echo "(?i)${esc}"
    done
  fi
} > "$patterns_file"

findings=""

# Working tree: tracked and untracked files, excluding ignored paths.
mapfile -t tree_files < <(git ls-files --cached --others --exclude-standard)
if [ "${#tree_files[@]}" -gt 0 ]; then
  tree_hits="$(grep -n -I -H -P -f "$patterns_file" -- "${tree_files[@]}" 2>/dev/null || true)"
  if [ -n "$tree_hits" ]; then
    findings="${findings}${tree_hits}"$'\n'
  fi
fi

# Full git history, per commit.
if git rev-parse --verify HEAD >/dev/null 2>&1; then
  while IFS= read -r sha; do
    [ -z "$sha" ] && continue
    hist_hits="$(git grep -n -I -P -f "$patterns_file" "$sha" -- 2>/dev/null | sed "s|^|${sha}:|" || true)"
    if [ -n "$hist_hits" ]; then
      findings="${findings}${hist_hits}"$'\n'
    fi
  done < <(git rev-list --all)
fi

findings="$(printf '%s' "$findings" | sed '/^$/d')"

if [ -n "$findings" ]; then
  echo "anonymity-scan: FAIL"
  echo "$findings"
  echo "anonymity-scan: remove the offending content, or rewrite history if it was already pushed"
  exit 1
fi

echo "anonymity-scan: PASS (working tree and history clean)"
exit 0
