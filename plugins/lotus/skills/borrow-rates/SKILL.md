---
name: borrow-rates
description: Live onchain borrow rates and venue comparison for a collateral/borrow pair (ETH, wstETH, cbBTC, WBTC against USDC, USDT, DAI, WETH) across Aave, Spark, Morpho, Compound and Fluid on Ethereum, Base and Arbitrum, from Loanscape. Use whenever someone asks where the cheapest or best place to borrow is, what DeFi borrow rates are right now, whether Aave or Morpho is cheaper, which venue has the most LTV or the deepest liquidity, how stable a rate has been, or how much a loan of a given size would cost. Not for what changed over time (that's market-moves) or the user's own loans (that's /loanscape). Never answer these from memory.
allowed-tools: Bash(node *)
metadata:
  author: Lotus Labs
  homepage: https://loanscape.lotuslabs.net
  version: "0.2.0"
---

# Borrow rates: the market door

One script answers market questions the way a desk would: a ranking, one or two contrasts, a link. It prints finished text. Your job is to pick the mode from the question, run it, and pass the text through.

Read `core/voice.md` once. It governs every line you add.

## Pick the mode from the question

```bash
node "$CORE/market.mjs" --coll <collateral> --borrow <asset> [flags]
```

Find the scripts first: `CORE` is `$CLAUDE_PLUGIN_ROOT/core` when that variable is set (Claude Code plugin install), else the `core` folder next to this SKILL.md (Codex, Cursor and other agents), else two directories above it. Every command below runs from that folder. Ignore any `failed to copy trust settings` lines on stderr.

| The user asks | Run with | They get |
|---|---|---|
| "Cheapest place to borrow USDC against ETH?", "what are ETH borrow rates?" | no flags | three or four lines: top venues by rate, one or two contrasts, link |
| "…for $500k", "I want to borrow 2M", any size | `--size 500k` | who can take that size, who's cheapest among them, where the crossover sits |
| "Aave or Morpho for wstETH?", any two or more named venues | `--venues aave,morpho` | head to head: rate gap, depth, the size where the answer flips |
| named venues **and** a size ("Morpho or Aave for 2M?") | `--venues aave,morpho --size 2m` | head to head at that size; if neither can fund it, says so and shows who can |
| "compare them all", "show me the table", "show me everything" | `--table` | the full table; add `--rank ltv`, `liquidity` or `stability` when they asked for that axis; add `--size` when they gave one |

Venue names for `--venues`: `aave` (Main), `prime` (Aave Prime), `spark`, `morpho`, `compound`, `fluid`. "Aave" alone means Main.

- `--coll`: ETH, WETH, wstETH, stETH, BTC, cbBTC, WBTC. `ETH` means WETH, `BTC` runs both cbBTC and WBTC.
- `--borrow`: USDC, USDT, DAI, WETH. "Dollars" or "stables" means USDC.
- `--chain`: `ethereum` (default), `base`, `arbitrum`. Only pass it when the user named a chain.
- One run per pair. If the question is "ETH or BTC as collateral?", run twice and put the two reads back to back.

## Render

No preamble. The first thing you print is the script's text; never announce that you're reading a guide or running a script.

Print the script's text exactly as returned, first sentence included; never rephrase it into "These are the current rates…". No heading, no restating numbers in prose, no glossing. The script leads with the answer; it adds the Loanscape link once per pair per conversation and omits it after that. Never add a link yourself. Tables are markdown; print them as-is, never inside a code fence.

If the run doesn't fit the question (you dropped the size, picked the wrong venues, wrong chain), run again with the right flags before answering. Never answer with a run that doesn't match what was asked.

A plain lookup ends with one next move the script chose from what the read showed: a size when depth decides the answer ("What size? The answer flips at about $379k."), a ranking when another venue leads on borrowing power or the cheapest swings. Keep it; never add a second option. When the user answers with a number, run `--size`; with a criterion, `--rank ltv|liquidity|stability`. If the line ends with "Or paste a wallet address and I'll read your open loans.", keep it. It appears on the first plain lookup when no wallet is remembered, once, ever, and it is how the user discovers `/loanscape`. Don't add it as a footer yourself. In a follow-up whose answer needs the user's own position (their liquidation price, their LTV), "Paste a wallet address and I'll read your open loans" is the right next move and you may say it.

## Follow-ups, five lines or fewer, from the run's data

- "What do you mean paste a wallet?", "what happens if I do?": answer with exactly this, nothing more: "Paste a public address or ENS name and I read your open loans on Aave, Spark, Morpho, Compound and Fluid: what you owe, how far from liquidation, and whether a cheaper venue has room for you. It's read-only; no keys, no signing. I remember the wallet, so /loanscape alone works next time. Nothing runs on its own unless you ask for a morning run."

- "Why is that one cheaper?": the market column from `--table` (isolated market, governance rate, pooled, smart collateral) and its depth. A governance rate is set by vote, not by demand, so it wins on rate and moves in steps. An isolated market is one collateral against one loan asset with its own depth.
- Reruns for follow-up numbers are fine: `--table`, `--size`, `--chain`, or `--json` for the raw rows. They don't change what the user sees unless you show them.
- "Is X safe at that size?": run again with `--size`; the answer is the share-of-book line.
- "What about on Base?": run again with `--chain base`.
- "What's LTV?", "what's e-mode?": one sentence, once. LTV is loan value over collateral value; max LTV is the most a venue lets you borrow at open. E-mode is Aave's correlated-asset mode with a higher LTV.
- "Should I borrow there?": the tradeoffs on rate, depth and steadiness, then hand it back. No recommendation.
- Anything about the user's own loan: that is `/loanscape`. Say so in one line only if they haven't been offered it.

Definitions and caveats for the fields are in `references/methodology.md`. Read it before explaining a stability label, a Morpho market row, or a Spark governance rate.

## Rules

- No numbers from memory. Every figure comes from this run. A pair or venue the script doesn't return is "not covered", never filled in.
- Describe, don't advise. No direction calls, no predictions, no token or price opinions.
- The 10% rule the script uses: a loan should stay under about 10% of a venue's available depth or expect to move the rate. Say it in those words if asked why the crossover sits where it does.
