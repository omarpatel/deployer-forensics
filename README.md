# Deployer Forensics

[![CI](https://github.com/omarpatel/deployer-forensics/actions/workflows/ci.yml/badge.svg)](https://github.com/omarpatel/deployer-forensics/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black)
![Solana](https://img.shields.io/badge/Solana-9945FF?logo=solana&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

A dependency-free CLI that scores a pump.fun token creator against the behavioural signature of an automated extraction deployer.

## Overview

Given a creator wallet or any token mint (the creator is resolved automatically), the tool pulls the creator's launch history from the pump.fun frontend API, computes eight behavioural signals, and combines them into a 0–100 score with a risk band. Optionally it queries Solana RPC for on-chain activity. Signals that lack enough data are reported as unmeasured and excluded from the score rather than counted as clean.

## Features

- Accepts a creator wallet or a token mint; resolves the creator from the mint
- Eight weighted signals:
  - Launch throughput (launches per day)
  - Automated cadence (regularity of launch spacing)
  - Recycled artwork (images named after another mint or hosted on discovery-tool CDNs)
  - Self-hosted metadata (private hosts or raw IPs instead of IPFS/Arweave)
  - Peak-at-launch (time from creation to all-time high)
  - Graduation failure (bonding curves that never complete)
  - Empty listings (no description, no replies)
  - Extraction gradient (whether decay deepens with peak size and converges to a common floor)
- Decay-by-peak table bucketed by peak market cap
- Score bands: `EXTRACTION FACTORY` (75–100), `HIGH RISK` (50–74), `ELEVATED` (25–49), `NO FACTORY SIGNATURE` (0–24)
- Optional Solana RPC check for balance, transaction rate and failure rate
- Coloured terminal report or JSON output

## Architecture

A single Node.js script (`deployer-forensics.js`):

1. **Fetch** – pages through the pump.fun creator endpoint (capped near 1,050 records, most recent first).
2. **Analyse** – derives per-launch features (timing, image/metadata hosts, peak and current market cap, graduation, social fields).
3. **Score** – maps features to the eight signals, dropping any below its sample floor from the denominator.
4. **Report** – renders a terminal report or JSON.

## Tech stack

- Node.js 18+ (built-in `fetch`), no third-party dependencies
- pump.fun frontend API
- Solana JSON-RPC (optional)

## Getting started

```bash
node deployer-forensics.js <creator-wallet | token-mint> [options]
# or
npm run scan -- <creator-wallet | token-mint> [options]
```

| Option | Effect |
|---|---|
| `--json` | Machine-readable output |
| `--limit <n>` | Maximum launches to fetch (default 1050) |
| `--chain` | Also query Solana RPC |
| `--rpc <url>` | RPC endpoint (default: public mainnet) |
| `--no-color` | Disable ANSI colour |

### Limitations

- The creator API returns roughly the most recent 1,050 launches; totals for high-volume creators are a lower bound.
- A high score indicates industrial launching patterns, not a legal finding. Market caps are as reported by pump.fun.

## Project structure

```
deployer-forensics.js     CLI: fetch, analysis, scoring and report rendering
package.json   Package metadata and the `scan` script
```

## License

MIT — see [LICENSE](LICENSE).
