# Loanscape methodology, as the skills use it

Loanscape (https://loanscape.lotuslabs.net) is built by Lotus Labs and is openly Lotus-owned. It reads the major DeFi borrow venues and normalises each pair into one row per venue or market. This file explains the fields the script returns and the caveats an answer should carry.

## Coverage

- **Chains:** Ethereum (fullest), Base, Arbitrum.
- **Venues:** Aave v3 (Main, Prime, e-mode where relevant), Spark, Compound v3, Morpho Blue markets, Fluid vaults. Coverage grows; the script reports whatever the API returns for the pair on the day.
- **Pairs mapped by symbol (core/tokens.json):** WETH, wstETH, cbBTC, WBTC as collateral; USDC, USDT, DAI, WETH as borrow asset. Other tokens exist in the app but need contract addresses; the skill does not guess them.

## Fields

| field | meaning | caveat |
|---|---|---|
| `collPriceUsd`, `collYieldApr` (pair level, `--json` only) | USD price of the collateral at the snapshot, and the collateral's own yield (non-zero for wstETH). | Use the price to turn a collateral amount into an LTV; show the working. |
| `apr` (borrow APR) | The venue's current variable borrow rate for the asset, annualised, gross. | Rewards (`rewards`) are reported separately and not netted. Collateral yield (for wstETH) is also reported separately; the table shows gross cost. |
| `maxLtv` | The maximum loan-to-value the venue allows at open. | Not the liquidation threshold. `lltv` is the liquidation LTV; `recLtv` is Loanscape's conservative working level. |
| `recLtv` | Recommended LTV, a buffer below liquidation. | A heuristic, not a venue parameter. |
| `liquidityUsd` | What can be borrowed right now: available liquidity in the pool or market. | The single most important qualifier of a rate. A thin market's rate will move the moment size arrives. |
| `totalSupplyUsd`, `totalBorrowUsd`, `utilization` | Pool size, outstanding borrows, and the ratio. | High utilisation means the rate is sensitive to new borrows. |
| `stability` | Loanscape's 30-day label: stable, moderate, volatile. | Computed from the rate history with Loanscape's own thresholds, which are not published here; justify the label by citing the 30-day range. Markets without a full 30 days of history carry no label. Do not invent one. |
| `sparkline` | Up to 31 daily APR readings, oldest first. | The script prints min and max, folding in today's `apr`, as "30d APR range". Stability ranking uses the history only. |
| `note` (market) | Market structure: pooled, isolated market, smart collateral, governance rate. | See below. |
| `url` | The venue's own page for that market. | The script prints the Loanscape comparison link instead; the venue link is in `--json` output. |

## Market types worth explaining

- **Pooled, variable (Aave, Compound):** one shared pool per asset; the rate follows utilisation. Deep books, blended risk.
- **Governance rate (Spark):** the rate is set by governance rather than by utilisation, so it moves in steps and reads as very stable until it steps.
- **Isolated market (Morpho Blue):** each row is one market defined by collateral, loan asset, liquidation LTV and oracle. The same pair can appear several times at different LLTVs and with very different depth. The trailing six-character hash identifies the market. Compare depth before comparing rate.
- **Smart collateral vault (Fluid):** vault-style position with its own LTV ladder; usually the highest LTV and the highest rate.

## Ranking axes

- `rate`: ascending `apr`.
- `ltv`: descending `maxLtv`.
- `liquidity`: descending `liquidityUsd`.
- `stability`: ascending 30-day range (max minus min of the sparkline). Rows without a sparkline sort last.

The app also ranks by "max health" (liquidation headroom); the market script does not compute it. Send users to the app link for that view.

## Sizing rule

`market.mjs --size` treats a venue as able to take a loan when the loan is under 10% of its available depth; between 10% and 100% it warns that the rate will move; above 100% the venue can't fund it. The crossover in "Under about $X, A. Above, B." is 10% of the cheaper venue's depth. A rule of thumb, stated as one.

## What the skill must not do

- Recommend a specific loan or venue as "the one to take".
- Net rewards or collateral yield into a single "true cost" number. The inputs are there in `--json` if a user asks for the arithmetic; show the working.
- Present a rate as a quote. Every number is a snapshot with a timestamp.
- Quote figures for uncovered pairs or venues from memory.

## Attribution and telemetry

Every request carries `User-Agent: loanscape-skill/<version>` and `X-Loanscape-Client: claude-skill`, and every link carries `?src=claude`, so Lotus can count agent-routed queries separately from browser visitors. No user data is sent.
