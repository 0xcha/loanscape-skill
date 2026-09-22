# Loanscape skill

Live onchain borrow-rate comparison inside Claude Code, Claude, Cursor, Codex, and any other agent that reads the Agent Skills format. Ask "where's the cheapest place to borrow USDC against ETH" and get every major venue ranked on rate, LTV, liquidity and 30-day stability, with a link to the full comparison on [Loanscape](https://loanscape.lotuslabs.net).

Built by [Lotus Labs](https://lotuslabs.net). Scaffolded 2026-09-21; works against today's address-based `/api/offers` endpoint, no API changes required.

## Install

**Claude Code** (two commands):

```
/plugin marketplace add lotuslabs/loanscape-skill
/plugin install loanscape@lotus-labs
```

**Any agent that reads SKILL.md** (Cursor, Codex, Gemini CLI, Copilot):

```
npx skills add lotuslabs/loanscape-skill
```

**claude.ai / Claude desktop:** zip `plugins/loanscape/skills/loanscape/` and upload it under Settings → Features → Skills. Requires code execution on and a network setting that allows outbound requests.

Replace `lotuslabs/loanscape-skill` with the real GitHub path once the repo is published.

## Try it without installing

```
node plugins/loanscape/core/market.mjs --coll ETH --borrow USDC                       # three-line read
node plugins/loanscape/core/market.mjs --coll wstETH --borrow WETH --venues aave,morpho --size 2m
node plugins/loanscape/core/market.mjs --coll BTC --borrow USDC --table --rank ltv
node plugins/loanscape/core/brief.mjs --wallet vitalik.eth                            # the /loanscape brief
```

Node 18+, no dependencies. Behind a proxy the script falls back to `curl`.

## Layout

```
.claude-plugin/marketplace.json          Claude Code marketplace (one plugin: loanscape)
plugins/loanscape/
  .claude-plugin/plugin.json
  core/                                  shared by every skill
    brief.mjs                            the /loanscape brief: positions + market + urgency + diff, prints finished text
    market.mjs                           the explorer door: read / sized / head-to-head / table for a pair, prints finished text
    moves.mjs                            market moves: what changed over N days from 30-day rate history, cross-market or per pair
    cost.mjs                             loan-cost (net of yield and rewards, carry) and refinance-check ("am I overpaying?") without a wallet
    tokens.json                          symbol → address per chain (market.mjs)
    positions.mjs                        every open borrow position for a wallet (Aave, Spark, Morpho, Compound)
    venues.json                          onchain venue registry, every address called live
    voice.md                             output rules every skill follows
    lib/{rpc,abi,keccak,offers}.mjs      JSON-RPC with fallbacks + curl path, ABI, keccak-256, Loanscape API
    lib/rules.mjs                        two rules ported from the Loanscape agent: refi dollarization, suspect-endpoint gate
    morning.sh · install-routine.sh      the daily run: script, log, notification; launchd on macOS, cron on Linux
  skills/
    loanscape/SKILL.md                   intentional (/loanscape). Resolves the wallet, runs the brief, passes it through
    borrow-rates/                        auto-triggered. Market questions → core/market.mjs; methodology reference
    market-moves/                        auto-triggered. "What changed" questions → core/moves.mjs
    loan-cost/                           auto-triggered. True cost and carry questions → core/cost.mjs
    refinance-check/                     auto-triggered. "I'm paying X, is that bad?" → core/cost.mjs --paying
```

Memory for the brief lives in `~/.loanscape/memory.json` (override with `LOANSCAPE_HOME`): the remembered wallet, the last snapshot, and which findings were already shown, so a repeat run says what changed and doesn't repeat itself.

## Run it every morning

Say "run this every morning at 8" in chat. Nobody types a command. Where the brief lands depends on where you are:

- **Claude Desktop app:** Claude creates a scheduled task that runs `/loanscape` daily; the brief appears in the app's scheduled section with a notification. The app has to be open at that hour.
- **Claude Code with cloud routines:** `/schedule` runs `/loanscape` daily with your machine off, delivered through a connector. Needs the plugin available to the routine and outbound network; unverified from this repo's own tests.
- **Anywhere else:** Claude installs a local job (`core/install-routine.sh`, launchd on macOS, cron on Linux) that runs the brief script, pops a notification with the first line, and keeps the full text in `~/.loanscape/brief.log`. No LLM, no tokens.

Or just type `/loanscape` in the morning. It takes four seconds and remembers your wallet.

## Telemetry

Requests carry `User-Agent: loanscape-skill/<version>` and `X-Loanscape-Client: claude-skill`; links carry `?src=claude-skill`. That is what lets Lotus report agent-routed queries as their own line, separate from browser users. No user data leaves the machine.

## core/positions.mjs (added 2026-09-22; now at plugins/loanscape/core/)

Every open borrow position for a wallet, across Aave v3 (Main and Prime), Spark, Morpho Blue, Compound v3 and Fluid, on Ethereum, Base and Arbitrum. Public RPCs with fallbacks plus Morpho's public API; no keys, no dependencies. Accepts an address or an ENS name.

```
node plugins/loanscape/core/positions.mjs --wallet vitalik.eth
node plugins/loanscape/core/positions.mjs --wallet 0x... --chain ethereum --json
```

One normalised shape per position: venue, kind (pooled or isolated), collateral[] and debt[] with amounts, USD and per-debt APR, LTV, liquidation threshold, health factor, and a liquidation price with percent drop when the position is one collateral against one debt. Positions sort by health, riskiest first. Dust under $1 is dropped. Venues that fail to read are named in `errors` rather than silently omitted.

Reads Fluid too (added 2026-09-22): positions are NFTs, listed and decoded through Fluid's VaultResolver, priced from Fluid's public API. Type-1 vaults (token collateral, token debt) are fully priced; smart-collateral or smart-debt vaults report the DEX-share side unpriced and say so. Aave rows now split deposits into collateral (enabled, backing the loan) and `supplied` (not backing it), carry per-asset liquidation thresholds, and name the e-mode category. The liquidation price is solved for the largest collateral asset holding other prices fixed; when stable collateral backs one volatile debt it reports the price the debt would have to rise to instead.

Known limits: Fluid smart-vault shares are not converted to USD. Public RPCs rate-limit; a three-chain run takes five to ten seconds.
