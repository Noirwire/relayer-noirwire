#!/usr/bin/env bash
# Fails when any tracker mint stops looking the way the relayer's transfer hook policy assumes.
#
#   noirwire/scripts/check-tracker-hooks.sh [path/to/tracker-mints.txt]
#
# kora.toml runs with transfer_hook_policy = "allow_all" so the relayer can co-sign sends of
# the Token-2022 tracker mints. That is only safe while every mint has the TransferHook
# extension with the expected authority and NO hook program. The issuer can change either at
# any time, so this reads every mint from chain and fails on the first sign of a change.
#
# Exit codes: 0 every mint is as expected, 1 at least one mint changed or is missing,
# 2 the check itself could not run (RPC or parse failure). A failed read is never a pass.
#
# Environment:
#   RPC_URL        JSON-RPC endpoint (default: the public mainnet-beta endpoint)
#   RESPONSE_FILE  read the getMultipleAccounts response from this file instead of the RPC
#                  (used by the tests)

set -u

EXPECTED_HOOK_AUTHORITY="5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq"
TOKEN_2022_PROGRAM="TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
DEFAULT_RPC_URL="https://api.mainnet-beta.solana.com"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mints_file="${1:-$script_dir/../tracker-mints.txt}"
rpc_url="${RPC_URL:-$DEFAULT_RPC_URL}"

die() {
  echo "ERROR  $1"
  exit 2
}

command -v jq >/dev/null 2>&1 || die "jq is required"

[ -f "$mints_file" ] || die "mint list not found: $mints_file"

mints_json="$(grep -v '^[[:space:]]*#' "$mints_file" | tr -d ' \t\r' | grep -v '^$' | jq -R . | jq -s .)" ||
  die "could not read the mint list"
count="$(jq 'length' <<<"$mints_json")" || die "could not read the mint list"
[ "$count" -gt 0 ] || die "the mint list is empty"

if [ -n "${RESPONSE_FILE:-}" ]; then
  [ -f "$RESPONSE_FILE" ] || die "response file not found: $RESPONSE_FILE"
  response="$(cat "$RESPONSE_FILE")" || die "could not read the response file"
else
  request="$(jq -n --argjson mints "$mints_json" \
    '{jsonrpc: "2.0", id: 1, method: "getMultipleAccounts",
      params: [$mints, {encoding: "jsonParsed", commitment: "finalized"}]}')" ||
    die "could not build the RPC request"
  response="$(curl --silent --show-error --fail --max-time 30 --retry 2 \
    -H 'Content-Type: application/json' -d "$request" "$rpc_url")" ||
    die "the RPC request failed ($rpc_url)"
fi

if ! jq -e . >/dev/null 2>&1 <<<"$response"; then
  die "the RPC response is not valid JSON"
fi

if jq -e 'type == "object" and has("error")' >/dev/null 2>&1 <<<"$response"; then
  die "the RPC returned an error: $(jq -c '.error' <<<"$response" | cut -c1-300)"
fi

if ! jq -e --argjson count "$count" \
  '(.result.value | type) == "array" and (.result.value | length) == $count' \
  >/dev/null 2>&1 <<<"$response"; then
  die "the RPC response does not hold $count accounts"
fi

problems="$(jq -r --argjson mints "$mints_json" \
  --arg authority "$EXPECTED_HOOK_AUTHORITY" --arg program "$TOKEN_2022_PROGRAM" '
  .result.value as $accounts
  | range(0; $mints | length) as $i
  | $mints[$i] as $mint
  | $accounts[$i] as $account
  | if $account == null then
      "FAIL  \($mint)  account is missing"
    elif $account.owner != $program then
      "FAIL  \($mint)  owner is not Token-2022"
    else
      ((try $account.data.parsed.info.extensions catch null) // [])
      | map(select(type == "object" and .extension == "transferHook"))
      | first // null
      | if . == null then
          "FAIL  \($mint)  no transferHook extension"
        else
          (if .state.authority != $authority then
             "FAIL  \($mint)  hook authority changed to \(.state.authority | tostring)"
           else empty end),
          (if .state.programId != null then
             "FAIL  \($mint)  hook program is set: \(.state.programId | tostring)"
           else empty end)
        end
    end
' <<<"$response")" || die "could not parse the RPC response"

if [ -n "$problems" ]; then
  echo "$problems"
  bad="$(grep -c '^FAIL' <<<"$problems")"
  echo "FAIL  $bad problem(s) across $count mint(s); see README, transfer hook policy"
  exit 1
fi

echo "PASS  $count mint(s), all Token-2022 with a transferHook extension, authority $EXPECTED_HOOK_AUTHORITY, no hook program"
