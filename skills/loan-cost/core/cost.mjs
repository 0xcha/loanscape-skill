#!/usr/bin/env node
// Two explorer cards that need no wallet.
//   loan-cost:       node cost.mjs --coll wstETH --borrow WETH [--size 500k] [--ltv 60] [--chain ...]
//                    what a loan really costs once collateral yield and rewards are netted; the carry when the collateral yields more than the debt costs.
//   refinance-check: node cost.mjs --coll ETH --borrow USDC --paying 5.4 [--venue aave] [--size 50k] [--ltv 60] [--chain ...]
//                    "am I overpaying?" without a wallet: your rate against today's deep alternatives, sized, with the spread in context.
// Prints finished text; the skills pass it through. --json for the structured form.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchOffers, loadMem, saveMem, pairLinkOnce, venueName } from "./lib/offers.mjs";
import { bps, fmtPerM, dollarsPerYear, trustedHistory } from "./lib/rules.mjs";
import { mdTable, shareBar } from "./lib/table.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const T = JSON.parse(readFileSync(join(HERE, "tokens.json"), "utf8"));
const DEEP = 1e6, DEPTH_SHARE = 0.10;

const args = parseArgs(process.argv.slice(2));
if (!args.coll || !args.borrow) die("usage: node cost.mjs --coll <sym> --borrow <sym> [--size 500k] [--ltv 60] [--paying 5.4 | --venue aave [--paying 5.4]] [--chain ethereum|base|arbitrum] [--json]");
const chainId = T.chains[String(args.chain || "ethereum").toLowerCase()]; if (!chainId) die(`unknown chain "${args.chain}"`);
const size = args.size ? Number(String(args.size).replace(/[$,_kKmM]/g, (m) => ({ k: "e3", K: "e3", m: "e6", M: "e6" }[m] || ""))) : null;
const ltvArg = args.ltv != null ? Number(String(args.ltv).replace("%", "")) : null;
let paying = args.paying != null ? Number(String(args.paying).replace("%", "")) : null;
const myVenue = args.venue ? String(args.venue).toLowerCase() : null;
const venueFilter = args.venues ? String(args.venues).toLowerCase().split(",").map((x) => x.trim()).filter(Boolean) : null;

const c = alias(args.coll), b = alias(args.borrow);
const ca = addr(chainId, c), ba = addr(chainId, b); if (!ca || !ba) die(`I don't have ${!ca ? disp(c) : disp(b)} mapped on ${chainName(chainId)}.`);
const m = await fetchOffers(chainId, ca, ba);
const coll = m.coll?.symbol || disp(c), borrow = m.borrow?.symbol || disp(b), pair = `${coll} → ${borrow}`;
const collYield = Math.round(Number(m.coll?.yieldApr || 0) * 100) / 100, borrowYield = Math.round(Number(m.borrow?.yieldApr || 0) * 100) / 100;
const r2 = (x) => Math.round(Number(x) * 100) / 100;
const offers = m.offers.filter((o) => o.apr != null).map((o) => ({ ...o, ...trustedHistory(o), apr: r2(o.apr), rewards: r2(o.rewards || 0) }));
const mem = loadMem();
const out = { chainId, pair, collYield, borrowYield, size, ltv: ltvArg, paying, venue: myVenue, text: null };
out.text = paying != null || myVenue ? refiCheck() : loanCost();
if (!args.json) saveMem(mem);
console.log(args.json ? JSON.stringify({ ...out, offers: offers.map(({ sparkline, ...o }) => o) }, null, 2) : out.text);

