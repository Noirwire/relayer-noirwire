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
# The file is parsed as TOML (Python's standard tomllib, 3.11 or later), so every spelling
# Kora accepts is read the way Kora reads it. Every entry of the top-level `signers` array
# must be a table whose `type` is exactly "memory". Only PASS or FAIL and signer numbers are
# printed, never a value, a parser message or any other text from the file, so nothing
# secret can leak into CI logs.

set -u

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
file="${1:-$script_dir/../kora/signers.toml}"

if [ ! -f "$file" ]; then
  echo "FAIL  signers file not found: $file"
  exit 1
fi

python3 -I -c '
import sys

try:
    import tomllib
except ImportError:
    print("FAIL  python 3.11 or later is needed to parse the signers file")
    sys.exit(1)

LOCAL_TYPE = "memory"

try:
    with open(sys.argv[1], "rb") as handle:
        config = tomllib.load(handle)
except Exception:
    print("FAIL  the signers file is not valid TOML")
    sys.exit(1)

signers = config.get("signers")
if not isinstance(signers, list) or not signers:
    print("FAIL  no signers defined")
    sys.exit(1)

bad = 0
for number, signer in enumerate(signers, start=1):
    if not isinstance(signer, dict) or signer.get("type") != LOCAL_TYPE:
        print(f"FAIL  signer {number} is not type \"{LOCAL_TYPE}\"")
        bad += 1

if bad:
    sys.exit(1)
print(f"PASS  {len(signers)} signer(s), all type \"{LOCAL_TYPE}\"")
' "$file"
