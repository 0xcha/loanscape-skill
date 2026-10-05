# Loanscape skill

Live onchain borrow-rate comparison inside Claude Code, Claude, Cursor, Codex, and any other agent that reads the Agent Skills format. Ask "where's the cheapest place to borrow USDC against ETH" and get every major venue ranked on rate, LTV, liquidity and 30-day stability, with a link to the full comparison on [Loanscape](https://loanscape.lotuslabs.net).

Built by [Lotus Labs](https://lotuslabs.net). Scaffolded 2026-09-21; works against today's address-based `/api/offers` endpoint, no API changes required.

## Install with your agent

Give this prompt to an agent that can read repositories, run shell commands and install local skills:

> Install the five Loanscape skills from https://github.com/0xcha/loanscape-skill for this agent. Read the README and relevant SKILL.md files, and inspect scripts before executing them. Use the agent's supported skill location; for Codex, prefer this project's .agents/skills. If an older copy exists, compare it, back it up outside the skill-discovery folders, and update only the Loanscape files, preserving customizations and unrelated skills and settings. Record the source commit and installed location. Respect this environment's software-installation and network permissions; explain any blocker. Then use the installed skill to compare ETH collateral against USDC borrowing. Confirm that live venue results were returned and which revision ran; a successful process exit alone is not enough. Do not read wallets or schedule anything.

The comparison needs **Node 18+** and outbound HTTPS access to `loanscape.lotuslabs.net`. No npm dependencies, API keys or wallet connection are needed. Git is needed for the clone commands below; `curl` is used as a fallback when Node's fetch cannot connect. If your agent cannot install skills, use the host-specific steps below. Skill support and permission prompts differ between hosts.

### Codex

The `skills/` folder contains five self-contained skills, including their scripts. Codex's documented locations are `.agents/skills` in a project and `~/.agents/skills` for personal skills. Start with a project-local install so its scope is clear. See [Codex skill discovery and invocation](https://learn.chatgpt.com/docs/build-skills).

For a new demo folder (the first command stops if that folder already exists):

```sh
mkdir loanscape-demo && cd loanscape-demo && \
git clone https://github.com/0xcha/loanscape-skill.git source && \
mkdir -p .agents/skills && \
cp -R source/skills/* .agents/skills/
```

Record `git -C source rev-parse HEAD`. Review the downloaded skills and scripts before running them. For a repeatable demo, check out a reviewed commit in `source` before copying. Then open Codex in `loanscape-demo`; in the CLI you can keep demo memory separate with:

```sh
LOANSCAPE_HOME="$PWD/demo-state" codex
```

Use `/skills` or `$` to select the project-local skill and ask **`$loanscape eth usdc`**. In a fresh task, try **“Where is the cheapest place to borrow USDC against ETH?”**, which should select `borrow-rates`. If the skill is missing, restart Codex. If another installed copy has the same name, check the selected path; Codex can list both. A DNS or network-denied error means the comparison has not passed: grant the API access through your host's approved network controls and retry.

**Verified on 2026-10-05:** Codex CLI 0.159.2 on macOS, Node 26.10.0, and [restored v0.2.23 at `8d113ae`](https://github.com/0xcha/loanscape-skill/commit/8d113aec9fea41659b9600d30a79541f92eab447). Fresh CLI sessions using project-local copies and isolated memory passed both explicit and ordinary-language ETH/USDC comparisons with approved network access. Both final answers matched the script output; Codex still added progress preambles. This verifies the CLI comparison flow, not the desktop skill-picker UI, other agents, or every wallet and scheduling path.

### Claude Code

```text
/plugin marketplace add 0xcha/loanscape-skill
/plugin install lotus@lotus-labs
```

For this Claude Code marketplace install, enable auto-update under `/plugin` → Marketplaces → lotus-labs → enable auto-update. This does not update skills copied into Codex or other agents.

### Other agents and Claude uploads

For Cursor, Gemini CLI, Copilot and other hosts that support Agent Skills, use the installation prompt above and the host's documented skill location. The repository also supports the skills CLI route:

```sh
npx skills add 0xcha/loanscape-skill
```

That command downloads and runs an installer; follow your environment's software-installation permissions. This route was not part of the Codex comparison test above.

For claude.ai / Claude desktop, zip `skills/loanscape/` (including its scripts) and upload it through the host's Skills settings. Code execution and outbound network access must be available. Upload other skill folders separately if you want their workflows too.

## Try it without installing

```
node plugins/lotus/core/market.mjs --coll ETH --borrow USDC                       # three-line read
node plugins/lotus/core/market.mjs --coll wstETH --borrow WETH --venues aave,morpho --size 2m
node plugins/lotus/core/market.mjs --coll BTC --borrow USDC --table --rank ltv
node plugins/lotus/core/brief.mjs --wallet vitalik.eth --no-save                  # the /loanscape brief; --no-save reads a wallet without remembering it
```

Node 18+, no dependencies. Behind a proxy the script falls back to `curl`.

## Layout

```
.claude-plugin/marketplace.json          Claude Code marketplace (one plugin: lotus)
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
    lib/rules.mjs                        shared rules: refi dollarization and the suspect-endpoint gate (ported from the Loanscape agent), the 10%-of-depth rule
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
- **Anywhere else:** Claude installs a local job (`core/install-routine.sh`, launchd on macOS, cron on Linux) that runs the brief script, pops a notification with the first line, and keeps the full text in `~/.loanscape/brief.log`. No LLM, no tokens. On Linux it adds one crontab line tagged `# loanscape-morning-brief` and only ever adds or removes that line; it backs up your crontab to `~/.loanscape/` before any change, running it twice changes nothing, and `--dry-run` (with or without `--remove`) prints the change without making it.

Or just type `/loanscape` in the morning. It takes four seconds and remembers your wallet.

## Updating an installed copy

A copied skill does not update when the source repository changes. You can give your agent the installation prompt above again and ask it to update the existing installation.

**Codex and other copied installs:** identify the actual installed path and any duplicate copies first, including older Codex installs under `~/.codex/skills`. Fetch the new source into a separate checkout, record its commit and review the changes. Back up the existing Loanscape folders outside all skill-discovery locations, preserve local customizations, and replace only the five Loanscape folders (`loanscape`, `borrow-rates`, `market-moves`, `loan-cost`, `refinance-check`). Keep wallet memory and settings unchanged. Refresh or restart the host, then repeat the explicit and ordinary-language comparisons above, checking the selected path and live results. Keep the backup until those checks pass; restore it if they fail.

**Claude Code marketplace installs:** use `claude plugin update lotus@lotus-labs`, or enable marketplace auto-update. Updates are version-gated. If an installed copy is broken but the updater says it is current, reinstall with `claude plugin uninstall lotus@lotus-labs && claude plugin install lotus@lotus-labs`. Review any local changes before reinstalling.

**Uploaded skills:** upload the refreshed self-contained folders using the host's replace/update flow, then repeat the comparison.

**v0.2.23 recovery:** the initial `a9ed8f3` commit contained empty skill files and `version.mjs`; `8d113ae` restored them without changing the version. If you installed during that interval, do not rely on the version label alone: reinstall from the restored commit or a later reviewed revision.

### For release maintainers

Bump the release before distributing changed plugin contents:

```sh
./bump.sh          # patch, e.g. 0.2.23 → 0.2.24
./bump.sh minor
```

The script updates the Claude manifests, shared runtime version and plugin skill metadata. It does **not** synchronize the portable `skills/` copies: sync those from the plugin skills/shared core before releasing. Check that every SKILL.md and version.mjs is populated, all release versions agree, and every portable core matches the shared core. Repeat the comparison smoke test against the packaged copies. Use a new version for a corrected release so version-gated updaters can distinguish it.

## Telemetry

Requests carry `User-Agent: loanscape-skill/<version>` and `X-Loanscape-Client: claude-skill`; links carry `?src=claude`. That is what lets Lotus report agent-routed queries as their own line, separate from browser users. Your saved memory (remembered wallets and the last snapshot) stays on your machine, in `~/.loanscape`, or in `./.claude/loanscape` (git-ignored by its own `.gitignore`) when the home folder isn't writable. To read a wallet, its public address is sent to public RPC providers (POKT/Nodies, Blast, publicnode, MEV Blocker, dRPC and the chains' own endpoints; set `LOANSCAPE_RPC_<chainId>` to use your own instead) and to Morpho's API; the Loanscape API only ever receives the pair being priced, never the wallet. Reading a wallet needs no keys and no signature.

## core/positions.mjs (added 2026-09-22; now at plugins/lotus/core/)

Every open borrow position for a wallet, across Aave v3 (Main and Prime), Spark, Morpho Blue, Compound v3 and Fluid, on Ethereum, Base and Arbitrum. Public RPCs with fallbacks plus Morpho's public API; no keys, no dependencies. Accepts an address or an ENS name.

```
node plugins/lotus/core/positions.mjs --wallet vitalik.eth
node plugins/lotus/core/positions.mjs --wallet 0x... --chain ethereum --json
```

One normalised shape per position: venue, kind (pooled or isolated), collateral[] and debt[] with amounts, USD and per-debt APR, LTV, liquidation threshold, health factor, and a liquidation price with percent drop when the position is one collateral against one debt. Positions sort by health, riskiest first. Dust under $1 is dropped. Venues that fail to read are named in `errors` rather than silently omitted.

Reads Fluid too (added 2026-09-22): positions are NFTs, listed and decoded through Fluid's VaultResolver, priced from Fluid's public API. Type-1 vaults (token collateral, token debt) are fully priced; smart-collateral or smart-debt vaults report the DEX-share side unpriced and say so. Aave rows now split deposits into collateral (enabled, backing the loan) and `supplied` (not backing it), carry per-asset liquidation thresholds, and name the e-mode category. The liquidation price is solved for the largest collateral asset holding other prices fixed; when stable collateral backs one volatile debt it reports the price the debt would have to rise to instead.

Known limits: Fluid smart-vault shares are not converted to USD. Public RPCs rate-limit and cap batch sizes; `lib/rpc.mjs` splits batches to each endpoint's limit, falls back to one-by-one calls, backs off and rotates on 429/5xx, so a read slows down rather than failing. A three-chain run takes one to five seconds.