// ---------------- loan cost ----------------
function loanCost() {
  const pool = venueFilter ? offers.filter((o) => venueFilter.some((v) => matchVenue(o, v))) : offers;
  const picks = bestPerProtocol(pool.filter((o) => (o.liquidityUsd || 0) >= (size ? size : DEEP)).sort((a, b) => a.apr - b.apr));
  if (!picks.length) return `${pair} on ${chainName(chainId)}: nothing${venueFilter ? ` at ${venueFilter.join(", ")}` : ""} with ${size ? usdShort(size) : "$1M"} available right now.`;
  const stableDebt = /USD|DAI/i.test(borrow);
  const carry = collYield > 0 && !stableDebt; // borrowing the asset the collateral is a yielding version of: the loop
  const ltv = ltvArg ?? 50;
  const rows = picks.map((o) => ({ o, net: carry ? collYield + o.rewards - o.apr : o.apr - o.rewards - (collYield ? collYield / (ltv / 100) : 0) }));
  const ordered = carry ? [...rows].sort((a, b) => b.net - a.net) : [...rows].sort((a, b) => a.net - b.net);
  const best = (size && ordered.find((r) => size <= r.o.liquidityUsd * DEPTH_SHARE)) || ordered[0];
  const skipped = size ? ordered.filter((r) => r !== best && (carry ? r.net > best.net : r.net < best.net) && size > r.o.liquidityUsd * DEPTH_SHARE) : [];
  const L = [];
  if (carry) {
    L.push(`${coll} yields ${pct(collYield)}; ${venueFilter ? name(best.o, offers) : `the cheapest deep venue, ${name(best.o, offers)},`} charges ${pct(best.o.apr)} to borrow ${borrow} against it. Carry ${signed(bps(best.net))} bps per unit borrowed${size ? "" : `, ${fmtPerM(Math.abs(bps(best.net)))}${best.net < 0 ? " against you" : ""}`}.`);
  } else if (collYield > 0) {
    L.push(`${coll} yields ${pct(collYield)} while you borrow against it. At ${ltv}% LTV that offsets ${(collYield / (ltv / 100)).toFixed(2)} points of borrow rate, so ${name(best.o, offers)}'s ${pct(best.o.apr)} nets to ${pct(best.net)}.`);
  } else {
    L.push(`${borrow} against ${coll} costs what it says: no collateral yield to net against. ${venueFilter ? name(best.o, offers) : `Cheapest deep venue ${name(best.o, offers)}`} at ${pct(best.o.apr)}${best.o.rewards ? `, ${pct(best.o.rewards)} of that paid back in rewards, net ${pct(best.net)}` : ""}.`);
    if (ltvArg != null) L.push(`${ltvArg}% LTV doesn't change the rate here; it sets your liquidation price, which needs the collateral amount.`);
  }
  if (rows.length >= 3) {
    L.push("");
    const hasRw = rows.some((r) => r.o.rewards), showNet = carry || collYield > 0 || hasRw;
    const H = ["venue", "borrow", ...(hasRw ? ["rewards"] : []), ...(showNet ? [carry ? "carry" : "net"] : []), "max LTV", "available", ...(size ? ["your share", ""] : [])];
    const A = ["l", "r", ...(hasRw ? ["r"] : []), ...(showNet ? ["r"] : []), "r", "r", ...(size ? ["r", "l"] : [])];
    const R = rows.map(({ o, net }) => [name(o, offers), pct(o.apr), ...(hasRw ? [o.rewards ? pct(o.rewards) : ""] : []), ...(showNet ? [carry ? `${signed(bps(net))} bps` : pct(net)] : []), ltvS(o.maxLtv), usdShort(o.liquidityUsd), ...(size ? [o.liquidityUsd ? pctShare(size / o.liquidityUsd) : "", shareBar(size, o.liquidityUsd)] : [])]);
    L.push(mdTable(H, R, A, rows.indexOf(best)), "");
  } else if (rows.length === 2) {
    const other = rows.find((r) => r !== best); L.push(`${name(other.o, offers)}: ${pct(other.o.apr)} borrow, ${carry ? `carry ${signed(bps(other.net))} bps` : `net ${pct(other.net)}`}, ${usdShort(other.o.liquidityUsd)} available.`);
  }
  if (skipped.length) L.push(`${name(skipped[0].o, offers)} is ${carry ? "better" : "cheaper"} on paper (${carry ? `carry ${signed(bps(skipped[0].net))} bps` : `net ${pct(skipped[0].net)}`}) but ${usdShort(size)} would be ${pctShare(size / skipped[0].o.liquidityUsd)} of its ${usdShort(skipped[0].o.liquidityUsd)} book.`);
  if (size) L.push(`At ${usdShort(size)}: ${carry ? `${usdShort(Math.abs(dollarsPerYear(bps(best.net), size)))} a year ${best.net >= 0 ? "earned" : "paid"} on the spread at ${name(best.o, offers)}` : `${usdShort(dollarsPerYear(bps(best.net), size))} a year${collYield > 0 || best.o.rewards ? " net" : ""} at ${name(best.o, offers)}`}, ${pctShare(size / best.o.liquidityUsd)} of its book.`);
  if (carry) L.push(`Both legs float: the yield and the borrow rate move independently, so the carry can close or flip. At ${ltvS(best.o.maxLtv) || "the venue's max"} LTV the loop allows up to ${best.o.maxLtv ? (1 / (1 - best.o.maxLtv / 100)).toFixed(1) : "?"}x exposure; liquidation risk scales with it.`);
  else if (collYield > 0) L.push(`The offset shrinks as LTV rises: at ${Math.min(ltv + 20, 90)}% LTV it is ${(collYield / (Math.min(ltv + 20, 90) / 100)).toFixed(2)} points. Rates on both sides float.`);
  const link = args.json ? null : pairLinkOnce(mem, chainId, coll, borrow, null); if (link) L.push(link);
  if (args.bare) L.push(`Name any pair, a size or an LTV, "wstETH against USDC at 60%" say, and I'll price it.`);
  return paragraphs(L);
}
// Lines become paragraphs: one idea per block, tables kept intact.
function paragraphs(L) { const out = []; let inTable = false; for (const l of L) { if (l === "") { continue; } const isRow = l.startsWith("|"); if (isRow && !inTable) { out.push(""); inTable = true; } else if (!isRow && inTable) { out.push(""); inTable = false; } else if (!isRow) { if (out.length) out.push(""); } out.push(l); } return out.join("\n"); }

