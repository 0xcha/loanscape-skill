// Rules shared by every script and the Loanscape agent's posts, so no two surfaces disagree on a number.
//
// 1. Refinance dollarization. deltaBps is the rate gap between the venue you're on and the cheaper one.
//    perMUsdYr = deltaBps × 100 is USD per year per $1M borrowed. Dollarize only where a computed field exists: at a known
//    loan size use dollarsPerYear; with no size, write it "per $1m" ("$6.1k a year per $1m"), never comma-formatted. Both LTVs ride
//    along: the cheaper venue may bind at a lower LTV, so a switch is never free or unconditional.
//    A refinance is worth a line only when it clears both bars below: 20 bps on a dust loan is pennies, and $100 a year on 2 bps of
//    a large loan is inside the week's noise. The wallet brief, its move ladder and refinance-check all use the same two numbers.
// 2. Suspect endpoint gate. If a market's last history point disagrees with its live apr by 300 bps or more, the history is
//    not trusted for that market: no 30-day range, no stability label, no trend. The live apr is truth. (A venue's history has
//    drifted from its live rate before; the gate is what keeps a stale series from reading as a move.)
// 3. Depth rule (first written in market.mjs). A loan should stay under DEPTH_SHARE of a venue's available liquidity or expect to
//    move the rate it came for. market.mjs, cost.mjs and the wallet brief all pick venues through fitsDepth, so a venue that is too
//    thin for a loan in one script is too thin in every script.

export const bps = (x) => Math.round(x * 100);
export const perMUsdYr = (deltaBps) => deltaBps * 100;
export const dollarsPerYear = (deltaBps, sizeUsd) => (deltaBps / 10000) * sizeUsd;
export function fmtPerM(deltaBps) { const v = perMUsdYr(deltaBps); return `${v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${Math.round(v)}`} a year per $1m`; }

export const REFI_MIN_BPS = 20, REFI_MIN_USD_YR = 100;
export const worthRefi = (deltaBps, perYear) => deltaBps >= REFI_MIN_BPS && (perYear == null || perYear >= REFI_MIN_USD_YR);

// "500k", "2m", "1.5b", "$1,000,000" → USD. null when nothing was given, NaN when it can't be read (callers say so, never guess).
export function parseSize(x) {
  if (x == null || x === true) return null;
  const m = /^(\d+(?:\.\d+)?)(k|m|mm|b|bn)?$/.exec(String(x).trim().toLowerCase().replace(/[$,_\s]/g, ""));
  return m ? Number(m[1]) * ({ k: 1e3, m: 1e6, mm: 1e6, b: 1e9, bn: 1e9 }[m[2]] || 1) : NaN;
}

export const DEPTH_SHARE = 0.10;
export const fitsDepth = (sizeUsd, liquidityUsd) => !!liquidityUsd && sizeUsd <= liquidityUsd * DEPTH_SHARE;

export const ENDPOINT_GAP_BPS = 300;
export const endpointGapOf = (o) => ((o.sparkline || []).length ? Math.round(Math.abs(o.sparkline[o.sparkline.length - 1] - o.apr) * 100) : null);
export const suspectEndpoint = (o) => { const g = endpointGapOf(o); return g != null && g >= ENDPOINT_GAP_BPS; };
// History-derived fields, gated. For a suspect market the bad endpoint is replaced with the live rate (the agent's repairSuspect),
// so a sparkline can still be drawn, but the label is dropped and `suspect` tells callers to make no 30-day claim about it.
export function trustedHistory(o) {
  if (!o.sparkline?.length) return { sparkline: [], stability: null, suspect: false };
  if (suspectEndpoint(o)) return { sparkline: [...o.sparkline.slice(0, -1), o.apr], stability: null, suspect: true };
  return { sparkline: o.sparkline, stability: o.stability ?? null, suspect: false };
}
