#!/usr/bin/env node
// Market moves: what changed in borrow markets over the last N days, from the 30-day rate history the Loanscape API carries
// per venue. No feed, no memory. History is gated by the suspect-endpoint rule (lib/rules.mjs); the live rate is truth.
//
//   node moves.mjs [--chain ethereum|base|arbitrum] [--days 7] [--pair ETH/USDC] [--json]
//
// Without --pair: the cross-market read over the curated pairs. With --pair: that pair's 30-day story, venue by venue.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchOffers, loadMem, saveMem, pairLinkOnce, venueName } from "./lib/offers.mjs";
import { bps, trustedHistory } from "./lib/rules.mjs";
import { mdTable, sparkline } from "./lib/table.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const T = JSON.parse(readFileSync(join(HERE, "tokens.json"), "utf8"));
const CURATED = [["WETH", "USDC"], ["WSTETH", "USDC"], ["CBBTC", "USDC"], ["WBTC", "USDC"], ["WSTETH", "WETH"]];
const R = { moverBps: 25, stepBps: 50, streakDays: 3, minDepthUsd: 1e6, maxLines: 4, otherChainBps: 50 };
const mem = loadMem();

const args = parseArgs(process.argv.slice(2));
const chainArg = args.chain ? T.chains[String(args.chain).toLowerCase()] : null; if (args.chain && !chainArg) die(`unknown chain "${args.chain}"`);
const days = Math.max(1, Math.min(30, Number(args.days || 7)));
const only = args.pair ? String(args.pair).toUpperCase().replace(/^\$/, "").split(/[\/→>-]+/).map((s) => T.aliases[s.trim()] || s.trim()) : null;
const pairs = only ? [only] : CURATED;
// Pair mode reads one chain (Ethereum unless named). Cross mode with no chain named sweeps Ethereum, Base and Arbitrum.
const chainIds = chainArg ? [chainArg] : only ? [1] : [1, 8453, 42161];
const chainId = chainIds[0];

async function scan(cid) {
  const markets = (await Promise.all(pairs.map(async ([c, b]) => {
    const ca = addr(cid, c), ba = addr(cid, b); if (!ca || !ba) return [];
    try {
      const m = await fetchOffers(cid, ca, ba);
      return m.offers.filter((o) => o.apr != null).map((o) => ({ ...o, ...trustedHistory(o), chainId: cid, pair: `${m.coll?.symbol || disp(c)} → ${m.borrow?.symbol || disp(b)}`, coll: m.coll?.symbol || disp(c), borrow: m.borrow?.symbol || disp(b) }));
    } catch (e) { return [{ chainId: cid, pair: `${disp(c)} → ${disp(b)}`, error: e.message }]; }
  }))).flat();
  const errs = markets.filter((m) => m.error); const live = markets.filter((m) => !m.error);
  for (const m of live) Object.assign(m, stats(m));
  // A pooled venue (Aave, Spark, Compound, Fluid) is one market per borrow asset whatever the collateral; report it once.
  // Isolated markets (Morpho) are one per pair. marketRef identifies the underlying market when the API gives one.
  const seen = new Map();
  for (const m of live) { const k = m.protocol === "morpho-blue" ? `${m.protocol}|${m.marketRef || m.venue}|${m.pair}` : `${m.protocol}|${/prime/i.test(m.venue) ? "prime" : "main"}|${m.borrow}|${m.apr}`; if (seen.has(k)) { seen.get(k).colls.push(m.coll); m.dup = true; } else { m.colls = [m.coll]; seen.set(k, m); } }
  return { chainId: cid, live, uniq: live.filter((m) => !m.dup), errs };
}
const scans = await Promise.all(chainIds.map(scan));
const { live, uniq, errs } = scans[0];
const out = { chains: chainIds, days, pairs: pairs.map((p) => p.join("/")), markets: scans.flatMap((sc) => sc.uniq.map(({ sparkline, ...m }) => m)), errors: scans.flatMap((sc) => sc.errs), text: null };
out.text = only ? renderPair() : renderCross();
if (!args.json) saveMem(mem);
if (args.json) console.log(JSON.stringify(out, null, 2)); else console.log(out.text);

