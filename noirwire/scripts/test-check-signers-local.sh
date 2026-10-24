#!/usr/bin/env bash
# Runs check-signers-local.sh against synthetic fixtures and asserts the exit codes.
#
#   noirwire/scripts/test-check-signers-local.sh

set -u

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
check="$script_dir/check-signers-local.sh"
data="$script_dir/testdata"
failures=0

expect() { # name, expected exit code, file
  "$check" "$3" >/dev/null
  actual=$?
  if [ "$actual" -eq "$2" ]; then
    echo "PASS  $1 (exit $actual)"
  else
    echo "FAIL  $1 (expected exit $2, got $actual)"
    failures=$((failures + 1))
  fi
}

expect "memory-only file passes" 0 "$data/fixture-signers-memory.toml"
expect "turnkey signer fails" 1 "$data/fixture-signers-turnkey.toml"
expect "file with no signers fails" 1 "$data/fixture-signers-empty.toml"
expect "missing file fails" 1 "$data/fixture-does-not-exist.toml"
expect "a hash inside the quoted type fails" 1 "$data/fixture-signers-hash.toml"

if "$check" "$data/fixture-signers-hash.toml" | grep -q "FIXTURE_SECRET"; then
  echo "FAIL  a rejected value was printed"
  failures=$((failures + 1))
else
  echo "PASS  a rejected value is never printed"
fi

[ "$failures" -eq 0 ]
