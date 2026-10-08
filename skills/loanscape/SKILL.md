---
name: loanscape
description: The Loanscape front door. /loanscape with a wallet address or ENS name reads its open borrow positions across Aave, Spark, Morpho, Compound and Fluid and says what matters; with a pair it gives the venue table; alone it gives the remembered wallet's brief. Use for any wallet the user pastes and for their own loan, LTV, liquidation or health. Plain market questions go to borrow-rates, market-moves, loan-cost or refinance-check.
allowed-tools: Bash(node *)
metadata:
  author: Lotus Labs
  homepage: https://loanscape.lotuslabs.net
  version: "0.2.24"
---

# /loanscape: the position brief

This is the check-in. It reads every open borrow position for a wallet, prices each against the market, decides what matters, and says it in under twelve lines. The script produces the finished text. Your job is scope, then pass-through, then one next move.

Read `core/voice.md` once. It governs every line you add.

## 1. Route by what came with the command

- **A pair, or just a collateral** (`/loanscape eth usdc`, `wsteth/weth`, `btc against usdc`, or `/loanscape btc` which means BTC against USDC): the venue table. Run `core/market.mjs --coll <c> --borrow <b> --table` and print it as returned. Same flags as borrow-rates for chain, rank and size if they gave one.
- **A wallet address or ENS name**: the position brief, below. The user's own wallet (`/loanscape <wallet>`, "my wallet", "add my other wallet") is remembered. Someone else's ("check 0x…", "what is vitalik.eth borrowing") is read with `--no-save`: it is never remembered or merged into the user's own brief, and follow-ups on it still work for ten minutes.
- **Nothing**: run the brief with no `--wallet`; it uses the remembered wallet. If it prints `NEED_WALLET`, run the ETH/USDC table instead and end with exactly one line: "Paste a wallet address and I'll read your open loans." Never ask before showing something.
- Never guess a wallet from context, files, or earlier conversation unless the user gave it in this session.

## 2. Run

```bash
node "$CORE/brief.mjs" --wallet <wallet>            # add --no-save for a wallet that isn't the user's own
```

The scripts are in `${CLAUDE_PLUGIN_ROOT}/core` in a Claude Code plugin install (that variable is already substituted in this text), and in the `core` folder beside this SKILL.md anywhere else (Codex, Cursor and other agents). `$CORE` in the commands below stands for that folder: write the path out in the command itself; don't set a shell variable first, since a `CORE=…;` prefix doesn't match the allowed `node` command. Every command here runs from that folder. Optional `--chain ethereum|base|arbitrum` narrows the read; default is all three. Ignore any `failed to copy trust settings` lines on stderr; they are macOS keychain noise. A fresh read takes about twenty seconds (it reads five venues on three chains); say nothing while it runs, and don't title or narrate the run. Follow-ups within ten minutes (`--json`, `--ladder`, `--move`, `--full`) reuse that read and return at once.

## 3. Render

No preamble. The first thing you print is the script's text; never announce that you're reading a guide or running a script.

Print the script's text exactly as returned. Do not summarise it, reorder it, add a heading, add commentary, gloss a term, or restate numbers in prose. You add nothing, ever: a good line you'd like to add belongs in the script, where everyone gets it, not in this turn. The positions are a markdown table; never wrap it or anything else in a code fence. The script already carries the verdict, the next move, and on the first run the coverage line. It follows the voice rules and the length cap.

## 4. Follow-ups

Questions after the brief are answered from the run's data, in the voice, five lines or fewer. For the numbers behind a line (depth at the other venue, its max LTV, the current venue's working ceiling, the 30-day range), rerun with `--json`; it reads memory for the since-line but never writes it, so it will not disturb the next "Since …" line:

```bash
node "$CORE/brief.mjs" --json
```

Each position there carries `mine` (the user's own venue as the market sees it), `best` (the cheapest alternative with LTV room where the loan stays under 10% of what's available, the same depth rule as the market comparison) and `thin` (a venue cheaper still that fails only that depth rule, or null).

- "Why is that urgent?", "how far is liquidation?", "what if ETH drops 20%?", "how much can I add or repay?": run the ladder for that row and print it as returned. It never writes memory. The row number is the table's, top to bottom, and it stays the same whether the user asks for the ladder or the moves; "the biggest one" is the row with the largest debt, "the Morpho one" the row whose venue says Morpho. If the question fits more than one row (every loan is BTC-backed and they ask "what if BTC drops 20%?"), run it for each row and print them in order, one blank line between them.