// ---------------- stats ----------------
function stats(m) {
  const s = m.sparkline; const n = s.length;
  if (n < 2 || m.suspect) return { hasHistory: false };
  const series = [...s, m.apr]; // history then the live reading
  // The baseline is the median of the day and its neighbours, so a one-day blip N days ago doesn't read as an N-day move.
  const ago = series.length - 1 - days; const past = ago >= 0 ? median(series.slice(Math.max(0, ago - 1), ago + 2)) : series[0];
  const change = bps(m.apr - past);
  const lo = Math.min(...series), hi = Math.max(...series);
  const posInRange = hi > lo ? (m.apr - lo) / (hi - lo) : 0.5;
  let streak = 0; for (let i = series.length - 1; i > 0; i--) { const d = series[i] - series[i - 1]; if (streak === 0) streak = d > 0 ? 1 : d < 0 ? -1 : 0; else if ((streak > 0 && d > 0) || (streak < 0 && d < 0)) streak += Math.sign(streak); else break; }
  let biggestStep = { bps: 0, at: null }; for (let i = Math.max(1, series.length - days); i < series.length; i++) { const d = bps(series[i] - series[i - 1]); if (Math.abs(d) > Math.abs(biggestStep.bps)) biggestStep = { bps: d, daysAgo: series.length - 1 - i, before: series[i - 1] }; }
  // A step the live rate has since undone (back within 40% of the step of where it started) is reported as reverted, not as current.
  if (biggestStep.daysAgo > 0 && bps(m.apr - biggestStep.before) / biggestStep.bps <= 0.4) biggestStep.reverted = true;
  return { hasHistory: true, past, change, lo, hi, posInRange, streak, biggestStep, deep: (m.liquidityUsd || 0) >= R.minDepthUsd };
}

