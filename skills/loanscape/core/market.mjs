#!/usr/bin/env node
// The explorer door: one pair, answered the way a desk would. Prints finished text; the skill passes it through.
//
//   node market.mjs --coll ETH --borrow USDC [--chain ethereum|base|arbitrum] [--size 500000] [--venues aave,morpho] [--rank rate|ltv|liquidity|stability] [--table] [--json]
//
// Modes: read (default, three to four lines), sized (--size), head-to-head (--venues), table (--table).
// Rule of thumb used throughout: a loan should stay under 10% of a venue's available depth or expect to move the rate.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchOffers, deepLink, loadMem, saveMem, pairLinkOnce, venueName } from "./lib/offers.mjs";
import { bps, fmtPerM, dollarsPerYear, trustedHistory } from "./lib/rules.mjs";
import { mdTable, sparkline, depthBar, shareBar } from "./lib/table.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const T = JSON.parse(readFileSync(join(HERE, "tokens.json"), "utf8"));
const DEPTH_SHARE = 0.10, OFFER_AFTER = 1, ASKED_MIN_MS = 3600 * 1000;

const args = parseArgs(process.argv.slice(2));
if (!args.coll || !args.borrow) { console.error("usage: node market.mjs --coll ETH --borrow USDC [--chain ethereum|base|arbitrum] [--size 500000] [--venues aave,morpho] [--rank rate|ltv|liquidity|stability] [--table] [--json]"); process.exit(2); }
const chainId = T.chains[String(args.chain || "ethereum").toLowerCase()]; if (!chainId) die(`unknown chain "${args.chain}"`);
const rank = String(args.rank || "rate").toLowerCase(); if (!["rate", "ltv", "liquidity", "stability"].includes(rank)) die(`unknown rank "${args.rank}"`);
const size = args.size ? Number(String(args.size).replace(/[$,_kKmM]/g, (m) => ({ k: "e3", K: "e3", m: "e6", M: "e6" }[m] || ""))) : null;
const venueFilter = args.venues ? String(args.venues).toLowerCase().split(",").map((s) => s.trim()).filter(Boolean) : null;

const collSyms = expand(args.coll), borrowSyms = expand(args.borrow);
const pairs = await Promise.all(collSyms.flatMap((c) => borrowSyms.map(async (b) => {
  const ca = addr(chainId, c), ba = addr(chainId, b);
  if (!ca || !ba) return { coll: disp(c), borrow: disp(b), error: `I don't have ${!ca ? disp(c) : disp(b)} mapped on ${chainName(chainId)}.` };
  try { const m = await fetchOffers(chainId, ca, ba); return { coll: m.coll?.symbol || disp(c), borrow: m.borrow?.symbol || disp(b), collYield: m.coll?.yieldApr || 0, updatedAt: m.updatedAt, offers: m.offers.filter((o) => o.apr != null).map((o) => ({ ...o, ...trustedHistory(o) })) }; }
  catch (e) { return { coll: disp(c), borrow: disp(b), error: `Couldn't reach Loanscape for ${disp(c)} → ${disp(b)}: ${e.message}` }; }
})));

const mem = loadMem(); mem.marketQueries = (mem.marketQueries || 0) + 1; mem.asked ||= {};
if (rank !== "rate") args.table = true; // asking for a criterion is asking for the ranking, not for the rate read again
const plainRead = !args.table && !size && !(venueFilter && venueFilter.length >= 2);
const offerWallet = plainRead && !mem.defaultWallet && !mem.offeredWallet && mem.marketQueries >= OFFER_AFTER;
if (offerWallet) mem.offeredWallet = true;
const out = { chainId, rank, size, venues: venueFilter, pairs: pairs.map((p) => ({ ...p, offers: p.offers?.map((o) => ({ ...o, share: size && o.liquidityUsd ? size / o.liquidityUsd : null })) })), offerWallet, text: null };
const plainReadOut = pairs.some((p) => !p.error) && plainRead;
out.text = pairs.map(renderPair).join("\n\n") + (offerWallet && !plainReadOut ? "\n\nPaste a wallet address and I'll read your open loans." : "");
function paragraphs(L) { const out = []; let inTable = false; for (const l of L) { if (l === "") continue; const isRow = l.startsWith("|"); if (isRow && !inTable) { out.push(""); inTable = true; } else if (!isRow && inTable) { out.push(""); inTable = false; } else if (!isRow) { if (out.length) out.push(""); } out.push(l); } return out.join("\n"); }
if (!args.json) saveMem(mem);
if (args.json) console.log(JSON.stringify(out, null, 2)); else console.log(out.text);

