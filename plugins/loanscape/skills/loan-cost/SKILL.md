---
name: loan-cost
description: What an onchain loan really costs once collateral yield and rewards are netted out, and the carry when the collateral earns more than the debt costs (wstETH against WETH, looping, leverage). Use when someone asks the true or net cost of borrowing against a yielding asset like wstETH or cbBTC, whether a loop or carry trade pays, what the spread is between staking yield and the borrow rate, or how much a loan of a given size costs per year. For plain "where's cheapest" use borrow-rates; for the user's own loan use /loanscape.
allowed-tools: Bash(node *)
metadata:
  author: Lotus Labs
  homepage: https://loanscape.lotuslabs.net
  version: "0.1.0"
---

# Loan cost: what it really costs

One script nets collateral yield and rewards against the borrow rate for every deep venue on a pair, and prints finished text. Pick the flags from the question, run it, pass the text through.

Read `core/voice.md` once. It governs every line you add.

```bash
node "${CLAUDE_PLUGIN_ROOT}/core/cost.mjs" --coll <collateral> --borrow <asset> [--size 500k] [--ltv 60] [--chain ethereum|base|arbitrum]
```

If `CLAUDE_PLUGIN_ROOT` is unset, `core/` sits two directories above this skill's folder. Ignore any `failed to copy trust settings` lines on stderr.

| The user asks | Flags | They get |
|---|---|---|
| "does the wstETH/ETH loop pay?", "what's the carry on wstETH?" | `--coll wstETH --borrow WETH` | the carry: yield minus borrow rate per unit borrowed, per venue, with the leverage the max LTV allows |
| "what does it really cost to borrow dollars against wstETH?" | `--coll wstETH --borrow USDC --ltv 60` | net cost at that LTV: the yield offsets part of the rate; the offset shrinks as LTV rises. Default LTV is 50% if they gave none; say so only if asked |
| a size | add `--size 1m` | dollars a year, and the venue pick respects the 10%-of-depth rule; a better venue that's too thin is named as such |
| collateral that doesn't yield (ETH, WBTC, cbBTC) | same flags | "costs what it says", the table, dollars a year if sized. LTV changes nothing here except the liquidation price; pass it anyway and the script says so |
| one venue named ("at Spark", "if I moved it to Morpho") | add `--venues spark` | the same card for that venue only |

Collateral: ETH, wstETH, cbBTC, WBTC. Borrow: USDC, USDT, DAI, WETH. Only pass `--chain` when the user named one.

## Render

Print the script's text exactly as returned. Put the table in a code fence; prose stays outside. The script adds the Loanscape link once per pair per conversation; never add one yourself.

If the run doesn't fit the question (wrong LTV, size dropped), run again before answering.

## Follow-ups, five lines or fewer

- "What if rates flip?": run `market-moves` on the pair (`moves.mjs --pair wstETH/WETH`) and show its table, then two lines: a flip is the borrow rate rising over the yield or the yield falling under it, and at that point the loop costs the gap on every unit of exposure. Name the venue in the table that is already negative, if one is.
- "Is that leverage safe?": the loop multiplies both the spread and the liquidation risk; give the max LTV, the exposure multiple the script printed, and that a rate flip turns the carry negative. No recommendation.
- "Which venue then?": tradeoffs on carry, depth and LTV from the table, then hand it back.
- "What about at 70% LTV?": run again with `--ltv 70`.
- The user's own position: `/loanscape`.

## Rules

- Carry is `collateral yield + rewards − borrow rate`, per unit borrowed. Net cost against stable debt at LTV L is `borrow rate − rewards − yield / L`. Both are the script's arithmetic; never redo it in your head.
- Both legs float. Every carry answer says so once.
- Describe, don't advise. No direction calls on yields or rates.
