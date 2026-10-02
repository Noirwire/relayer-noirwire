#!/usr/bin/env bash
# Checks a deployed Kora service: that it is up, and that it refuses callers without credentials.
#
#   KORA_URL=https://<your-domain> ./scripts/check-deploy.sh
#   KORA_URL=... KORA_API_KEY=... KORA_HMAC_SECRET=... ./scripts/check-deploy.sh
#
# With the two secrets set it also proves they work and that one alone is not enough, and
# asks Kora which fee payer it signs with. Set FEE_PAYER (and PAYMENT_WALLET) to the addresses
# you intend to give the refill job and the app, and the script fails if Kora reports others:
#
#   KORA_URL=... KORA_API_KEY=... KORA_HMAC_SECRET=... FEE_PAYER=... PAYMENT_WALLET=... ./scripts/check-deploy.sh
#
# Nothing secret is ever printed, and no secret is ever placed on a command line: the HMAC is
# computed by `node`, which reads the secret from the environment. curl receives the API key
# and signature through a header file on stdin. Exit code 0 only when every check passes.

set -u

KORA_URL="${KORA_URL:-${1:-}}"
if [ -z "$KORA_URL" ]; then
  echo "usage: KORA_URL=https://<your-domain> [KORA_API_KEY=... KORA_HMAC_SECRET=...] $0" >&2
  exit 2
fi
KORA_URL="${KORA_URL%/}"
failures=0

report() { # name, expected, actual
  if [ "$2" = "$3" ]; then
    echo "PASS  $1 (HTTP $3)"
  else
    echo "FAIL  $1 (expected HTTP $2, got ${3:-no answer})"
    failures=$((failures + 1))
  fi
}

body_for() { printf '{"jsonrpc":"2.0","id":1,"method":"%s"}' "$1"; }

# Kora's scheme: hex(HMAC-SHA256(secret, timestamp + exact body)). The secret comes from the
# environment and the message from stdin, so neither is visible in the process list.
hmac() { node -e 'const c=require("crypto");let d="";process.stdin.on("data",x=>d+=x).on("end",()=>process.stdout.write(c.createHmac("sha256",process.env.KORA_HMAC_SECRET).update(d).digest("hex")))'; }

# call <method> <mode> [curl output args...]; mode is none, key, hmac or both.
call() {
  method="$1"; mode="$2"; shift 2
  body="$(body_for "$method")"
  timestamp="$(date +%s)"
  {
    echo 'content-type: application/json'
    case "$mode" in key|both) echo "x-api-key: $KORA_API_KEY" ;; esac
    case "$mode" in hmac|both)
      echo "x-timestamp: $timestamp"
      echo "x-hmac-signature: $(printf '%s%s' "$timestamp" "$body" | hmac)" ;;
    esac
  } | curl -s -m 15 -X POST "$KORA_URL" -H @- -d "$body" "$@"
}
status_of() { call "$1" "$2" -o /dev/null -w '%{http_code}'; }

report "liveness answers without credentials" 200 \
  "$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$KORA_URL/liveness")"
report "getConfig without credentials is refused" 401 "$(status_of getConfig none)"

if [ -z "${KORA_API_KEY:-}" ] || [ -z "${KORA_HMAC_SECRET:-}" ]; then
  echo "SKIP  authenticated checks (set KORA_API_KEY and KORA_HMAC_SECRET to run them)"
elif ! command -v node >/dev/null 2>&1; then
  echo "FAIL  authenticated checks need node to compute the HMAC without exposing the secret"
  failures=$((failures + 1))
else
  export KORA_HMAC_SECRET
  report "getConfig with the API key alone is refused" 401 "$(status_of getConfig key)"
  report "getConfig with the HMAC signature alone is refused" 401 "$(status_of getConfig hmac)"
  accepted="$(status_of getConfig both)"
  report "getConfig with both credentials is accepted" 200 "$accepted"

  if [ "$accepted" = 200 ]; then
    field() { printf '%s' "$1" | grep -o "\"$2\":[^,}]*" | head -1; }
    # The settings that matter, as the running server reports them. No secret is in these answers.
    config="$(call getConfig both)"
    for name in margin max_allowed_lamports max_signatures allow_create_account price_source; do
      value="$(field "$config" "$name")"
      echo "INFO  ${value:-\"$name\": not reported}"
    done

    # Which key Kora really signs with, and where it collects payments. The refill job sends
    # SOL to FEE_PAYER and nowhere else, so that variable must be this address.
    signer="$(call getPayerSigner both)"
    signer_address="$(field "$signer" signer_address | sed 's/.*:"\(.*\)"/\1/')"
    payment_address="$(field "$signer" payment_address | sed 's/.*:"\(.*\)"/\1/')"
    echo "INFO  Kora signs as fee payer ${signer_address:-(not reported)}"
    echo "INFO  Kora collects payments at ${payment_address:-(not reported)}"
    compare() { # label, intended, reported
      if [ -z "$2" ]; then
        echo "SKIP  $1 not given, so not compared"
      elif [ "$2" = "$3" ]; then
        echo "PASS  $1 is the address Kora reports"
      else
        echo "FAIL  $1 is $2 but Kora reports ${3:-nothing}"
        failures=$((failures + 1))
      fi
    }
    compare FEE_PAYER "${FEE_PAYER:-}" "$signer_address"
    compare PAYMENT_WALLET "${PAYMENT_WALLET:-}" "$payment_address"
  fi
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
