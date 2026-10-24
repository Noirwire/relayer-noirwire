#!/usr/bin/env bash
# Runs check-tracker-hooks.sh against canned RPC responses and asserts the exit codes.
#
#   noirwire/scripts/test-check-tracker-hooks.sh

set -u

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
check="$script_dir/check-tracker-hooks.sh"
data="$script_dir/testdata"
mints="$data/fixture-hooks-mints.txt"
failures=0

expect() { # name, expected exit code, response fixture, optional text the output must contain
  output="$(RESPONSE_FILE="$data/$3" "$check" "$mints" 2>&1)"
  actual=$?
  if [ "$actual" -ne "$2" ]; then
    echo "FAIL  $1 (expected exit $2, got $actual)"
    failures=$((failures + 1))
  elif [ -n "${4:-}" ] && ! grep -q "$4" <<<"$output"; then
    echo "FAIL  $1 (output does not mention $4)"
    failures=$((failures + 1))
  else
    echo "PASS  $1 (exit $actual)"
  fi
}

expect "all clean passes" 0 fixture-hooks-clean.json
expect "a hook program set fails and names the mint" 1 fixture-hooks-program-set.json MintBbbb
expect "a changed hook authority fails and names the mint" 1 fixture-hooks-authority-changed.json MintBbbb
expect "a missing account fails and names the mint" 1 fixture-hooks-missing.json MintBbbb
expect "a mint without a transferHook extension fails and names the mint" 1 fixture-hooks-no-extension.json MintBbbb
expect "an RPC error object exits 2" 2 fixture-hooks-rpc-error.json
expect "malformed JSON exits 2" 2 fixture-hooks-malformed.json
expect "a missing response file exits 2" 2 fixture-hooks-does-not-exist.json

[ "$failures" -eq 0 ]
