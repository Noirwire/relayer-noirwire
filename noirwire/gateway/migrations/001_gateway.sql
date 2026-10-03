-- State of the gateway. Apply once per database:
--   psql "$DATABASE_URL" -f migrations/001_gateway.sql
--
-- Customers are not here: they are loaded from the customers file at start.
-- Amounts are whole micro-USDC. Times are unix milliseconds, as the service's clock gives them.

BEGIN;

-- One row per prepared transaction. The row is also the idempotency record of /v1/sign: a
-- quote leaves "prepared" at most once, and its final state answers every later request.
CREATE TABLE gateway_quotes (
    id                      text    PRIMARY KEY,
    customer_id             text    NOT NULL,
    -- SHA-256 of the prepared message, hex. The transaction itself is never stored.
    message_hash            text    NOT NULL CHECK (message_hash ~ '^[0-9a-f]{64}$'),
    network_cost_micro_usdc bigint  NOT NULL CHECK (network_cost_micro_usdc >= 0),
    platform_micro_usdc     bigint  NOT NULL CHECK (platform_micro_usdc >= network_cost_micro_usdc),
    customer_micro_usdc     bigint  NOT NULL CHECK (customer_micro_usdc >= 0),
    created_at_ms           bigint  NOT NULL,
    expires_at_ms           bigint  NOT NULL CHECK (expires_at_ms > created_at_ms),
    state                   text    NOT NULL DEFAULT 'prepared'
                                    CHECK (state IN ('prepared', 'signing', 'sent', 'failed', 'unknown')),
    claimed_at_ms           bigint,
    signature               text,
    code                    text
);

-- What each customer has used per UTC day. Rows are only ever written by the single
-- statement in src/store/postgres.mjs that checks the limits and adds in one step.
CREATE TABLE gateway_budgets (
    customer_id             text    NOT NULL,
    day                     date    NOT NULL,
    transactions            integer NOT NULL CHECK (transactions >= 0),
    network_cost_micro_usdc bigint  NOT NULL CHECK (network_cost_micro_usdc >= 0),
    PRIMARY KEY (customer_id, day)
);

COMMIT;
