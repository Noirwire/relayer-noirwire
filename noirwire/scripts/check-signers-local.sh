#!/usr/bin/env bash
# Fails unless every signer in a Kora signers file is the local in-memory ed25519 type.
#
#   noirwire/scripts/check-signers-local.sh [path/to/signers.toml]
#
# The default path is noirwire/kora/signers.toml, relative to this script. The cargo-audit
# ignore for RUSTSEC-2026-0387 (.cargo/audit.toml) is only honest while no custodial signer
# (Turnkey, Dfns, Openfort, CDP, KMS and the rest) is configured, because those are the code
# paths that use the affected P-256 and JWT crypto.
#
# The schema is simple (an array of [[signers]] tables, each with a `type = "..."` key), so
# the file is read line by line. A type line passes only when it is exactly `type = "memory"`
# or `type = 'memory'` with an optional trailing comment; any other spelling fails, which is
# the safe direction.
# Only PASS or FAIL and signer numbers are printed, never a value or any other text from the
# file, so nothing secret can leak into CI logs.

set -u

LOCAL_TYPE="memory"
TYPE_KEY='^type[[:space:]]*='
LOCAL_TYPE_LINE="^type[[:space:]]*=[[:space:]]*(\"$LOCAL_TYPE\"|'$LOCAL_TYPE')[[:space:]]*(#.*)?$"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
file="${1:-$script_dir/../kora/signers.toml}"

if [ ! -f "$file" ]; then
  echo "FAIL  signers file not found: $file"
  exit 1
fi

signers=0
bad=0
in_signer=0
has_type=0
untyped=0

close_signer() {
  if [ "$in_signer" -eq 1 ] && [ "$has_type" -eq 0 ]; then
    untyped=$((untyped + 1))
  fi
}

while IFS= read -r line || [ -n "$line" ]; do
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  header="${line%%#*}"
  header="${header%"${header##*[![:space:]]}"}"
  case "$header" in
    "[[signers]]")
      close_signer
      in_signer=1
      has_type=0
      signers=$((signers + 1))
      continue
      ;;
    "["*)
      close_signer
      in_signer=0
      continue
      ;;
  esac
  if [ "$in_signer" -eq 1 ] && [[ "$line" =~ $TYPE_KEY ]]; then
    has_type=1
    if ! [[ "$line" =~ $LOCAL_TYPE_LINE ]]; then
      echo "FAIL  signer $signers is not type \"$LOCAL_TYPE\""
      bad=$((bad + 1))
    fi
  fi
done <"$file"
close_signer

if [ "$signers" -eq 0 ]; then
  echo "FAIL  no signers defined"
  exit 1
fi
if [ "$untyped" -gt 0 ]; then
  echo "FAIL  $untyped signer(s) without a type"
  exit 1
fi
if [ "$bad" -gt 0 ]; then
  exit 1
fi

echo "PASS  $signers signer(s), all type \"$LOCAL_TYPE\""
