---
name: market-moves
description: What changed in onchain borrow markets over the last days or weeks, from 30-day rate history across Aave, Spark, Morpho, Compound and Fluid on Ethereum, Base and Arbitrum, via Loanscape. Use when someone asks what's moving, what changed this week, whether borrow rates are rising or falling, which venue stepped or spiked, whether a rate is at a high or low, or which venue is cheapest now versus before. Not for "where's cheapest right now" (that's borrow-rates) or the user's own loans (that's /loanscape).
allowed-tools: Bash(node *)
metadata:
  author: Lotus Labs
  homepage: https://loanscape.lotuslabs.net
  version: "0.1.0"
---

# Market moves: what changed

One script reads the 30-day rate history behind every venue Loanscape covers and says what moved. It prints finished text. Pick the window and the scope from the question, run it, pass the text through.

Read `core/voice.md` once. It governs every line you add.

## Pick the scope

```bash
node "${CLAUDE_PLUGIN_ROOT}/core/moves.mjs" [--days 7] [--pair ETH/USDC] [--chain ethereum|base|arbitrum]
```

If `CLAUDE_PLUGIN_ROOT` is unset, `core/` sits two directories above this skill's folder. Ignore any `failed to copy trust settings` lines on stderr.

| The user asks | Run with | They get |
|---|---|---|
| "what's moving in borrow markets?", "what changed this week?" | no flags | the cross-market read over Ethereum, Base and Arbitrum: Ethereum's biggest movers, a step, a flip, then one line each for Base and Arbitrum if anything moved there; quiet chains are named in the coverage line |
| "…this month", "over the last 30 days" | `--days 30` | same, over 30 days |
| "are ETH borrow rates rising?", "what's happening with wstETH/WETH?" | `--pair ETH/USDC` | that pair's story: who moved, who's at a 30-day high or low, streaks, steps |
| a chain by name | `--chain base` | that chain only, up to four lines |

Pairs: ETH, wstETH, cbBTC, WBTC against USDC, and wstETH against WETH. `--pair` takes either `ETH/USDC` or `ETH USDC`. "ETH borrow rates" on its own means borrowing dollars against ETH, so `ETH/USDC`; borrowing ETH itself is `wstETH/WETH`. If the phrasing could be either, run `ETH/USDC` and offer the other in the last line. Only pass `--chain` when the user named one; the pair story reads Ethereum unless a chain is named.

## Render

No preamble. The first thing you print is the script's text; never announce that you're reading a guide or running a script.

Print the script's text exactly as returned. No heading, no restating numbers, no glossing. The pair story's table is markdown; print it as-is, never inside a code fence. "Quiet" is a complete answer; do not pad it. The cross-market read carries no link by design; never add one.

If the run doesn't fit the question (wrong window, wrong pair), run again before answering.

## Follow-ups, five lines or fewer

- "Why did Compound spike?": the market column from `borrow-rates`' table (`--table`, any pair that borrows that asset; a pooled venue is the same row whatever the collateral) says what kind of market it is. A pooled rate follows utilisation, so a spike means borrowing jumped or supply left that day. You don't have the cause beyond that; say so in one line and give where the rate sits now against its 30-day range.
- "Is it still cheapest?": run `borrow-rates` for the pair; this skill reads history, that one reads now.
- "Should I wait?": no predictions. Give where the rate sits in its 30-day range and the streak, then hand it back.
- Anything about the user's own loan: `/loanscape`.

## Rules

- Only movers with at least $1M available are reported in the cross-market read; thin markets swing on nothing.
- History that contradicts the live rate by 300 bps or more is left out and the read says which venues were left out. Never repair that from memory.
- Pooled venues (Aave, Spark, Compound, Fluid) are one market per borrow asset regardless of collateral, and the read names them that way ("Aave USDC borrowing"). Isolated markets (Morpho) are one per pair.
- Describe, don't advise. No direction calls.
