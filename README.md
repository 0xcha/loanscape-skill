# Loanscape skill

Live onchain borrow-rate comparison inside Claude Code, Claude, Cursor, Codex, and any other agent that reads the Agent Skills format. Ask "where's the cheapest place to borrow USDC against ETH" and get every major venue ranked on rate, LTV, liquidity and 30-day stability, with a link to the full comparison on [Loanscape](https://loanscape.lotuslabs.net).

Built by [Lotus Labs](https://lotuslabs.net). Scaffolded 2026-09-21; works against today's address-based `/api/offers` endpoint, no API changes required.

## Install

**Claude Code** (two commands):

```
/plugin marketplace add 0xcha/loanscape-skill
/plugin install lotus@lotus-labs
```

**Codex, Cursor, Gemini CLI, Copilot** (anything that reads SKILL.md). The `skills/` folder holds self-contained copies of the five skills, scripts included:

```
npx skills add 0xcha/loanscape-skill
```

Or by hand, for Codex: `git clone https://github.com/0xcha/loanscape-skill && cp -R loanscape-skill/skills/* ~/.codex/skills/`. Then `$loanscape`, or just ask a borrow question. Untested in Codex as of 2026-09-23; the format is the shared one, the trigger and shell behaviour aren't verified there.

**claude.ai / Claude desktop:** zip the `skills/loanscape/` folder (the self-contained copy, scripts included) and upload it under Settings → Features → Skills. Requires code execution on and a network setting that allows outbound requests.

Then turn on auto-update for the `lotus-labs` marketplace once (`/plugin` → Marketplaces → lotus-labs → enable auto-update), and every version bump reaches you at your next launch.

## Try it without installing

```
node plugins/lotus/core/market.mjs --coll ETH --borrow USDC                       # three-line read
node plugins/lotus/core/market.mjs --coll wstETH --borrow WETH --venues aave,morpho --size 2m
node plugins/lotus/core/market.mjs --coll BTC --borrow USDC --table --rank ltv
node plugins/lotus/core/brief.mjs --wallet vitalik.eth                            # the /loanscape brief
```

Node 18+, no dependencies. Behind a proxy the script falls back to `curl`.

## Layout

```
.claude-plugin/marketplace.json          Claude Code marketplace (one plugin: loanscape)
plugins/lotus/
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

## Updating an installed copy

An install is a copy. `claude plugin update lotus@lotus-labs` only replaces it when the plugin version has gone up, so bump before telling anyone to update:

```
./bump.sh          # patch, e.g. 0.2.0 → 0.2.1
./bump.sh minor
```

If `update` still says it's at the latest version, `claude plugin uninstall lotus@lotus-labs && claude plugin install lotus@lotus-labs`.

## Telemetry

Requests carry `User-Agent: loanscape-skill/<version>` and `X-Loanscape-Client: claude-skill`; links carry `?src=claude-skill`. That is what lets Lotus report agent-routed queries as their own line, separate from browser users. Your saved memory (remembered wallets and the last snapshot) stays on your machine. To read a wallet, its public address is sent to public RPC providers (publicnode, dRPC, Ankr and others) and to Morpho's API; the Loanscape API only ever receives the pair being priced, never the wallet. Reading a wallet needs no keys and no signature.

## core/positions.mjs (added 2026-09-22; now at plugins/lotus/core/)

Every open borrow position for a wallet, across Aave v3 (Main and Prime), Spark, Morpho Blue, Compound v3 and Fluid, on Ethereum, Base and Arbitrum. Public RPCs with fallbacks plus Morpho's public API; no keys, no dependencies. Accepts an address or an ENS name.

```
node plugins/lotus/core/positions.mjs --wallet vitalik.eth
node plugins/lotus/core/positions.mjs --wallet 0x... --chain ethereum --json
```

One normalised shape per position: venue, kind (pooled or isolated), collateral[] and debt[] with amounts, USD and per-debt APR, LTV, liquidation threshold, health factor, and a liquidation price with percent drop when the position is one collateral against one debt. Positions sort by health, riskiest first. Dust under $1 is dropped. Venues that fail to read are named in `errors` rather than silently omitted.

Reads Fluid too (added 2026-09-22): positions are NFTs, listed and decoded through Fluid's VaultResolver, priced from Fluid's public API. Type-1 vaults (token collateral, token debt) are fully priced; smart-collateral or smart-debt vaults report the DEX-share side unpriced and say so. Aave rows now split deposits into collateral (enabled, backing the loan) and `supplied` (not backing it), carry per-asset liquidation thresholds, and name the e-mode category. The liquidation price is solved for the largest collateral asset holding other prices fixed; when stable collateral backs one volatile debt it reports the price the debt would have to rise to instead.

Known limits: Fluid smart-vault shares are not converted to USD. Public RPCs rate-limit; a three-chain run takes five to ten seconds.