// ---------------- render ----------------
function renderPair(p) {
  const pair = `${p.coll} → ${p.borrow}`;
  if (p.error) return `${pair}: ${p.error}`;
  let offers = p.offers;
  if (venueFilter) offers = offers.filter((o) => venueFilter.some((v) => matchVenue(o, v)));
  if (!offers.length) return `${pair} on ${chainName(chainId)}: no venues ${venueFilter ? `matching ${venueFilter.join(", ")}` : "returned"} right now.`;
  const link = args.json ? null : pairLinkOnce(mem, chainId, p.coll, p.borrow, { ltv: "capeff", liquidity: "liq", stability: "stable" }[rank] || null);
  if (args.table) return table(pair, offers, link, p);
  if (venueFilter && venueFilter.length >= 2) return headToHead(pair, offers, link, p);
  if (size) return sized(pair, offers, link);
  return read(pair, offers, link, p);
}

// One line of ranking, one or two lines of contrast, the link.
function read(pair, offers, link, p) {
  const byRate = sortBy(offers, "rate"); const top = bestPerProtocol(byRate).slice(0, 3);
  const L = [`${pair} on ${chainName(chainId)}, cheapest by rate right now: ${top.map((o) => `${short(o, top)} ${pct(o.apr)}`).join(", ")}.`];
  const c = contrasts(top, offers); L.push(...c.map((x) => x.text));
  const since = sinceAsked(p, top); if (since) L.push(since);
  if (link) L.push(link);
  L.push(nextMove(top, offers, c));
  return paragraphs(L);
}
// One next move, chosen from what the read showed, not a menu of what the script can do.
// Depth decided the answer: ask the size. Another venue leads on LTV: offer that ranking. The cheapest swings: offer steadiness.
// The once-ever wallet offer rides the same line, so a first lookup still ends in one line.
function nextMove(top, offers, c) {
  const cheapest = top[0]; const kinds = new Set(c.map((x) => x.kind));
  const ltvLead = sortBy(offers, "ltv")[0];
  const move = kinds.has("depth") ? `What size? The answer flips at about ${usdShort(cheapest.liquidityUsd * DEPTH_SHARE)}.`
    : ltvLead && ltvLead !== cheapest && ltvLead.maxLtv != null && cheapest.maxLtv != null && ltvLead.maxLtv - cheapest.maxLtv >= 3 ? `Say borrowing power and I'll rank by it instead.`
    : kinds.has("volatile") ? `Say steadiness and I'll rank by it instead.`
    : `Give me a size and I'll pick for it.`;
  return offerWallet ? `${move} Or paste a wallet address and I'll read your open loans.` : move;
}
// "Since you asked on Thursday: Spark +12 bps, Aave −30 bps." Once the last ask is over an hour old; then the snapshot refreshes.
function sinceAsked(p, top) {
  const key = `${chainId}:${p.coll}/${p.borrow}`; const prev = mem.asked[key]; const now = new Date().toISOString();
  const snap = Object.fromEntries(p.offers.map((o) => [o.venue, o.apr]));
  if (args.json) return null;
  if (!prev) { mem.asked[key] = { at: now, rates: snap }; return null; }
  if (Date.now() - new Date(prev.at).getTime() < ASKED_MIN_MS) return null;
  const moves = top.map((o) => ({ o, d: prev.rates[o.venue] != null ? Math.round((o.apr - prev.rates[o.venue]) * 100) : null })).filter((x) => x.d != null && Math.abs(x.d) >= 10);
  mem.asked[key] = { at: now, rates: snap };
  if (!moves.length) return `Since you asked ${whenWord(prev.at)}: no venue here moved 10 bps.`;
  return `Since you asked ${whenWord(prev.at)}: ${moves.map(({ o, d }) => `${short(o, top)} ${d > 0 ? "+" : "−"}${Math.abs(d)} bps`).join(", ")}.`;
}
function whenWord(iso) { const d = new Date(iso), now = new Date(); const days = (now - d) / 86400000; if (days < 1 && now.getDate() === d.getDate()) return "earlier today"; if (days < 2) return "yesterday"; if (days < 7) return `on ${d.toLocaleDateString("en-US", { weekday: "long" })}`; return `on ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`; }
function contrasts(top, offers) {
  const L = [];
  const deepest = sortBy(offers, "liquidity")[0]; const cheapest = top[0];
  if (deepest && cheapest && deepest !== cheapest && cheapest.liquidityUsd && deepest.liquidityUsd / cheapest.liquidityUsd >= 3) L.push({ kind: "depth", text: `${short(deepest)} has ${ratio(deepest.liquidityUsd / cheapest.liquidityUsd)} ${short(cheapest)}'s depth (${usdShort(deepest.liquidityUsd)} against ${usdShort(cheapest.liquidityUsd)}). Keeping a loan under a tenth of what's available, ${short(cheapest)} fits up to about ${usdShort(cheapest.liquidityUsd * DEPTH_SHARE)}; above that, ${short(deepest)} at ${pct(deepest.apr)}.` });
  const vol = top.find((o) => !o.suspect && o.stability === "volatile" && o.sparkline?.length > 5);
  if (vol) L.push({ kind: "volatile", text: `${short(vol)} ran ${pct(Math.min(...vol.sparkline), 0)} to ${pct(Math.max(...vol.sparkline), 0)} last month.` });
  if (L.length < 2) { const ltvLead = sortBy(offers, "ltv")[0]; if (ltvLead && ltvLead !== cheapest && ltvLead.maxLtv != null && cheapest.maxLtv != null && ltvLead.maxLtv - cheapest.maxLtv >= 3) L.push({ kind: "ltv", text: `Most borrowing power is ${short(ltvLead)} at ${ltvS(ltvLead.maxLtv)} LTV, for ${pct(ltvLead.apr)}.` }); }
  return L.slice(0, 2);
}
// At a given size: who can take it, who is cheapest among them, where the crossover sits.
function sized(pair, offers, link) {
  const byRate = bestPerProtocol(sortBy(offers, "rate"));
  const fits = byRate.filter((o) => o.liquidityUsd && size <= o.liquidityUsd * DEPTH_SHARE);
  const stretch = byRate.filter((o) => o.liquidityUsd && size > o.liquidityUsd * DEPTH_SHARE && size <= o.liquidityUsd);
  const L = [];
  if (!fits.length && !stretch.length) { L.push(`${pair} on ${chainName(chainId)}: nothing has ${usdShort(size)} available on this pair right now. Deepest is ${short(byRate.sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0])} at ${usdShort(byRate[0].liquidityUsd)}.`); if (link) L.push(link); return paragraphs(L); }
  const best = fits[0] || stretch[0];
  L.push(`For ${usdShort(size)} of ${pair} on ${chainName(chainId)}: ${short(best)} at ${pct(best.apr)}, where you'd be ${pctShare(size / best.liquidityUsd)} of the book.`);
  if (fits.length === byRate.length && byRate.length > 1) { const dearest = byRate[byRate.length - 1]; L.push(`Every venue can take ${usdShort(size)}, so the cheapest rate simply wins; the spread to ${short(dearest)} at ${pct(dearest.apr)} is about ${usdShort(dollarsPerYear(bps(dearest.apr - best.apr), size))} a year.`); }
  const cheaper = byRate.find((o) => o.apr < best.apr && o !== best);
  if (cheaper) {
    const bps = Math.round((best.apr - cheaper.apr) * 100);
    if (cheaper.liquidityUsd && size <= cheaper.liquidityUsd) L.push(`${short(cheaper)} is ${bps} bps cheaper but ${usdShort(size)} is ${pctShare(size / cheaper.liquidityUsd)} of what's there, so expect to move the rate.`);
    else L.push(`${short(cheaper)} is ${bps} bps cheaper but only has ${usdShort(cheaper.liquidityUsd)} available.`);
    L.push(`Under about ${usdShort(cheaper.liquidityUsd * DEPTH_SHARE)}, ${short(cheaper)}. Above, ${short(best)}.`);
  } else if (best.maxLtv != null) L.push(`Max LTV there is ${best.maxLtv}%; ${usdShort(size)} needs about ${usdShort(size / (best.maxLtv / 100))} of ${pair.split(" → ")[0]} at the limit, more for headroom.`);
  if (link) L.push(link);
  return paragraphs(L);
}
// Two or more named venues.
function headToHead(pair, offers, link, p) {
  const picks = bestPerProtocol(sortBy(offers, "rate"));
  if (picks.length < 2) return read(pair, offers, link, p);
  if (size) {
    const can = picks.filter((o) => o.liquidityUsd && size <= o.liquidityUsd);
    if (!can.length) {
      const L = [`Neither can take ${usdShort(size)} of ${pair} on ${chainName(chainId)} today: ${picks.map((o) => `${short(o, picks)} has ${usdShort(o.liquidityUsd)} available`).join(", ")}.`];
      return L.concat(sized(pair, p.offers, link).split("\n")).join("\n");
    }
    const [a, b] = can.length >= 2 ? can : [can[0], picks.find((o) => o !== can[0])];
    const L = [`For ${usdShort(size)} of ${pair} on ${chainName(chainId)}: ${short(a, picks)} ${pct(a.apr)}, where you'd be ${pctShare(size / a.liquidityUsd)} of the book${b.liquidityUsd && size <= b.liquidityUsd ? `; ${short(b, picks)} ${pct(b.apr)}, ${pctShare(size / b.liquidityUsd)} of its book` : `; ${short(b, picks)} only has ${usdShort(b.liquidityUsd)} available`}.`];
    const gap = bps(b.apr - a.apr); const bFunds = b.liquidityUsd && size <= b.liquidityUsd;
    if (gap && !bFunds && gap < 0) L.push(`${short(b, picks)} is ${Math.abs(gap)} bps cheaper on paper, but ${usdShort(b.liquidityUsd)} of depth won't take ${usdShort(size)}.`);
    else if (gap) L.push(`${gap > 0 ? short(a, picks) : short(b, picks)} is ${Math.abs(gap)} bps cheaper, about ${usdShort(dollarsPerYear(Math.abs(gap), size))} a year at that size${a.maxLtv != null && b.maxLtv != null && a.maxLtv !== b.maxLtv ? `; max LTV ${a.maxLtv}% against ${b.maxLtv}%` : ""}.`);
    if (link) L.push(link);
    return paragraphs(L);
  }
  const [a, b] = picks; const gap = bps(b.apr - a.apr);
  const L = [`${pair} on ${chainName(chainId)} today: ${short(a, picks)} ${pct(a.apr)} against ${short(b, picks)} ${pct(b.apr)}, ${gap} bps, ${fmtPerM(gap)}.`];
  if (a.liquidityUsd && b.liquidityUsd && b.liquidityUsd / a.liquidityUsd >= 2) {
    L.push(`But ${short(a, picks)} has ${usdShort(a.liquidityUsd)} available and ${short(b, picks)} ${usdShort(b.liquidityUsd)}. Under about ${usdShort(a.liquidityUsd * DEPTH_SHARE)}, ${short(a, picks)}. Above that, ${short(b, picks)}, or you'll move the rate you came for.`);
  } else {
    const ltv = a.maxLtv != null && b.maxLtv != null && a.maxLtv !== b.maxLtv ? `LTV ${a.maxLtv}% against ${b.maxLtv}%` : null;
    const st = a.stability && b.stability && a.stability !== b.stability ? `${short(a, picks)} ${a.stability}, ${short(b, picks)} ${b.stability} over 30 days` : null;
    const d = `depth ${usdShort(a.liquidityUsd)} against ${usdShort(b.liquidityUsd)}`;
    L.push(`${[ltv, st, d].filter(Boolean).join("; ")}.`);
  }
  if (picks.length > 2) L.push(`Also ${picks.slice(2).map((o) => `${short(o, picks)} ${pct(o.apr)}`).join(", ")}.`);
  if (link) L.push(link);
  return paragraphs(L);
}
function table(pair, offers, link, p) {
  const sorted = sortBy(offers, rank);
  const maxLiq = Math.max(...sorted.map((o) => o.liquidityUsd || 0));
  const showDepthBar = rank === "liquidity"; const showShare = !!size;
  const H = ["venue", "borrow APR", "max LTV", "available", ...(showDepthBar ? [""] : []), ...(showShare ? ["your share", ""] : []), "30 days", "", "market"];
  const A = ["l", "r", "r", "r", ...(showDepthBar ? ["l"] : []), ...(showShare ? ["r", "l"] : []), "l", "l", "l"];
  const rows = sorted.map((o) => [tableLabel(o.venue), pct(o.apr), ltvS(o.maxLtv), usdShort(o.liquidityUsd),
    ...(showDepthBar ? [depthBar(o.liquidityUsd, maxLiq)] : []),
    ...(showShare ? [o.liquidityUsd ? pctShare(size / o.liquidityUsd) : "", shareBar(size, o.liquidityUsd)] : []),
    sparkline(o.sparkline, o.apr), o.stability || "", marketNote(o)]);
  const lead = sorted[0]; const boldCol = { rate: 1, ltv: 2, liquidity: 3, stability: 3 + (showDepthBar ? 1 : 0) + (showShare ? 2 : 0) + 2 }[rank];
  const answer = rank === "ltv" ? `Most borrowing power on ${pair}: ${short(lead, sorted)} at ${ltvS(lead.maxLtv)} LTV, for ${pct(lead.apr)}.`
    : rank === "liquidity" ? `Deepest on ${pair}: ${short(lead, sorted)} with ${usdShort(lead.liquidityUsd)} available, at ${pct(lead.apr)}.`
    : rank === "stability" ? `Steadiest on ${pair} over 30 days: ${short(lead, sorted)}, ${pct(lead.apr)} now, ${pct(Math.min(...lead.sparkline, lead.apr))} to ${pct(Math.max(...lead.sparkline, lead.apr))} in the month.`
    : `${pair} on ${chainName(chainId)}, cheapest by rate: ${short(lead, sorted)} ${pct(lead.apr)}.`;
  const L = [answer, "", mdTable(H, rows, A, { rows: new Set([0]), cols: [0, boldCol] }), "", `Ranked by ${rankLabel(rank)}, as of ${p.updatedAt?.slice(0, 16).replace("T", " ") || "now"} UTC.`];
  if (p.collYield) L.push(`${p.coll} yields ${pct(p.collYield)} on its own; rates above are gross.`);
  if (link) L.push(link);
  return L.join("\n");
}
// Table labels keep the version but drop the instance noise: "Aave v3 · Prime Instance" → "Aave v3 Prime", "Spark · Main" → "Spark".
function tableLabel(v) { return String(v).replace(" Instance", "").replace(" · Main", "").replace(/ · /g, " "); }
function grid(H, rows) { const w = H.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length))); const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join("  ").trimEnd(); return [line(H), ...rows.map(line)]; }
function marketNote(o) { const n = String(o.note || ""); if (/governance/i.test(n)) return "governance rate"; if (/isolated/i.test(n)) return "isolated market"; if (/smart/i.test(n)) return "smart collateral"; if (/pooled/i.test(n)) return "pooled"; if (/comet|base market/i.test(n)) return "pooled"; return n.toLowerCase(); }
// ---------------- logic ----------------
function matchVenue(o, v) { const name = o.venue.toLowerCase(); if (v === "aave") return o.protocol === "aave-v3" && !/prime/.test(name); if (v === "prime") return /prime/.test(name); if (v === "morpho") return o.protocol === "morpho-blue"; if (v === "compound") return o.protocol === "compound-v3"; return o.protocol.includes(v) || name.includes(v); }
function bestPerProtocol(sorted) { const seen = new Set(); return sorted.filter((o) => { const k = o.protocol + (/prime/i.test(o.venue) ? ":prime" : ""); if (seen.has(k)) return false; seen.add(k); return true; }); }
function sortBy(list, r) { const c = [...list]; if (r === "rate") c.sort((a, b) => a.apr - b.apr); if (r === "ltv") c.sort((a, b) => (b.maxLtv ?? -1) - (a.maxLtv ?? -1)); if (r === "liquidity") c.sort((a, b) => (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1)); if (r === "stability") c.sort((a, b) => spread(a.sparkline) - spread(b.sparkline)); return c; }
function spread(s) { return s && s.length > 1 ? Math.max(...s) - Math.min(...s) : 1e9; }

