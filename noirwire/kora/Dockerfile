# Kora fee relayer, audited stable release. Pinned by digest: v2.0.5.
FROM ghcr.io/solana-foundation/kora:v2.0.5@sha256:6e575278f559762d673a02c668e6c96ec2c04a2691ab9a668475272c97cd4e9b
WORKDIR /app
COPY kora.toml signers.toml ./
# Shell form so the platform's PORT is honoured. RPC_URL, KORA_PRIVATE_KEY, KORA_API_KEY, KORA_HMAC_SECRET,
# JUPITER_API_KEY and RUST_LOG come from the service's variables.
CMD kora --config /app/kora.toml rpc start --signers-config /app/signers.toml --port ${PORT:-8080}
