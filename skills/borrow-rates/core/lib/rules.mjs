// Rules ported from the Loanscape agent (26-8-7_loanscape-agent/scripts/findings.mjs and formats.md rule 1) so the
// agent's posts and these skills never disagree on a number. No runtime coupling: copied, with the source named.
//
// 1. Refinance dollarization. deltaBps is the rate gap between the venue you're on and the cheaper one.
//    perMUsdYr = deltaBps × 100 is USD per year per $1M borrowed. Dollarize only where a computed field exists: at a known
//    loan size use dollarsPerYear; with no size, write it "per $1m" ("$6.1k a year per $1m"; the agent's posts use "/yr", same number), never
//    comma-formatted. Both LTVs ride along: the cheaper venue may bind at a lower LTV, so a switch is never free or unconditional.
// 2. Suspect endpoint gate. If a market's last history point disagrees with its live apr by 300 bps or more, the history is
//    not trusted for that market: no 30-day range, no stability label, no trend. The live apr is truth. (The Loanscape API
//    misreported Aave Main's history by ~10 points from 2026-08-20 to at least 2026-09-16; the agent was gated, the skill was not.)

export const bps = (x) => Math.round(x * 100);
export const perMUsdYr = (deltaBps) => deltaBps * 100;
export const dollarsPerYear = (deltaBps, sizeUsd) => (deltaBps / 10000) * sizeUsd;
export function fmtPerM(deltaBps) { const v = perMUsdYr(deltaBps); return `${v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${Math.round(v)}`} a year per $1m`; }

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