// ---------------- render: cross-market ----------------
function crossLines(sc) {
  const hist = sc.uniq.filter((m) => m.hasHistory); if (!hist.length) return [];
  const movers = hist.filter((m) => m.deep && Math.abs(m.change) >= R.moverBps).sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  const steps = hist.filter((m) => m.deep && Math.abs(m.biggestStep.bps) >= R.stepBps && !movers.slice(0, 2).includes(m)).sort((a, b) => Math.abs(b.biggestStep.bps) - Math.abs(a.biggestStep.bps));
  const flips = flipsByPair(sc.live.filter((m) => m.hasHistory));
  const streaks = hist.filter((m) => m.deep && Math.abs(m.streak) >= R.streakDays && !movers.includes(m)).sort((a, b) => Math.abs(b.streak) - Math.abs(a.streak));
  const lines = [];
  movers.slice(0, 2).forEach((m, i) => lines.push(`${where(m)} ${m.change > 0 ? "up" : "down"} ${Math.abs(m.change)} bps${i === 0 && sc.chainId === 1 ? ` (${(Math.abs(m.change) / 100).toFixed(1)} points)` : ""} to ${pct(m.apr)}${edge(m)}.`));
  for (const m of steps.slice(0, 1)) lines.push(`${where(m)} stepped ${m.biggestStep.bps > 0 ? "up" : "down"} ${Math.abs(m.biggestStep.bps)} bps in a day, ${ago(m.biggestStep.daysAgo)}${m.biggestStep.reverted ? `, since reverted to ${pct(m.apr)}` : ""}.`);
  for (const f of flips.slice(0, 1)) lines.push(`Cheapest venue with real depth for ${f.pair} is now ${f.to} at ${pct(f.toApr)}; ${days} days ago it was ${f.from}, now ${pct(f.fromApr)}.`);
  for (const m of streaks.slice(0, 1)) lines.push(`${where(m)} has ${m.streak > 0 ? "risen" : "fallen"} ${Math.abs(m.streak)} days running.`);
  return lines;
}
function renderCross() {
  const L = [];
  const total = scans.reduce((s, sc) => s + sc.uniq.length, 0);
  const per = scans.map((sc) => ({ sc, lines: crossLines(sc) }));
  const home = per[0]; const homeName = chainName(home.sc.chainId);
  const cover = `${listJoin(chainIds.map(chainName))}, ${days} day${days === 1 ? "" : "s"}, ${total} markets.`;
  if (!scans.some((sc) => sc.uniq.some((m) => m.hasHistory))) return `No trusted rate history right now. ${cover}`;
  if (home.lines.length) { L.push(`${home.lines[0]} ${cover}`); if (home.lines[1]) L.push(home.lines[1]); }
  else { const widest = home.sc.uniq.filter((m) => m.deep && m.hasHistory).sort((a, b) => Math.abs(b.change) - Math.abs(a.change))[0]; L.push(`${homeName} quiet: nothing with real depth moved ${R.moverBps} bps or more${widest ? `; the most was ${where(widest)}, ${widest.change > 0 ? "up" : "down"} ${Math.abs(widest.change)} bps` : ""}. ${cover}`); }
  const quietChains = [];
  for (const { sc } of per.slice(1)) {
    const big = sc.uniq.filter((m) => m.hasHistory && m.deep && (Math.abs(m.change) >= R.otherChainBps || Math.abs(m.biggestStep.bps) >= R.otherChainBps)).sort((a, b) => Math.abs(b.change) - Math.abs(a.change))[0];
    if (big && L.length < 3) L.push(`On ${chainName(sc.chainId)}: ${where(big)} ${Math.abs(big.change) >= R.otherChainBps ? `${big.change > 0 ? "up" : "down"} ${Math.abs(big.change)} bps to ${pct(big.apr)}${edge(big)}` : `stepped ${big.biggestStep.bps > 0 ? "up" : "down"} ${Math.abs(big.biggestStep.bps)} bps in a day, ${ago(big.biggestStep.daysAgo)}${big.biggestStep.reverted ? ", since reverted" : ""}`}.`);
    else quietChains.push(chainName(sc.chainId));
  }
  if (quietChains.length) L.push(`${listJoin(quietChains)} quiet.`);
  const suspect = [...new Set(scans.flatMap((sc) => sc.uniq.filter((m) => m.suspect)).map(where))];
  if (suspect.length) L[0] = L[0].replace(/ markets\.$/, ` markets; ${listJoin(suspect.slice(0, 2))} skipped, history unreliable.`);
  return L.join("\n");
}
function flipsByPair(hist) {
  const out = []; const byPair = groupBy(hist.filter((m) => m.deep), (m) => m.pair);
  for (const [pair, ms] of Object.entries(byPair)) { if (ms.length < 2) continue; const now = [...ms].sort((a, b) => a.apr - b.apr)[0]; const then = [...ms].sort((a, b) => a.past - b.past)[0]; if (now !== then && name(now) !== name(then)) out.push({ pair, from: name(then), to: name(now), toApr: now.apr, fromApr: then.apr }); }
  return out;
}