```bash
node "$CORE/brief.mjs" --ladder <row number> --shock <percent>
```

  Pass `--shock` with the move the user named (20 for "drops 20%") and the first line answers that move directly; omit it for the plain ladder. It prints LTV and health at −10 / −20 / −30% on the main collateral (or +10 / +20 / +30% on the borrowed asset when the risk runs that way), the liquidation price, and the borrowing room under the venue's working ceiling or the collateral to add / debt to repay to get back under it. A loop (liquid-staking collateral against the asset it stakes, wstETH → WETH) reads differently, and the script handles it: an ETH move shifts both sides, so `--shock` says the loan doesn't move on ETH and gives the same number as a fall in the ratio; the rows are the ratio −1 / −2 / −3%, then the carry and the unwind that doubles the ratio room.
- "Should I move it?", "what are my options?", "what should I do?": run the move ladder for that row and print it as returned. It lays out the five moves from leaving the loan alone to closing it (do nothing, add collateral, repay some, refinance, close) with the numbers for each, and hands the decision back. Refinance is step four on purpose. A loop gets four moves instead: do nothing (with its carry and ratio room), lever down, refinance, close; adding collateral isn't a lever there. Gas is described, never quantified; the run has no gas figure and you do not invent one.

```bash
node "$CORE/brief.mjs" --move <row number>
```

- A quiet repeat brief is one line ("Since yesterday: no material changes …"). "Show me", "show the table", "details": rerun with `--full` and print it as returned.
- "Retry", "try again", after a brief that said it couldn't check or couldn't read some venues: rerun the same command and print it as returned. The script says which of three states it's in (checked, partly checked, couldn't check); never soften or upgrade it, and never say positions were checked when the text says they weren't.
- "What's e-mode?" or a row tagged `e-mode`: Aave's correlated-asset mode. The position's collateral and debt are in one category (for example ETH and staked ETH, or stablecoins), so the venue allows a higher LTV and a higher liquidation threshold than the normal listing. Say it once; `--json` carries the category label under `emode.label`.
- "What about a different pair or venue?": that is a market question; answer with the `borrow-rates` skill's script, not from memory.
- "Add my other wallet": run the script with the new wallet. From then on, `/loanscape` with no wallet reads every remembered wallet into one brief, rows tagged with the wallet. Say that in one line the first time.
- "Forget my wallet": delete `memory.json` and `cache.json` in `~/.loanscape` (or `$LOANSCAPE_HOME`) and confirm in one line.
- "Can this run every morning?", "send me this daily": yes, and the user never touches a terminal. Route by where you are:
  1. **Claude Desktop app** (a scheduled-tasks tool is available): create a daily task at their hour whose prompt is `/loanscape`. The brief lands in the app's scheduled section with a notification. Confirm in one line: the time, and that the app has to be open at that hour.
  2. **Claude Code with cloud routines** (`/schedule` is available and the user wants it to run with the machine off): schedule `/loanscape` daily. It needs this plugin available to the routine and outbound network; if the first run fails, say so plainly and fall back to option 3.
  3. **Neither**: run `sh "$CORE/install-routine.sh" --at 08:00` (their hour). It schedules the brief script locally, pops a notification with the first line each morning, and keeps the full text in `~/.loanscape/brief.log`. Confirm in one line with the time and the log path. "Stop it": same script with `--remove`.
  The local job runs a copy of the scripts under `~/.loanscape/bin`, so a plugin update can't break it; after an update, running the same install command once refreshes that copy.
  Never ask the user to run a command themselves. Never describe the mechanism unless asked.

## What the script decides, so you don't re-decide it

- **Urgent** (leads the brief): liquidation within a 15% price move (for a loop, a 3% fall in the collateral/debt ratio; for a stablecoin pair, 0.75%), health under 1.15, or a rate that stepped 100 bps or more since the last run.
- **Worth knowing** (at most two lines): a cheaper venue on the same pair by at least 20 bps and $100 a year, with LTV room and the loan under 10% of its available depth; the rate rising three days running; LTV above the venue's working ceiling (not for loops, which run near their liquidation LTV by design).
- **Quiet**: everything else, never printed.
- **Since last time**: collateral price moves of 2% or more, headroom changes of 2 points, rate changes of 10 bps, debt changes of 1%, new or closed positions. Three lines at most.

Memory lives in `~/.loanscape/memory.json`: the remembered wallet and the last snapshot. Nothing leaves the machine except the RPC and API reads. Fluid smart vaults (DEX-share collateral or debt) show the share side unpriced; the row says so.
