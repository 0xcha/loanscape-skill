---
name: refinance-check
description: Am I overpaying on an onchain loan? Compares a rate the user says they pay on a collateral/borrow pair (optionally their venue and size) against today's alternatives with room for the loan, in bps and dollars a year, against the pair's typical weekly swing. Use when someone quotes their own borrow rate and asks if it's good, whether to refinance, or if Aave or Morpho would be cheaper for a loan they already have. With a wallet address instead, that's /loanscape.
allowed-tools: Bash(node *)
metadata:
  author: Lotus Labs
  homepage: https://loanscape.lotuslabs.net
  version: "0.2.23"
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

The scripts are in `${CLAUDE_PLUGIN_ROOT}/core` in a Claude Code plugin install (that variable is already substituted in this text), and in the `core` folder beside this SKILL.md anywhere else (Codex, Cursor and other agents). `$CORE` in the commands below stands for that folder: write the path out in the command itself; don't set a shell variable first, since a `CORE=…;` prefix doesn't match the allowed `node` command. Every command below runs from that folder. Ignore any `failed to copy trust settings` lines on stderr.

- `--paying` is the rate they quoted, as a percent (`5.4`). If they named the venue but no rate, leave it out; the script uses that venue's live rate and says so in its first line. Don't add that explanation yourself.
- `--venue` if they named where the loan is. "Aave" alone means Main.
- `--size` if they gave the loan size; dollars a year and the depth check depend on it: an alternative counts only if the loan stays under 10% of its available depth, and a cheaper venue that fails that is named as too thin. Without it, the script uses "per $1m" and a $1M depth floor.
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
