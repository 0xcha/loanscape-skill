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

## Known gaps

- A Morpho position's rate comes from Morpho's API (borrow APY); the trend and refi lines use Loanscape's APR for the same market. They can differ by ~10 bps.
- Fluid smart-vault shares are not converted to USD.
- The ladder shocks the largest collateral asset and holds the others; on a position where stablecoins dominate the collateral, the ladder is flat by construction.