// ---------------- render: one pair ----------------
function renderPair() {
  const ms = uniq.filter((m) => m.hasHistory).sort((a, b) => a.apr - b.apr); const pair = live[0]?.pair || pairs[0].join(" → ");
  if (!ms.length) return `${pair} on ${chainName(chainId)}: no trusted rate history right now.`;
  const deep = ms.filter((m) => m.deep); const up = deep.filter((m) => m.change >= 10).length, down = deep.filter((m) => m.change <= -10).length;
  // Direction by count of deep venues, checked against the depth-weighted move; when they disagree, say both.
  const wsum = deep.reduce((a, m) => a + m.liquidityUsd, 0); const wnet = wsum ? deep.reduce((a, m) => a + m.change * m.liquidityUsd, 0) / wsum : 0;
  const byCount = !up && !down ? "flat" : up && !down ? "up" : down && !up ? "down" : up > down ? "mostly up" : down > up ? "mostly down" : "mixed";
  const byDepth = wnet >= 10 ? "up" : wnet <= -10 ? "down" : "flat";
  const agree = byDepth === "flat" ? /flat|mixed/.test(byCount) : byCount.includes(byDepth);
  const verdict = agree ? byCount : `${byCount} by venue, ${byDepth} where the depth is (${wnet > 0 ? "+" : ""}${Math.round(wnet)} bps weighted)`;
  const L = [`${pair} on ${chainName(chainId)}, last ${days} days: ${verdict}.`, ""];
  const ranked = [...ms].sort((a, b) => (b.deep - a.deep) || (Math.abs(b.change) - Math.abs(a.change))).slice(0, 7);
  const rows = ranked.map((m) => [name(m, ms), pct(m.apr), Math.abs(m.change) >= 10 ? `${m.change > 0 ? "+" : "−"}${Math.abs(m.change)} bps` : "flat", sparkline(m.sparkline, m.apr), Math.abs(m.streak) >= R.streakDays && Math.abs(m.change) >= 10 ? `${Math.abs(m.streak)} days ${m.streak > 0 ? "up" : "down"}` : "", m.posInRange >= 0.9 ? "high" : m.posInRange <= 0.1 ? "low" : "", Math.abs(m.biggestStep.bps) >= R.stepBps ? `${Math.abs(m.biggestStep.bps)} bps ${m.biggestStep.bps > 0 ? "jump" : "drop"} ${ago(m.biggestStep.daysAgo)}${m.biggestStep.reverted ? ", reverted" : ""}` : "", m.deep ? "" : `thin, ${usdShort(m.liquidityUsd)}`]);
  const H = ["venue", "now", `${days}d`, "30 days", "run", "30d", "step", ""]; const A = ["l", "r", "r", "l", "l", "l", "l", "l"];
  const keep = H.map((_, i) => i < 4 || rows.some((r) => r[i])); const HH = H.filter((_, i) => keep[i]); const AA = A.filter((_, i) => keep[i]); const RR = rows.map((r) => r.filter((_, i) => keep[i]));
  L.push(mdTable(HH, RR, AA, -1));
  const suspect = live.filter((m) => m.suspect); if (suspect.length) L.push("", `${listJoin([...new Set(suspect.map((m) => name(m, ms)))])} left out: rate history disagrees with the live rate.`);
  const link = args.json ? null : pairLinkOnce(mem, chainId, live[0]?.coll || pairs[0][0], live[0]?.borrow || pairs[0][1], null);
  if (link) L.push("", link);
  return L.join("\n");
}

function where(m) { return m.protocol === "morpho-blue" ? `${name(m)} on ${m.pair}` : `${name(m)} ${m.borrow} borrowing`; }
// ---------------- helpers ----------------
function median(a) { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; }
function edge(m) { return m.posInRange >= 0.95 ? ", a 30-day high" : m.posInRange <= 0.05 ? ", a 30-day low" : ""; }
function ago(d) { return d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`; }
function name(o, ctx) { return venueName(o, ctx); }
function groupBy(list, f) { const o = {}; for (const x of list) (o[f(x)] ||= []).push(x); return o; }
function usdShort(x) { if (x == null) return "?"; if (x >= 1e9) return `$${(x / 1e9).toFixed(1)}B`; if (x >= 1e6) return `$${(x / 1e6).toFixed(1)}M`; if (x >= 1e3) return `$${(x / 1e3).toFixed(0)}k`; return `$${Math.round(x)}`; }
function lower(t) { return /^[A-Z][a-z]/.test(t) && !/^(Aave|Spark|Morpho|Compound|Fluid|Cheapest)/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t; }
function listJoin(a) { return a.length <= 1 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]; }
function addr(chain, sym) { return (T.tokens[String(chain)] || {})[sym]; }
function disp(sym) { return T.display[sym] || sym; }
function chainName(id) { return { 1: "Ethereum", 8453: "Base", 42161: "Arbitrum" }[id] || `chain ${id}`; }
function pct(x) { return `${Number(x).toFixed(2)}%`; }
function die(m) { console.error(m); process.exit(2); }
function parseArgs(a) { const o = {}; for (let i = 0; i < a.length; i++) { const k = a[i]; if (k.startsWith("--")) { const key = k.slice(2); const v = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : true; o[key] = v; } } return o; }
