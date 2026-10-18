# Quoin

**A social marketplace where clients consult Quantity Surveyors, compare construction rates, and get AI-assisted estimates, with every rate, estimate, and payment sealed on the Stellar Network.**

Browse verified QS profiles, ask questions in public threads, book paid consultations in XLM or Stellar USDC, and track live construction rates by region. Every estimate is cryptographically sealed on-chain, and when the project finishes, the QS's accuracy is scored against real costs.

![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Network: Stellar](https://img.shields.io/badge/Network-Stellar-blue) ![Contracts: Soroban](https://img.shields.io/badge/Contracts-Soroban-purple) ![Monorepo: pnpm](https://img.shields.io/badge/Monorepo-pnpm-orange) ![Build: Turborepo](https://img.shields.io/badge/Build-Turborepo-red)

---

## What is Quoin?

A *quoin* is the cornerstone at the corner of a wall, the stone every other course is aligned to. Quoin is the trust layer under construction cost advice.

Today, finding a good Quantity Surveyor (QS) and knowing whether their rates are fair is mostly word of mouth. Rates are private, estimates can't be audited, and clients have no way to tell an accurate QS from a confident one.

| Gap in today's market | Quoin's answer |
|---|---|
| Rates are opaque and negotiated blind | Public, on-chain **Rate Cards** per QS, comparable by region and work type |
| No way to verify a QS's credentials or track record | On-chain credential attestations plus a per-QS **Accuracy Score** |
| Estimates can be quietly revised after the fact | **Estimate Seal**: every BoQ is hash-anchored on Stellar with a timestamp |
| Cross-border payment friction and disputes | Milestone **escrow** in XLM or Stellar USDC, settled in about 5 seconds |
| Slow, manual takeoffs and BoQ drafting | **Quoin Copilot** (AI) drafts quantities and benchmarks rates |
| Material prices go stale between quarterly reports | **Rate Pulse**: a live, staked, peer-verified material and labour price index |

---

## Core Features

### Social and Marketplace
- QS profiles with specialisations (residential, civil, MEP, roads, fit-out), credentials, and portfolio
- Public Q&A feed where clients post cost questions and QSs answer, with upvotes, follows, and reputation
- Private consultations via chat or call, paid per session or per milestone
- Side-by-side rate comparison across QSs, regions, and work categories
- Reviews tied to completed on-chain engagements, so only real clients can review

### AI Features (Quoin Copilot)
| Feature | What it does |
|---|---|
| **Smart BoQ Drafting** | Upload drawings or a plain-language brief. Copilot extracts quantities and drafts a Bill of Quantities for the QS to review |
| **Rate Benchmarking** | Flags any line item priced outside the regional norm, with the Rate Pulse data as evidence |
| **Client Cost Advisor** | A chat assistant that gives clients a ballpark range, explains construction terms, and recommends suitable QSs |
| **Anomaly and Fraud Detection** | Detects inflated quantities, copy-pasted estimates, and suspicious review patterns |
| **QS Match** | Ranks QSs by project type, budget, location, and Accuracy Score |

AI output is always labelled as a draft. A human QS signs off before anything is sealed.

### Unique Feature 1: Estimate Seal + Accuracy Score
When a QS finalises a BoQ, Quoin hashes it and writes the hash, timestamp, and total to the `EstimateSeal` contract. The estimate can no longer be silently changed.

When the project completes, the client submits the final cost (confirmed by the escrow milestones). The `AccuracyScore` contract compares the estimate to the actual cost and updates the QS's public, tamper-evident score.

> A QS who is repeatedly within 3% of final cost earns a score no marketing can fake.

### Unique Feature 2: Rate Pulse
A community-verified, staked price index for construction inputs: cement, sand, steel, blocks, timber, plumbing, electrical, and labour trades, by city and country.

- QSs submit observed prices and stake XLM behind them
- Peer QSs cross-verify. Honest submissions earn Stellar USDC micro-rewards, and outliers or fraud are slashed
- The result is a daily regional index that feeds Copilot's benchmarking and is open to anyone through the API

---

## Monorepo Structure

```
quoin/
├── packages/
│   ├── contracts/      # @quoin/contracts  - Soroban smart contracts (Rust)
│   ├── copilot/        # @quoin/copilot    - AI service: BoQ drafting, benchmarking, advisor (TypeScript + Python workers)
│   ├── pulse/          # @quoin/pulse      - Rate Pulse oracle daemon and aggregation node (TypeScript)
│   ├── api/            # @quoin/api        - Public REST + GraphQL API (Node.js)
│   └── hub/            # @quoin/hub        - Client and QS social app (Next.js)
├── docs/               # Architecture, methodology, accuracy-score formula, API reference
├── scripts/            # Testnet bootstrap, seed data, deploy helpers
├── audits/             # Smart contract audit reports
├── pnpm-workspace.yaml
├── turbo.json
└── README.md           <- you are here
```

---

## Packages

### @quoin/contracts
Soroban smart contracts in Rust, deployable to Stellar Testnet and Mainnet.

| Contract | Purpose |
|---|---|
| `QSRegistry` | QS identity, credential attestations (e.g. professional body membership), specialisations |
| `RateCard` | Each QS's published rates by work category and region, versioned and timestamped |
| `ConsultEscrow` | Holds XLM or USDC for consultations and milestones, releases on client approval, supports dispute resolution |
| `EstimateSeal` | Anchors the hash, total, and timestamp of every finalised BoQ |
| `AccuracyScore` | Compares sealed estimates to actual final costs and maintains each QS's score |
| `RatePulseVault` | Stores staked material and labour price submissions, handles verification and slashing |

```
packages/contracts/
├── src/
│   ├── qs_registry.rs
│   ├── rate_card.rs
│   ├── consult_escrow.rs
│   ├── estimate_seal.rs
│   ├── accuracy_score.rs
│   └── rate_pulse_vault.rs
├── tests/
├── Cargo.toml
└── README.md
```
**Stack:** Rust, Soroban SDK, Stellar CLI

### @quoin/copilot
The AI layer. Exposes BoQ drafting, rate benchmarking, the client advisor, and fraud detection to the app and API.

```
packages/copilot/
├── src/
│   ├── boq_drafter.ts      # Drawing/brief -> structured quantities
│   ├── benchmark.ts        # Compare line items vs Rate Pulse index
│   ├── advisor.ts          # Client cost-advice chat
│   ├── matcher.ts          # QS recommendation ranking
│   └── anomaly.ts          # Inflation / duplicate / review-fraud detection
├── workers/                # Python workers for drawing parsing
├── package.json
└── README.md
```
**Stack:** TypeScript, Python, LLM API, vector store for rate and BoQ retrieval

### @quoin/pulse
A lightweight daemon run by community nodes. Streams `RatePulseVault` events, collects peer verifications, computes the daily regional median with outlier filtering, and publishes the index.

```
packages/pulse/
├── src/
│   ├── listener.ts         # Horizon event streaming
│   ├── aggregator.ts       # Median + outlier filtering per region/material
│   ├── submitter.ts        # Soroban contract invocation
│   └── metrics.ts          # Prometheus exporter
├── Dockerfile
└── package.json
```
**Stack:** TypeScript, @stellar/stellar-sdk, Horizon API, Docker, Prometheus

### @quoin/api
Public read layer plus authenticated actions.

```
GET   /v1/qs                              Search and filter QSs
GET   /v1/qs/:id                          Profile, rate card, Accuracy Score
GET   /v1/qs/:id/estimates                Sealed estimates (hash + outcome)
GET   /v1/rates?region=&category=         Compare QS rate cards
GET   /v1/pulse/:region                   Latest Rate Pulse index
GET   /v1/pulse/:region/history?from=&to= Historical index
POST  /v1/consultations                   Book a consultation (wallet auth)
POST  /v1/copilot/boq                     Draft a BoQ with AI (wallet auth)
POST  /v1/estimates/seal                  Seal a finalised estimate (QS wallet)
```
**Stack:** Node.js, Fastify, GraphQL Yoga, PostgreSQL, Redis, @stellar/stellar-sdk

### @quoin/hub
The Next.js social app for clients and Quantity Surveyors.

| Route | Description |
|---|---|
| `/` | Feed of trending questions, new QSs, and Rate Pulse highlights |
| `/qs` | Search and filter surveyors |
| `/qs/:id` | Profile, rate card, Accuracy Score, reviews, sealed estimates |
| `/ask` | Post a cost question, or chat with Copilot first |
| `/consult/:id` | Booking, chat, and escrow status |
| `/compare` | Side-by-side rate comparison |
| `/pulse` | Regional material and labour price explorer |
| `/estimate` | Copilot BoQ drafting workspace for QSs |
| `/wallet` | Earnings, escrow, and payment history |

**Stack:** Next.js 14, TailwindCSS, @stellar/stellar-sdk, Freighter / LOBSTR / xBull wallet support, Recharts

---

## How It Works

```
Client                 Stellar Ledger                    Quantity Surveyor
  │                          │                                  │
  ├─ Browse / compare ──────▶ RateCard + AccuracyScore (read)   │
  ├─ Book consultation ─────▶ ConsultEscrow.lock()              │
  │                          │◀──────────── drafts BoQ w/ Copilot┤
  │                          │◀──────────── EstimateSeal.seal() ─┤  (hash + total)
  ├─ Approve milestone ─────▶ ConsultEscrow.release() ─────────▶ QS paid (XLM/USDC)
  │                          │                                  │
  ├─ Project completes ─────▶ AccuracyScore.record(actual_cost) │
  │                          │   -> QS Accuracy Score updated   │

Rate Pulse nodes
  ├─ Submit + stake ────────▶ RatePulseVault.submit()
  ├─ Peer-verify ───────────▶ RatePulseVault.verify()
  └─ Daily regional index ──▶ published on-chain, used by Copilot benchmarking
```

---

## Why Stellar?

- **Fast, low-fee payments.** Consultations can be small (a few dollars), which only works with near-zero fees.
- **Native stablecoin.** Stellar USDC protects both sides from volatility when quoting construction work.
- **Cross-border by default.** Clients and surveyors in different countries can transact without a bank intermediary.
- **Soroban smart contracts.** Escrow, sealing, and scoring logic is open, auditable, and forkable.
- **Wallet-only onboarding.** Works with any Stellar wallet on a basic smartphone.

---

## Token Economics

Quoin has no proprietary token. All value moves in Stellar-native assets.

| Action | Asset | Notes |
|---|---|---|
| Client pays for consultation | XLM or Stellar USDC | Held in escrow, released on approval |
| Platform fee | 2% of consultation value | Funds the treasury |
| QS submits a Rate Pulse price (verified) | Stellar USDC | ~$0.03 per verified entry |
| Peer verifies a Rate Pulse entry | Stellar USDC | ~$0.01 per correct vote |
| Pulse node operator (daily) | XLM | Small daily emission from treasury |
| Fraudulent or outlier submission | Stake slashed | Share goes to correct verifiers |

Treasury income comes from the platform fee and B2B licensing of the Rate Pulse dataset.

---

## Getting Started

### Prerequisites
- Node.js 20 or later
- pnpm 9 or later
- Rust stable and the Stellar CLI
- A funded Stellar Testnet account (create one with Stellar Laboratory or `stellar keys generate --fund`)
- API key for your chosen LLM provider (for `@quoin/copilot`)

### Install
```bash
git clone https://github.com/your-org/quoin.git
cd quoin
pnpm install
cp .env.example .env     # add Stellar keys + LLM key
```

### Run in development
```bash
pnpm dev                                     # everything via Turborepo
pnpm --filter @quoin/hub dev                # app only
pnpm --filter @quoin/pulse start:testnet    # Rate Pulse node on Testnet
```

### Test
```bash
cd packages/contracts && cargo test
pnpm turbo test
pnpm turbo lint
```

### Deploy contracts to Testnet
```bash
cd packages/contracts
stellar contract build
bash ../../scripts/deploy_testnet.sh
```

---

## Roadmap

| Phase | Milestone |
|---|---|
| 1 | Contracts (`QSRegistry`, `RateCard`, `ConsultEscrow`) and Testnet app with profiles and booking |
| 2 | `EstimateSeal`, Copilot BoQ drafting, rate comparison |
| 3 | `AccuracyScore` and review system tied to completed engagements |
| 4 | Rate Pulse oracle network, staking, and public index API |
| 5 | Mainnet launch, security audit, mobile-first PWA, regional expansion |

---

## Security

- Contract audit: pending, with reports to be published in `audits/`
- AI output is advisory only and never auto-sealed or auto-paid
- Escrow disputes route to a multi-party arbiter set, with the logic open in `ConsultEscrow`
- Responsible disclosure: `security@your-domain.example`

---

## Contributing

```bash
git checkout -b feat/your-feature
pnpm turbo test
pnpm turbo lint
# open a PR against main
```
See `CONTRIBUTING.md` and `docs/architecture.md`.

---

## License

MIT, 2026 Quoin Contributors

---

*Built on Stellar. Powered by Soroban. Honest numbers for everything we build.*