// ---------------- refinance check ----------------
function refiCheck() {
  const mine = myVenue ? offers.filter((o) => matchVenue(o, myVenue)).sort((a, b) => (paying != null ? Math.abs(a.apr - paying) - Math.abs(b.apr - paying) : a.apr - b.apr))[0] : null;
  let assumed = false;
  if (paying == null) { if (!mine) return `I don't see ${myVenue} on ${pair} right now. Tell me the rate you're paying and I'll compare it.`; paying = mine.apr; assumed = true; }
  // A quote that disagrees with the live rate by more than AGREE_BPS. On a pooled venue (one rate per borrow asset, everyone
  // pays it) the live rate is authoritative: say so first and compare against it. On an isolated venue (Morpho, Fluid: many
  // markets) we may not know which market they're in, so their quote stands, but the disagreement leads instead of trailing.
  const AGREE_BPS = 25; const pooled = mine && ["aave-v3", "sparklend", "compound-v3"].includes(mine.protocol);
  const drift = mine && !assumed ? bps(mine.apr - paying) : 0; const disagree = Math.abs(drift) > AGREE_BPS;
  const quoted = paying; if (disagree && pooled) paying = mine.apr;
  const need = size || DEEP;
  const alts = bestPerProtocol(offers.filter((o) => o !== mine && !(mine && sameVenue(o, mine)) && (o.liquidityUsd || 0) >= need && (ltvArg == null || o.maxLtv == null || o.maxLtv >= ltvArg)).sort((a, b) => a.apr - b.apr));
  const P = [];
  const plainVenue = myVenue === "morpho" ? "Morpho" : name(mine || { venue: myVenue, protocol: myVenue }, offers); // the user said "Morpho", not which market
  const here = `on ${pair}${myVenue ? ` at ${plainVenue}` : ""}`;
  const youPay = assumed ? `${name(mine, offers)} charges ${pct(paying)} ${here.replace(/ at .*$/, "")} today, so that's the rate I'm using.`
    : disagree && pooled ? `${name(mine, offers)}'s rate ${here.replace(/ at .*$/, "")} is ${pct(mine.apr)} right now, not the ${pct(quoted)} you quoted; everyone there pays the same rate, so I'm comparing against ${pct(mine.apr)}.`
    : disagree ? `You quoted ${pct(quoted)} ${here}; the nearest ${plainVenue} market I can see, ${name(mine, offers)}, shows ${pct(mine.apr)}, ${Math.abs(drift)} bps ${drift > 0 ? "above" : "below"} that. If you're in a different market there, your rate stands, so I'm comparing against ${pct(quoted)}.`
    : `You're paying ${pct(paying)} ${here}.`;
  if (!alts.length) { P.push(`${youPay} Nothing else with ${usdShort(need)} available${ltvArg != null ? ` and ${ltvArg}% LTV room` : ""} is on this pair right now.`); return P.join("\n\n"); }
  const best = alts[0]; const gap = bps(paying - best.apr);
  const swing = typicalWeeklySwing(offers);
  if (gap <= 0) {
    P.push(`${youPay} Nothing deep beats it today; the cheapest alternative is ${name(best, offers)} at ${pct(best.apr)}${gap < 0 ? `, ${Math.abs(gap)} bps more` : ""}.`);
  } else {
    P.push(`${youPay} ${name(best, offers)} charges ${pct(best.apr)}, ${gap} bps less: ${size ? `${usdShort(dollarsPerYear(gap, size))} a year on ${usdShort(size)}` : fmtPerM(gap)}.`);
    const depth = `${name(best, offers)} has ${usdShort(best.liquidityUsd)} available${size ? `, so you'd be ${pctShare(size / best.liquidityUsd)} of it` : ""}${best.maxLtv != null ? `, and its max LTV is ${ltvS(best.maxLtv)}` : ""}.`;
    const ctx = swing != null ? (gap >= swing * 2 ? `The gap is ${(gap / swing).toFixed(1)}x this pair's typical weekly swing of ${swing} bps, so it isn't noise.` : gap >= swing ? `The gap is about this pair's typical weekly swing of ${swing} bps; it could close on its own.` : `The gap is inside this pair's typical weekly swing of ${swing} bps; it may close before a move pays for itself.`) : null;
    P.push([depth, ctx].filter(Boolean).join(" "));
    const next = alts[1] && bps(paying - alts[1].apr) > 0 ? `Next best is ${name(alts[1], offers)} at ${pct(alts[1].apr)} with ${usdShort(alts[1].liquidityUsd)} available.` : null;
    P.push([next, "Moving means repaying here and reborrowing there, two or three transactions with gas on each, and a new liquidation price at the new venue."].filter(Boolean).join(" "));
  }
  if (mine && !assumed && !disagree) { if (Math.abs(drift) >= 10) P.push(`${name(mine, offers)} shows ${pct(mine.apr)} on this pair right now, ${Math.abs(drift)} bps ${drift > 0 ? "above" : "below"} what you quoted; variable rates move under you.`); }
  else if (myVenue && !mine) P.push(`I couldn't match "${myVenue}" to a venue on this pair, so this compares against every deep venue.`);
  const link = args.json ? null : pairLinkOnce(mem, chainId, coll, borrow, null); if (link) P.push(link);
  return P.join("\n\n");
}
// Same baseline as market moves: the 7-days-ago reading is the median of that day and its neighbours, so a one-day blip isn't a week's move.
function typicalWeeklySwing(list) { const v = list.filter((o) => !o.suspect && (o.liquidityUsd || 0) >= DEEP && o.sparkline?.length >= 8).map((o) => { const s = [...o.sparkline, o.apr]; const i = s.length - 1 - 7; const w = s.slice(Math.max(0, i - 1), i + 2).sort((a, b) => a - b); return Math.abs(bps(o.apr - w[Math.floor(w.length / 2)])); }).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; }

