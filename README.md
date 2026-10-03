<div align="center">
  <br />
  <img src="./noirwire/docs/assets/noirwire-mark.svg" alt="NoirWire" width="96" />
  <br />
  <br />

  <h3>NoirWire's Kora fork</h3>

  <br />

[![NoirWire relayer](https://github.com/Noirwire/relayer-noirwire/actions/workflows/noirwire.yml/badge.svg)](https://github.com/Noirwire/relayer-noirwire/actions/workflows/noirwire.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE.md)

  <br />
  <br />
</div>

**This is [NoirWire](https://noirwire.com)'s production fork of Kora**, the fee relayer behind
the wallet at [app.noirwire.com](https://app.noirwire.com). Kora's own code, below, is
unchanged.

- Everything NoirWire adds lives in [`noirwire/`](./noirwire/README.md), with its own
  `package.json`, lockfiles and `.gitignore`, so an upstream merge never touches it and it
  never conflicts with upstream. See `noirwire/docs/updating-from-upstream.md`.
- The relayer runs the **published Kora image**, pinned by digest, not a build from this
  source tree. Config, both Dockerfiles and why the default is a pre-release are in
  [`noirwire/README.md`](./noirwire/README.md).
- A small Node job in `noirwire/refill/` keeps the fee payer topped up with SOL bought from
  collected USDC.
- `noirwire/deploy.md` is the Railway deployment sequence, service by service.
- You are welcome to run your own relayer from this fork. NoirWire's hosted instance is not a
  public endpoint; it only answers NoirWire's own server.

**CI** (`.github/workflows/noirwire.yml`) lints and tests the refill job, builds both Kora
images and validates their configuration, and shellchecks `noirwire/scripts/`, on every push
and pull request touching `noirwire/`. A weekly, report-only job flags new upstream Kora
releases.

**Security:** found a way to make the relayer pay for something it should not, or to move the
payment wallet's funds? Email ph1l1ph@proton.me before publishing it, see `noirwire/README.md`,
"Security". Issues in Kora itself belong in [upstream's `SECURITY.md`](SECURITY.md).

Licensed under MIT, same as upstream: [LICENSE.md](LICENSE.md). Other NoirWire repositories:
[shared-noirwire](https://github.com/Noirwire/shared-noirwire),
[mobile-noirwire](https://github.com/Noirwire/mobile-noirwire). More at
[noirwire.com](https://noirwire.com).

<div align="center">
  <br />
  <img src="./kora.svg" alt="Kora" width="140" />
  <br />
  <br />
  
  <h3>Kora: Solana Signing Infrastructure</h3>
    
  <br />
  
[![Integration Tests](https://github.com/solana-foundation/kora/actions/workflows/integration.yml/badge.svg)](https://github.com/solana-foundation/kora/actions/workflows/integration.yml)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/solana-foundation/kora)
[![Crates.io](https://img.shields.io/crates/v/kora-cli.svg)](https://crates.io/crates/kora-cli)
[![npm](https://img.shields.io/npm/v/@solana/kora)](https://www.npmjs.com/package/@solana/kora)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

  <br />
  <br />
</div>

> **Branch Model (Mar 18, 2026):** `main` is the integration branch and may contain audited and unaudited commits. Audit status is tracked per commit/tag in [`audits/AUDIT_STATUS.md`](audits/AUDIT_STATUS.md). Stable production releases are published from tagged audited snapshots.

**Kora is your Solana signing infrastructure.** Enable gasless transactions where users pay fees in any token—USDC, BONK, or your app's native token—or handle any transaction signing that requires a trusted signer.

### Why Kora?

- **Better UX**: Users never need SOL  
- **Revenue Control**: Collect fees in USDC, your token, or anything else  
- **Production Ready**: Secure validation, rate limiting, monitoring built-in  
- **Easy Integration**: JSON-RPC API + TypeScript SDK  
- **Flexible Deployment**: Railway, Docker, or any cloud platform

### Architecture

- **Language**: Rust with TypeScript SDK
- **Protocol**: JSON-RPC 2.0  
- **Signers**: Solana Private Key, Turnkey, Privy, Openfort
- **Authentication**: API Key, HMAC, or none
- **Deployment**: Flexible deployment options (Docker, Railway, etc.) 

### Features

- Configurable validation rules and allowlists
- Full Token-2022 support with extension filtering
- Redis caching for improved performance
- Rate limiting and spend protection
- Secure key management (Turnkey, Privy, Vault, Openfort)
- HMAC and API key authentication
- Prometheus metrics and monitoring
- Enhanced fee payer protection policies

## Quick Start

Install Kora: 

```bash
cargo install kora-cli
```

Basic usage:

```bash
kora rpc [OPTIONS] # --help for full list of options
```

**[→ Full Documentation](https://launch.solana.com/docs/kora/getting-started)** - Learn how Kora works

**[→ Quick Start Guide](https://launch.solana.com/docs/kora/getting-started/quick-start)** - Get Kora running locally minutes

**[→ Node Operator Guide](https://launch.solana.com/docs/kora/operators)** - Run a paymaster


## TypeScript SDK

Kora provides a simple JSON-RPC interface:

```typescript
// Initialize Kora client
import { KoraClient } from '@solana/kora';
const kora = new KoraClient({ rpcUrl: 'http://localhost:8080' });

// Sign transaction as paymaster
const signed = await kora.signTransaction({ transaction });
```

**[→ API Reference](https://launch.solana.com/docs/kora/json-rpc-api)**

## Local Development

### Prerequisites

- [Just](https://github.com/casey/just) (command runner)
- Rust 1.86+
- Solana CLI 2.2+
- Node.js 20+ and pnpm (for SDK)

### Installation

```bash
git clone https://github.com/solana-foundation/kora.git
cd kora
just install
```

### Build

```bash
just build
```

### Running the Server

Basic usage:

```bash
kora rpc [OPTIONS]
```

Or for running with a test configuration, run:

```bash
just run
```

### Local Testing

And run all tests:

```bash
just test
```

## Repository Structure

```
kora/
├── crates/                   # Rust workspace
│   ├── kora-lib/             # Core library with RPC server (signers, validation, transactions)
│   └── kora-cli/             # Command-line interface and RPC server
├── sdks/                     # Client SDKs
│   └── ts/                   # TypeScript SDK
├── tests/                    # Integration tests
├── docs/                     # Documentation
│   ├── getting-started/      # Quick start guides
│   └── operators/            # Node operator documentation
├── justfile                  # Build and development commands
└── kora.toml                 # Example configuration
```

## Security Audit

Kora has been audited by [Runtime Verification](https://runtimeverification.com/). View the [audit report](audits/20251119_runtime-verification.pdf).

Audit status, audited-through commit, and the current unaudited delta are tracked in [audits/AUDIT_STATUS.md](audits/AUDIT_STATUS.md).

**Note:** Kora uses the `solana-keychain` package which has not been audited. Use at your own risk.



## Community & Support

- **Questions?** Ask on [Solana Stack Exchange](https://solana.stackexchange.com/) (use the `kora` tag)
- **Issues?** Report on [GitHub Issues](https://github.com/solana-foundation/kora/issues)
- **Operators:** Running Kora in production? Reach out to [@a_milz](https://x.com/a_milz) or [@dev_jodee](https://x.com/dev_jodee) on X to join our operator Slack channel for updates and support

## Other Resources

- [Kora CLI Crates.io](https://crates.io/crates/kora-cli) - Rust crate for running a Kora node
- [Kora Lib Crates.io](https://crates.io/crates/kora-lib) - Rust crate for the Kora library
- [@solana/kora](https://www.npmjs.com/package/@solana/kora) - TypeScript SDK for Kora

---

Built and maintained by the [Solana Foundation](https://solana.org).

Licensed under MIT. See [LICENSE](LICENSE) for details.