// ---------------- helpers ----------------
function expand(sym) { let s = String(sym).toUpperCase().replace(/^\$/, ""); s = T.aliases[s] || s; if (s === "BTC") return T.btcGroup.map((x) => x.toUpperCase()); return [s]; }
function addr(chain, sym) { return (T.tokens[String(chain)] || {})[sym]; }
function disp(sym) { return T.display[sym] || sym; }
function chainName(id) { return { 1: "Ethereum", 8453: "Base", 42161: "Arbitrum" }[id] || `chain ${id}`; }
function ltvS(x) { return x == null ? "" : `${Number(x).toFixed(Number.isInteger(Number(x)) ? 0 : 1)}%`; }
function rankLabel(r) { return { rate: "lowest borrow APR", ltv: "highest max LTV", liquidity: "deepest available liquidity", stability: "steadiest 30-day rate" }[r]; }
function short(o, ctx) { return venueName(o, ctx); }
function pct(x, dp = 2) { return `${Number(x).toFixed(dp)}%`; }
function pctShare(x) { return x < 0.01 ? "under 1%" : x > 1 ? "more than there is" : `${(x * 100).toFixed(0)}%`; }
function ratio(r) { return r >= 10 ? `${Math.round(r)}x` : `${r.toFixed(1)}x`; }
function range30(s, cur) { const v = [...(s || []), ...(cur == null ? [] : [cur])]; return v.length < 2 ? "n/a" : `${pct(Math.min(...v))}–${pct(Math.max(...v))}`; }
function usdShort(x) { if (x == null) return "?"; if (x >= 1e9) return `$${(x / 1e9).toFixed(1)}B`; if (x >= 1e6) return `$${(x / 1e6).toFixed(1)}M`; if (x >= 1e4) return `$${(x / 1e3).toFixed(0)}k`; if (x >= 1e3) return `$${(Math.round(x / 100) * 100).toLocaleString("en-US")}`; return `$${Math.round(x)}`; }
function die(m) { console.error(m); process.exit(2); }
function parseArgs(a) { const o = {}; for (let i = 0; i < a.length; i++) { const k = a[i]; if (k.startsWith("--")) { const key = k.slice(2); const v = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : true; o[key] = v; } } return o; }
