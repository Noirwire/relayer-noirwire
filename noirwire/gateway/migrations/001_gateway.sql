-- State of the gateway. Apply once per database:
--   psql "$DATABASE_URL" -f migrations/001_gateway.sql
--
-- Customers are not here: they are loaded from the customers file at start.
-- Amounts are whole micro-USDC. Times are unix milliseconds, as the service's clock gives them.

BEGIN;

-- One row per prepared transaction. The row is also the idempotency record of /v1/sign: a
-- quote leaves "prepared" at most once, and its state answers every later request. The
-- states are described in src/store/memory.mjs.
CREATE TABLE gateway_quotes (
    id                      text    PRIMARY KEY,
    customer_id             text    NOT NULL,
    -- SHA-256 of the prepared message, hex. The transaction itself is never stored.
    message_hash            text    NOT NULL CHECK (message_hash ~ '^[0-9a-f]{64}$'),
    -- SHA-256 of the source token account's address, hex. The address itself is never stored.
    source_hash             text    NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
    -- The last block height at which the transaction's blockhash is valid.
    last_valid_block_height bigint  NOT NULL CHECK (last_valid_block_height >= 0),
    network_cost_micro_usdc bigint  NOT NULL CHECK (network_cost_micro_usdc >= 0),
    platform_micro_usdc     bigint  NOT NULL CHECK (platform_micro_usdc >= network_cost_micro_usdc),
    customer_micro_usdc     bigint  NOT NULL CHECK (customer_micro_usdc >= 0),
    created_at_ms           bigint  NOT NULL,
    expires_at_ms           bigint  NOT NULL CHECK (expires_at_ms > created_at_ms),
    state                   text    NOT NULL DEFAULT 'prepared'
                                    CHECK (state IN ('prepared', 'signing', 'signed', 'sent', 'unknown',
                                                     'failed', 'landed', 'failed_on_chain', 'expired')),
    claimed_at_ms           bigint,
    -- The transaction signature, written before the transaction is broadcast. Only here,
    -- never in a log: with it anyone can read the user's and the recipient's addresses.
    signature               text,
    code                    text
);

-- At most one unsettled transaction per source token account, whatever the customer. The
-- claim in src/store/postgres.mjs relies on this index to refuse a second one.
CREATE UNIQUE INDEX gateway_quotes_one_unsettled_per_source
    ON gateway_quotes (source_hash)
    WHERE state IN ('signing', 'signed', 'sent', 'unknown');

-- The customer's oldest unsettled quotes, settled a few at a time on its next prepare.
CREATE INDEX gateway_quotes_unsettled_by_customer
    ON gateway_quotes (customer_id, claimed_at_ms)
    WHERE state IN ('signing', 'signed', 'sent', 'unknown');

-- The count of a customer's open quotes on every prepare.
CREATE INDEX gateway_quotes_open_by_customer
    ON gateway_quotes (customer_id, expires_at_ms)
    WHERE state = 'prepared';

-- The two bounded cleanups that run after every prepare.
CREATE INDEX gateway_quotes_prepared_by_expiry
    ON gateway_quotes (expires_at_ms)
    WHERE state = 'prepared';
CREATE INDEX gateway_quotes_closed_by_age
    ON gateway_quotes (created_at_ms)
    WHERE state <> 'prepared';

-- What each customer has used per UTC day. Rows are written by the statement in
-- src/store/postgres.mjs that checks the limits and adds in one step, and lowered only by
-- the refund of a claim that ended before anything was signed.
CREATE TABLE gateway_budgets (
    customer_id             text    NOT NULL,
    day                     date    NOT NULL,
    transactions            integer NOT NULL CHECK (transactions >= 0),
    network_cost_micro_usdc bigint  NOT NULL CHECK (network_cost_micro_usdc >= 0),
    PRIMARY KEY (customer_id, day)
);

-- Transactions of a customer that failed on chain after the relayer signed them. At the
-- configured threshold the customer is paused until an operator deletes the row
-- (scripts/reset-failures.mjs).
CREATE TABLE gateway_failures (
    customer_id             text    PRIMARY KEY,
    failed_on_chain         integer NOT NULL CHECK (failed_on_chain >= 0)
);

-- Requests per customer in the current one-minute window, shared by every process.
-- window_start is unix minutes.
CREATE TABLE gateway_rate_windows (
    customer_id             text    PRIMARY KEY,
    window_start            bigint  NOT NULL,
    requests                integer NOT NULL CHECK (requests >= 1)
);

COMMIT;