// ---------------- helpers ----------------
// One row per protocol, except Morpho: its markets are separate books, so a deeper Morpho market stays when the cheapest one can't take the size.
function bestPerProtocol(sorted) { const seen = new Set(); const need = size || DEEP; return sorted.filter((o) => { const k = o.protocol + (/prime/i.test(o.venue) ? ":prime" : ""); if (seen.has(k)) { if (o.protocol === "morpho-blue" && !seen.has(k + ":deep") && (o.liquidityUsd || 0) >= need) { seen.add(k + ":deep"); return true; } return false; } seen.add(k); if ((o.liquidityUsd || 0) >= need) seen.add(k + ":deep"); return true; }); }
function matchVenue(o, v) { const n = o.venue.toLowerCase(); if (v === "aave") return o.protocol === "aave-v3" && !/prime/.test(n); if (v === "prime") return /prime/.test(n); if (v === "morpho") return o.protocol === "morpho-blue"; if (v === "compound") return o.protocol === "compound-v3"; return o.protocol.includes(v) || n.includes(v); }
function sameVenue(a, b) { return a.protocol === b.protocol && /prime/i.test(a.venue) === /prime/i.test(b.venue) && (a.protocol !== "morpho-blue" || a.venue === b.venue); }
function name(o, ctx) { return venueName(o, ctx); }
function grid(H, R) { const w = H.map((h, i) => Math.max(h.length, ...R.map((r) => String(r[i]).length))); const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join("  ").trimEnd(); return [line(H), ...R.map(line)]; }
function alias(sym) { let s = String(sym).toUpperCase().replace(/^\$/, ""); s = T.aliases[s] || s; if (s === "BTC") s = "CBBTC"; return s; }
function addr(chain, sym) { return (T.tokens[String(chain)] || {})[sym]; }
function disp(sym) { return T.display[sym] || sym; }
function chainName(id) { return { 1: "Ethereum", 8453: "Base", 42161: "Arbitrum" }[id] || `chain ${id}`; }
function pct(x) { return `${Number(x).toFixed(2)}%`; }
function ltvS(x) { return x == null ? "" : `${Number(x).toFixed(Number.isInteger(Number(x)) ? 0 : 1)}%`; }
function signed(n) { return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)}`; }
function pctShare(x) { return x < 0.01 ? "under 1%" : x > 1 ? "more than there is" : `${(x * 100).toFixed(0)}%`; }
function usdShort(x) { if (x == null) return "?"; if (x >= 1e9) return `$${(x / 1e9).toFixed(1)}B`; if (x >= 1e6) return `$${(x / 1e6).toFixed(1)}M`; if (x >= 1e4) return `$${(x / 1e3).toFixed(0)}k`; if (x >= 1e3) return `$${(Math.round(x / 100) * 100).toLocaleString("en-US")}`; return `$${Math.round(x)}`; }
function die(m) { console.error(m); process.exit(2); }
function parseArgs(a) { const o = {}; for (let i = 0; i < a.length; i++) { const k = a[i]; if (k.startsWith("--")) { const key = k.slice(2); const v = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : true; o[key] = v; } } return o; }
