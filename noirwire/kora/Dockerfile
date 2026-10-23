# Kora fee relayer, the default image. Pinned by digest: v2.2.0-beta.8, linux/amd64 and linux/arm64 manifest list.
FROM ghcr.io/solana-foundation/kora:v2.2.0-beta.8@sha256:1b929cd9b32e6a3dddb646669fbe0d30651e07377b2bface044cd84289df59bf
WORKDIR /app
# Only the nonsecret signer template is baked in. A real signers.toml is never copied into the image.
COPY kora.toml ./
COPY signers.template.toml ./signers.toml
# Shell form so the platform's PORT is honoured. RPC_URL, KORA_PRIVATE_KEY, KORA_API_KEY, KORA_HMAC_SECRET,
# JUPITER_API_KEY and RUST_LOG come from the service's variables. The service refuses to start unless
# both auth secrets and the fee payer key are set.
CMD for v in KORA_API_KEY KORA_HMAC_SECRET KORA_PRIVATE_KEY; do eval "val=\${$v}"; [ -n "$val" ] || { echo "refusing to start: $v is empty" >&2; exit 1; }; done; exec kora --config /app/kora.toml rpc start --signers-config /app/signers.toml --port ${PORT:-8080}
