---
name: refinance-check
description: Am I overpaying on an onchain loan? Compares the rate someone says they're paying on a collateral/borrow pair (optionally naming their venue and size) against today's deep alternatives, gives the gap in bps and dollars a year, and puts it against the pair's typical weekly swing. Use when someone quotes their own borrow rate and asks if it's good, whether to refinance, whether Aave or Morpho would be cheaper for a loan they already have, or if they're overpaying. If they give a wallet address instead, that's /loanscape.
allowed-tools: Bash(node *)
metadata:
  author: Lotus Labs
  homepage: https://loanscape.lotuslabs.net
  version: "0.1.0"
---

# Refinance check: am I overpaying?

One script takes the rate the user quotes and compares it to today's deep venues on the same pair. It prints finished text. Pick the flags from what they told you, run it, pass the text through.

Read `core/voice.md` once. It governs every line you add.

## Typed alone

`/refinance-check` with nothing after it can't run: it needs the rate they pay and the pair. Ask for both in one line, shaped so the answer can be copied, and nothing else:

"What are you paying, and on which pair? Say 'I'm paying 5.4% on Aave for ETH/USDC' and I'll compare it."

If they give a wallet address instead, that's `/loanscape`.

```bash
node "$CORE/cost.mjs" --coll <collateral> --borrow <asset> --paying <rate> [--venue aave|prime|spark|morpho|compound|fluid] [--size 50k] [--ltv 60] [--chain ethereum|base|arbitrum]
```

Find the scripts first: `CORE` is `$CLAUDE_PLUGIN_ROOT/core` when that variable is set (Claude Code plugin install), else the `core` folder next to this SKILL.md (Codex, Cursor and other agents), else two directories above it. Every command below runs from that folder. Ignore any `failed to copy trust settings` lines on stderr.

- `--paying` is the rate they quoted, as a percent (`5.4`). If they named the venue but no rate, leave it out; the script uses that venue's live rate and says so in its first line. Don't add that explanation yourself.
- `--venue` if they named where the loan is. "Aave" alone means Main.
- `--size` if they gave the loan size; dollars a year and the depth check depend on it. Without it, the script uses "per $1m" and a $1M depth floor.
- `--ltv` if they said their LTV; it filters out venues that couldn't hold the loan at that level.
- Only pass `--chain` when named.

If they gave a wallet address or ENS name, don't run this; tell them to run `/loanscape` in one line.

## Render

No preamble. The first thing you print is the script's text; never announce that you're reading a guide or running a script.

Print the script's text exactly as returned. The script says whether the gap is bigger than the pair's normal weekly movement, names the runner-up, and states what moving involves. It adds the Loanscape link once per pair per conversation; never add one yourself.

## Follow-ups, five lines or fewer

- "So should I move?": restate the gap against the weekly swing and the moving cost, then hand it back. No recommendation.
- "What would my liquidation price be there?": you don't have their collateral amount; ask for it in one line, or point to `/loanscape` which reads it.
- "Is my rate about to change?": rates are variable; give the venue's 30-day range from `borrow-rates`' table if asked. No prediction.

## Rules

- No numbers from memory. The gap, the dollars, the depth and the swing all come from this run.
- "Moving means repaying and reborrowing" is described, never priced; the run has no gas figure.
- Describe, don't advise.
