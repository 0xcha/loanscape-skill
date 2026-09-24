# Testing the manager side

Both sessions test the same way. Wallets are public addresses whose positions change; re-check before relying on a specific number.

## Live regression wallets (2026-09-22)

| Wallet | What it exercises |
|---|---|
| `0x2c5fbd3f89bc53a18497e45447f485af4c8ecbfe` | Aave multi-asset (WBTC + USDC → four debts), LINK supplied but not collateral, no single liquidation price, dominant-pair refi line |
| `0xdc6c295e675b6c8d7b19f39915a7e3fc803feefb` | Compound USDC comet, single pair, Spark refi line, ladder crosses health 1 at −30% |
| `0xfd059176d392e30b74d74bbd769717a3eb6887a2` | Up-direction: USDC collateral, WETH debt on Aave ("liquidates if WETH rises to …") |
| `0x34A8B0660eF835D9d6CfC5770e15e3FaC75049BC` | Morpho cbBTC/USDC and WBTC/USDC on covered markets (matches `mine` by market hash) plus a Fluid cbBTC/USDC vault |
| `0x9805fafe2f34f582c11907a581c638c6b9fd48ca` | Fluid type-1 vault (WBTC → USDT), matches its own offer by vault address |
| `0x196a5888d5603a4363cfaf9d75abf1bc961cd37d` | Fluid type-1 plus a smart-collateral vault (share side unpriced) |
| `0x761e0f091b68b6120191eb0b04f43867b94d66c7` | Aave e-mode on two instances plus a Fluid smart-collateral-and-debt vault |
| `0x0774b5B15B0CEe5E2e14814CCF4d4611fF78CcF5` | Morpho on a pair Loanscape does not cover (no market context, no refi) |
| `vitalik.eth` | ENS resolve, no positions |

Run with a throwaway memory: `LOANSCAPE_HOME=$TMPDIR/ls node core/brief.mjs --wallet <w> --chain ethereum`. Ignore `failed to copy trust settings` on stderr.

## Blind-test recipe (after any change to brief.mjs or SKILL.md)

Spawn a fresh general-purpose agent with the plugin root as `CLAUDE_PLUGIN_ROOT`, a fresh `LOANSCAPE_HOME`, the instruction to read only `skills/loanscape/SKILL.md` and follow it exactly, and this script: `/loanscape <wallet>` → `should i move it?` → `what if it drops 20%?` → `/loanscape`. Ask for exactly what the user would see per turn, then a SKILL FEEDBACK section: what was ambiguous, what read wrong or long for a first-time user, where it was tempted to add text the skill forbids. Fix in the script first, the skill second. The bar: a first-time user says "wow"; a repeat user sees only what changed.

## Failure states (rerun after any change to brief.mjs's read, render or memory)

The brief has three states and each must read differently: checked and quiet, partly checked (`Could not read Aave, Compound and Fluid on Base this time, so a loan there isn't in this brief.`, verdicts scoped "in what I could read"), and couldn't check (`I couldn't check …`, the last good read named, memory untouched, "Say retry"). To simulate:

- **All reads fail:** `HTTPS_PROXY=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 node core/brief.mjs` against a memory with a prior run. Check `memory.json` `lastRun` and `runs` did not change, and `--move 1` says it can't run the numbers.
- **One chain fails:** copy `core/` to `$TMPDIR`, replace the Base endpoints in its `lib/rpc.mjs` with `https://127.0.0.1:9/x`, run the copy on `0x2c5fbd3f…fecbfe`. The Base loan must stay in the snapshot (carried, not "Closed"), and the next healthy run must not call it "New".
- **Quiet return:** a second run on any wallet with nothing moved prints exactly one line ("Since …: no material changes across your one position (about $X a year in interest)."); `--full` prints the rows. A partial read is never quiet: the unread line comes first.
- **Two wallets:** add `0x761e0f09…d66c7` after `0x34A8B066…49BC`. The combined brief keeps the first wallet's rows first; `--ladder 1` and `--move 1` both name the Morpho cbBTC → USDC loan; the quiet repeat is one line carrying any standing refinance as a clause; the two "worth knowing" lines are the two largest by dollars a year.
- **Follow-ups are cached:** after a full read, `--ladder`, `--move`, `--full` and `--json` return in well under a second and leave `memory.json` untouched; ten minutes later they read again.
- **Refinance baselines:** `0xdc6c295e…feefb` (Compound WETH → USDC) showed the chain at 3.99% and Loanscape's feed at 5.57% for the same comet on 2026-09-24, with Spark at 4.18% in between. The brief must print no refi line and `--move 1` must say "can't call it today". A refinance is only quoted when the alternative is cheaper than the chain rate; if the two readings differ by more than 25 bps it must be cheaper than both, and the smaller saving is quoted.

## Known gaps

- A Morpho position's rate comes from Morpho's API (borrow APY); the trend and refi lines use Loanscape's APR for the same market. They can differ by ~10 bps.
- Fluid smart-vault shares are not converted to USD.
- The ladder shocks the largest collateral asset and holds the others; on a position where stablecoins dominate the collateral, the ladder is flat by construction.
