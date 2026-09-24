#!/usr/bin/env node
// The manager brief: positions, ranked by urgency, with one money line and what changed since last time.
// Prints the finished text; the skill passes it through. --json for the structured form.
//
//   node brief.mjs [--wallet <0x | name.eth>] [--chain ethereum|base|arbitrum|all] [--json] [--no-save] [--ladder <position#> [--shock <pct>]]
//   --full prints the whole brief on a quiet repeat run, which otherwise is one line.
//   --move <position#> prints the five moves in order of cost (do nothing, add collateral, repay some, refinance, close) with the numbers for each.
//   With no --wallet, every remembered wallet is read into one brief. --json, --ladder and --move never write memory.
//   A full read is cached for CACHE_MS ($LOANSCAPE_HOME/cache.json); --json, --ladder, --move and --full within that window reuse it
//   instead of reading the chain again, so follow-ups are instant and never write memory.
//
// Memory: $LOANSCAPE_HOME/memory.json (default ~/.loanscape). Holds the remembered wallet(s) and the last snapshot per wallet,
// which is what makes the second run better than the first. Nothing leaves the machine except the RPC and API reads.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fetchOffers, deepLink, loadMem, saveMem, memPath, cachePath, venueName, pairLinkOnce } from "./lib/offers.mjs";
import { trustedHistory } from "./lib/rules.mjs";
import { mdTable } from "./lib/table.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MEM = memPath();
let saved = false;
const CACHE_MS = 10 * 60 * 1000;
const T = { urgentDropPct: 15, urgentHealth: 1.15, urgentRateStepBps: 100, refiMinBps: 20, refiMinUsdPerYear: 100, risingDays: 3, diffPricePct: 2, diffHeadroomPts: 2, diffRateBps: 10, diffDebtPct: 1, idleMinUsd: 50, moveTargetPct: 30, urgentLstPct: 3, urgentStablePct: 0.75, rateAgreeBps: 25 };

const args = parseArgs(process.argv.slice(2));
const mem = loadMem();
// One wallet when given; otherwise every remembered wallet, one brief.
// Remembered wallets read in the order they were added, so adding a second one never renumbers the first one's rows.
const walletArgs = args.wallet ? [args.wallet] : Object.keys(mem.wallets).sort((a, b) => String(mem.wallets[a].firstSeen || "").localeCompare(String(mem.wallets[b].firstSeen || "")));
if (!walletArgs.length) { console.log(args.json ? JSON.stringify({ needWallet: true }) : "NEED_WALLET"); process.exit(0); }
// Rows are numbered as the brief printed them, whatever flag follows: ladder and move both read every remembered wallet.

// 1. positions, per wallet, merged. A follow-up (--json, --ladder, --move, --full) with no --wallet reuses the last full read when fresh.
const followUp = !args.wallet && !!(args.json || args.ladder || args.move || args.full);
const cache = followUp ? loadCache(walletArgs) : null;
const runs = [];
if (cache) { for (const r of cache.runs) { r.prev = mem.wallets[r.wallet] || null; runs.push(r); } }
else for (const w of walletArgs) {
  let r;
  try { r = JSON.parse(execFileSync(process.execPath, [join(HERE, "positions.mjs"), "--wallet", w, "--chain", args.chain || "all", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 24 })); }
  catch (e) { // the read itself died (ENS or every endpoint down): same state as every venue failing
    const known = /^0x[0-9a-fA-F]{40}$/.test(w) ? w.toLowerCase() : Object.keys(mem.wallets).find((k) => mem.wallets[k].label === w) || w;
    r = { wallet: known, resolvedFrom: /^0x/i.test(w) ? null : w, chains: [], fetchedAt: new Date().toISOString(), status: "failed", positions: [], errors: [{ venue: "every venue", error: firstReason(String(e.stderr || e.message || e)) }] };
  }
  r.status ||= r.errors?.length ? "partial" : "ok";
  r.prev = mem.wallets[r.wallet] || null; r.label = r.resolvedFrom || r.prev?.label || null;
  for (const p of r.positions) { p.walletKey = r.wallet; p.walletLabel = r.label || short(r.wallet); }
  runs.push(r);
}
const multi = runs.length > 1;
// Three states, said differently everywhere: checked and quiet (ok), partly checked (partial), unable to check (failed).
const status = runs.every((r) => r.status === "failed") ? "failed" : runs.some((r) => r.status !== "ok") ? "partial" : "ok";
const okRuns = runs.filter((r) => r.status !== "failed");
const pos = { wallet: runs[0].wallet, resolvedFrom: runs[0].label, fetchedAt: runs[0].fetchedAt, chains: (okRuns[0] || runs[0]).chains, coverage: runs[0].coverage, positions: runs.flatMap((r) => r.positions), errors: runs.flatMap((r) => r.errors.map((e) => ({ ...e, wallet: r.label || short(r.wallet) }))) };
const key = pos.wallet;
const prev = runs[0].prev;
const firstRun = runs.every((r) => !r.prev);
// A venue that didn't answer this run: its loans from the last good read are carried, never reported as closed.
const failedVenue = (r, key, entry) => r.status === "failed" || (r.errors || []).some((e) => { const proto = key.split(":")[1]; return e.chainId === entry.chainId && e.protocol === proto && (proto === "morpho-blue" || proto === "fluid" || e.venue === entry.venue); });
const prevFor = (p) => runs.find((r) => r.wallet === p.walletKey)?.prev;

// 2. market context: the position's dominant pair (largest collateral × largest debt); partial when the position holds more than that pair
for (const p of pos.positions) {
  p.key = posKey(p);
  if (cache) continue;
  const c = p.collateral.filter((x) => x.address && x.usd != null).sort((a, b) => b.usd - a.usd)[0], d = p.debt.filter((x) => x.address && x.usd != null).sort((a, b) => b.usd - a.usd)[0];
  if (!c || !d) continue;
  p.pair = { coll: c, debt: d, partial: p.collateral.length > 1 || p.debt.length > 1 };
  try {
    const m = await fetchOffers(p.chainId, c.address, d.address);
    m.offers = m.offers.map((o) => ({ ...o, ...trustedHistory(o) })); p.market = m; p.mine = matchOwnOffer(p, m.offers);
    p.best = bestAlternative(p, m.offers);
  } catch (e) { p.marketError = String(e.message || e); }
}
if (!cache && status !== "failed") saveCache(walletArgs, runs); // a read that failed is never served to a follow-up

// 3. findings
const findings = [];
for (const p of pos.positions) {
  const name = label(p);
  const L = p.liquidationPrice;
  const dist = L?.direction === "up" ? L.risePct : L?.dropPct;
  p.tier = riskTier(p);
  const limit = p.tier === "stable" ? T.urgentStablePct : p.tier === "lst" ? T.urgentLstPct : T.urgentDropPct;
  const healthUrgent = p.tier === "volatile" && p.healthFactor != null && p.healthFactor < T.urgentHealth; // stable loops run at 1.01–1.03 by design
  if ((dist != null && dist <= limit) || healthUrgent) {
    const verb = p.tier === "stable" ? "depegs" : "drops";
    const txt = L?.direction === "up" && dist != null ? `${name} liquidates if ${L.symbol} rises ${dist.toFixed(0)}%, to ${usd(L.price)}.`
      : dist != null ? `${name} liquidates if ${L.symbol} ${verb} ${dist.toFixed(0)}%, to ${usd(L.price)}.` : `${name} is close to liquidation.`;
    findings.push({ tier: "urgent", kind: "liq", key: p.key, inRow: !!L?.price, text: `${txt} Health ${fmtHf(p.healthFactor)}.` });
  }
  const before = prevFor(p)?.snapshot?.[p.key];
  if (before && p.borrowApr != null && before.apr != null && Math.abs(p.borrowApr - before.apr) * 100 >= T.urgentRateStepBps) {
    findings.push({ tier: "urgent", kind: "step", key: p.key, text: `${name} rate stepped from ${pct(before.apr)} to ${pct(p.borrowApr)} since ${when(prevFor(p).lastRun)}.` });
  }
  const q = refiQuote(p);
  if (q && !q.uncertain && (q.bps >= T.refiMinBps || q.perYear >= T.refiMinUsdPerYear)) {
    const what = p.pair.partial ? `the ${p.pair.coll.symbol} → ${p.pair.debt.symbol} part of the ${venueShort(p)} position` : `the ${loanName(p)} loan`;
    const text = q.range ? `${cap(offerShort(p.best, p))} would charge ${pct(p.best.apr)} on ${what}: at least ${q.bps} bps and ${usd(q.perYear)} a year less than you pay now, with ${usdShort(p.best.liquidityUsd)} available there.`
      : `${cap(offerShort(p.best, p))} would charge ${pct(p.best.apr)} on ${what}: about ${usd(q.newCost)} a year instead of ${usd(q.nowCost)}, ${q.bps} bps less, with ${usdShort(p.best.liquidityUsd)} available there.`;
    findings.push({ tier: "worth", key: p.key, kind: "refi", value: q.perYear, bps: q.bps, perYear: q.perYear, venue: offerShort(p.best, p), loan: p.pair.partial ? `${p.pair.coll.symbol} → ${p.pair.debt.symbol} part of the ${venueShort(p)}` : loanName(p), text, link: deepLink(linkSym(p.pair.coll.symbol), linkSym(p.pair.debt.symbol), null) });
  }
  if (p.mine?.sparkline?.length >= T.risingDays + 1 && !p.mine.suspect) {
    const s = p.mine.sparkline.slice(-(T.risingDays + 1)); const rising = s.every((v, i) => i === 0 || v > s[i - 1]);
    const what = p.pair?.partial ? `the ${p.pair.coll.symbol} → ${p.pair.debt.symbol} rate on ${venueShort(p)}` : `${name}'s rate`;
    if (rising) findings.push({ tier: "worth", key: p.key, kind: "trend", name: what, from: s[0], to: s[s.length - 1], text: `${what} has risen ${T.risingDays} days running, ${pct(s[0])} to ${pct(s[s.length - 1])}.` });
  }
  if (firstRun && p.supplied?.length) {
    const idle = p.supplied.filter((c) => c.usd >= T.idleMinUsd).sort((a, b) => b.usd - a.usd);
    if (idle.length) findings.push({ tier: "worth", key: p.key, kind: "idle", value: idle.reduce((s, c) => s + c.usd, 0) / 100, text: `${idle.map((c) => `${amt(c.amount)} ${c.symbol}`).join(" and ")} on ${venueShort(p)} ${idle.length === 1 ? "isn't" : "aren't"} enabled as collateral, so ${idle.length === 1 ? "it adds" : "they add"} no headroom to the loan.` });
  }
  if (p.mine?.recLtv != null && p.ltv != null && p.ltv * 100 > p.mine.recLtv) {
    const stable = p.tier !== "volatile"; // stable and LST loops both run near their ceiling by design
    findings.push({ tier: "worth", key: p.key, kind: "ltv", name, venue: venueShort(p), pair: p.pair ? `${p.pair.coll.symbol} → ${p.pair.debt.symbol}` : null, stable, ltvPct: Math.round(p.ltv * 100), ceil: p.mine.recLtv,
      text: stable ? `${cap(name)} sits at ${(p.ltv * 100).toFixed(0)}% LTV, which is how these markets run; the working ceiling Loanscape gives it is ${p.mine.recLtv}%.` : `${cap(name)} sits at ${(p.ltv * 100).toFixed(0)}% LTV, above the ${p.mine.recLtv}% Loanscape treats as the working ceiling there.` });
  }
}
const urgent = findings.filter((f) => f.tier === "urgent");
// Two lines at most, the ones worth the most: a refinance by dollars a year, idle collateral by a hundredth of its value, the rest after.
const worth = collapse(dedupe(findings.filter((f) => f.tier === "worth"))).sort((a, b) => (b.value || 0) - (a.value || 0)).slice(0, 2);
{ const linkMem = args.json || args.ladder || args.move || args["no-save"] ? JSON.parse(JSON.stringify(mem)) : mem;
  for (const f of worth) if (f.kind === "refi") { const p = pos.positions.find((x) => x.key === f.key); f.linkLine = pairLinkOnce(linkMem, p.chainId, linkSym(p.pair.coll.symbol), linkSym(p.pair.debt.symbol)); } }

// 4. diff since last run, per wallet, merged
const diffs = runs.filter((r) => r.prev && r.status !== "failed").map((r) => ({ r, d: computeDiff(r.prev, { positions: r.positions }, (k, e) => failedVenue(r, k, e)) }));
const diff = diffs.length ? { lines: diffs.flatMap(({ r, d }) => d.lines.map((l) => (multi ? `${r.label || short(r.wallet)}: ${l}` : l))).slice(0, 3), all: diffs.flatMap(({ d }) => d.all) } : null;
if (diff) { const stepped = new Set(urgent.filter((u) => u.kind === "step").map((u) => u.key)); if (stepped.size) diff.lines = diff.lines.filter((l) => !/ rate .* → /.test(l)); }
const lastRunOf = () => { const ts = runs.map((r) => r.prev?.lastRun).filter(Boolean).sort(); return ts[0] || null; };

// 5. persist, per wallet
const snapshotOf = (r) => Object.fromEntries(r.positions.map((p) => [p.key, { venue: p.venue, chainId: p.chainId, debtUsd: p.debtUsd, collateralUsd: p.collateralUsd, ltv: p.ltv, dropPct: p.liquidationPrice?.direction === "up" ? (p.liquidationPrice.risePct ?? null) : (p.liquidationPrice?.dropPct ?? null), apr: p.borrowApr, collSymbol: p.collateral[0]?.symbol ?? null, collPrice: p.collateral[0]?.priceUsd ?? null, health: p.healthFactor }]));
if (!args["no-save"] && !args.json && !args.ladder && !args.move && !cache && status !== "failed") {
  for (const r of okRuns) {
    const keys = [...urgent, ...worth].flatMap((f) => (f.keys || [f.key]).filter((k) => r.positions.some((p) => p.key === k)).map((k) => f.kind + ":" + k));
    const carried = Object.fromEntries(Object.entries(r.prev?.snapshot || {}).filter(([k, e]) => failedVenue(r, k, e) && !r.positions.some((p) => p.key === k)));
    const carriedKeys = (r.prev?.findingKeys || []).filter((fk) => carried[fk.slice(fk.indexOf(":") + 1)]);
    mem.wallets[r.wallet] = { label: r.label, firstSeen: r.prev?.firstSeen || r.fetchedAt, lastRun: r.fetchedAt, snapshot: { ...carried, ...snapshotOf(r) }, findingKeys: [...keys, ...carriedKeys], runs: (r.prev?.runs || 0) + 1 };
  }
  if (args.wallet && okRuns.some((r) => r.wallet === key)) mem.defaultWallet = key; else if (!mem.defaultWallet) mem.defaultWallet = okRuns[0].wallet;
  saved = saveMem(mem);
}

// 6. output
const who = multi ? `${runs.length} wallets` : (pos.resolvedFrom || prev?.label || short(key));
const couldNot = () => `I couldn't read ${who}'s positions just now, so I can't run the numbers. Say retry and I'll read them again.`;
if (args.ladder) { console.log(status === "failed" ? couldNot() : ladder(Number(args.ladder))); process.exit(0); }
if (args.move) { console.log(status === "failed" ? couldNot() : moveLadder(Number(args.move))); process.exit(0); }
const urgentAll = findings;
const out = { wallet: key, status, wallets: runs.map((r) => ({ wallet: r.wallet, label: r.label })), label: pos.resolvedFrom || prev?.label || null, firstRun, lastRun: lastRunOf(), fetchedAt: pos.fetchedAt, positions: pos.positions.map(strip), urgent, worth, diff, errors: pos.errors, coverage: pos.coverage, memoryPath: MEM, text: render() };
if (args.json) console.log(JSON.stringify(out, null, 2)); else console.log(out.text);

// ---------------- render ----------------
function render() {
  const L = [];
  const n = pos.positions.length;
  const prevKeys = new Set(runs.flatMap((r) => r.prev?.findingKeys || []));
  const isOld = (f) => (f.keys || [f.key]).every((k) => prevKeys.has(f.kind + ":" + k));
  // grouped per chain by family: "Aave, Compound and Fluid on Base", not one entry per comet or instance
  const fam = (e) => ({ "aave-v3": "Aave", sparklend: "Spark", "compound-v3": "Compound", "morpho-blue": "Morpho", fluid: "Fluid" })[e.protocol] || e.venue.split(" ")[0];
  const byChain = {}; for (const e of pos.errors) if (e.venue !== "every venue") (byChain[e.chainId] ||= new Set()).add(fam(e));
  const errs = Object.entries(byChain).map(([c, f]) => `${listJoin([...f])} on ${chainName(Number(c))}`);
  const unread = errs.length ? `Could not read ${listJoin(errs)} this time, so a loan there isn't in this brief.` : null;
  if (status === "failed") {
    const ens = pos.errors.map((x) => x.error || "").find((x) => /ENS name|not an address/.test(x));
    if (ens) { L.push(`I couldn't check ${who}: ${ens.replace(/^Error:\s*/, "").replace(/\.$/, "")}.`); L.push(`Check the spelling, or paste the 0x address.`); return L.join("\n"); }
    L.push(`I couldn't check ${who}'s positions: none of the venues answered${reason()}.`);
    const last = runs.map((r) => r.prev).filter((x) => x?.lastRun);
    if (last.length) {
      const snaps = last.flatMap((x) => Object.values(x.snapshot || {})); const debt = snaps.reduce((t, e) => t + (e.debtUsd || 0), 0);
      L.push(`The last good read was ${when(last.map((x) => x.lastRun).sort()[0])}: ${snaps.length ? `${snaps.length} position${snaps.length === 1 ? "" : "s"}, ${usd(debt)} borrowed` : "no open positions"}. That's kept as is, so the next brief still compares against it.`);
    }
    L.push(`Say retry and I'll read them again.`);
    return L.join("\n");
  }
  if (!n) {
    if (status === "partial") { L.push(`No open borrow positions for ${who} in the venues that answered.`); L.push(unread + " Say retry and I'll read them again."); return L.join("\n"); }
    L.push(`No open borrow positions for ${who}.`);
    L.push(`I read Aave, Spark, Morpho, Compound and Fluid on ${listJoin(pos.chains.map(chainName))}.`);
    return L.join("\n");
  }
  const scope = status === "partial" ? " in what I could read" : "";
  // A position with no health and no LTV (an unpriced Fluid smart vault, say) was never assessed; the verdict says so instead of covering it.
  const unpriced = pos.positions.filter((p) => p.healthFactor == null && p.ltv == null);
  const priced = n - unpriced.length;
  const verdict = urgent.length ? (urgent.length === 1 ? "One needs attention." : `${urgent.length} need attention.`)
    : unpriced.length ? `Nothing urgent in the ${priced === 1 ? "one" : words(priced)} I could price${scope}; the ${listJoin(unpriced.map((p) => `${venueShort(p)} ${p.debt[0]?.symbol || ""} loan`.replace("  ", " ")))} ${unpriced.length === 1 ? "is" : "are"} unpriced and not assessed.`
    : `Nothing urgent${scope}.`;
  const oldWorth = worth.filter(isOld), newWorth = worth.filter((f) => !isOld(f));
  const still = oldWorth.map((f) => f.kind === "refi" ? `${cap(f.venue)} still ${f.bps} bps cheaper on the ${f.loan} loan, about ${usd(f.perYear)} a year.` : null).filter(Boolean);
  const across = multi ? ` across ${runs.length} wallets` : "";
  const newWallets = runs.filter((r) => !r.prev);
  const yearly = pos.positions.reduce((t, p) => t + (p.debtUsd && p.borrowApr != null ? (p.debtUsd * p.borrowApr) / 100 : 0), 0);
  const cost = yearly >= 1 ? `, about ${usd(yearly)} a year in interest` : "";
  const noRates = [...new Set(pos.positions.filter((p) => p.marketError).map((p) => p.pair ? `${p.pair.coll.symbol} → ${p.pair.debt.symbol}` : shortName(p)))];
  // An incomplete check explains the gap before any assessment.
  if (unread) { L.push(unread); L.push(""); }
  if (firstRun) L.push(`Found ${n} position${n === 1 ? "" : "s"}${across}${cost}. ${verdict}`);
  else {
    const since = when(lastRunOf());
    // Quiet return: one line of status, the rows only on request (--full). Describes what's known; doesn't decide for the user.
    // A standing saving doesn't make the day noisy: it rides the quiet line as one clause, so the daily user still gets one line.
    const quiet = !diff?.lines.length && !urgent.length && !newWorth.length && !newWallets.length && !noRates.length;
    if (quiet && status === "ok" && !args.full) return `Since ${since}: no material changes across ${multi ? `${n} positions in ${runs.length} wallets` : n === 1 ? "your one position" : `your ${n} positions`}${cost ? ` (${cost.slice(2)})` : ""}.${still.length ? " " + still.join(" ") : ""}`;
    const added = newWallets.length ? ` Added ${listJoin(newWallets.map((r) => r.label || short(r.wallet)))}.` : "";
    const head = (diff?.lines.length ? `Since ${since}: ${diff.lines.join(" ")}` : `Since ${since}: no material changes${scope}.`) + added;
    L.push([head, quiet ? "" : verdict, ...still].filter(Boolean).join(" "));
  }
  const urgentKeys = new Set(urgent.map((u) => u.key));
  L.push(""); L.push(table(urgentKeys));
  const detail = [];
  urgent.filter((u) => !u.inRow).forEach((u) => detail.push(cap(u.text)));
  if (newWorth.length === 1) detail.push(`One thing worth knowing: ${newWorth[0].text}`);
  else newWorth.forEach((w) => detail.push(`Worth knowing: ${w.text}`));
  for (const w of newWorth) if (w.kind === "refi" && w.linkLine) detail.push(w.linkLine);
  if (urgent.some((u) => u.kind === "liq")) detail.push("Want the numbers on adding collateral or paying some down?");
  if (noRates.length) detail.push(`Loanscape's rates didn't load for ${listJoin(noRates)}, so there's no rate or refinance check on ${noRates.length === 1 ? "it" : "them"} this time.`);
  if (detail.length) { L.push(""); L.push(...detail); }
  if (firstRun) { L.push(""); L.push(`${status === "ok" ? "Checked Aave, Spark, Morpho, Compound and Fluid" : "Checked the other venues"} on ${listJoin(pos.chains.map(chainName))}. ${saved ? "Wallet saved." : "Couldn't save this wallet here, so paste it again next time."}`); if (saved) L.push(`Run /loanscape any morning for what's changed.`); }
  return L.join("\n");
}
// One markdown table, the venue table's style. Urgent rows carry the venue and health cells in bold.
function table(urgentKeys) {
  const H = ["venue", "collateral", "debt", "rate", "LTV", "liquidation", "health"], A = ["l", "l", "l", "r", "r", "r", "r"];
  const rows = pos.positions.map((p) => {
    const side = (list, total) => list.length <= 1 ? list.map((c) => `${amt(c.amount)} ${c.symbol}`).join("") || "none" : `${list.map((c) => c.symbol).join(" + ")} (${usd(total)})`;
    const L = p.liquidationPrice;
    const pc = (x) => (x < 1 ? x.toFixed(1) : x.toFixed(0)) + "%";
    const liq = L?.price && L.direction === "up" ? `${L.symbol} up to ${usd(L.price)} (+${pc(L.risePct)})`
      : L?.price ? `${usd(L.price)} ${L.symbol} (−${pc(L.dropPct)})`
      : L?.note && /other collateral/.test(L.note) ? "covered by other collateral"
      : p.note ? "unpriced" : "n/a";
    const chain = pos.chains.length > 1 && p.chainId !== 1 ? ` (${chainName(p.chainId)})` : "";
    const wal = multi ? ` [${p.walletLabel}]` : "";
    const emode = p.emode ? " e-mode" : "";
    return [`${venueShort(p)}${chain}${wal}${emode}`, side(p.collateral, p.collateralUsd), side(p.debt, p.debtUsd), p.borrowApr != null ? pct(p.borrowApr) : "", p.ltv != null ? `${(p.ltv * 100).toFixed(0)}%` : "n/a", liq, p.healthFactor != null ? fmtHf(p.healthFactor) : ""];
  });
  const hot = new Set(pos.positions.map((p, i) => (urgentKeys.has(p.key) ? i : -1)).filter((i) => i >= 0));
  return mdTable(H, rows, A, { rows: hot, cols: [0, 6] });
}

// Collateral kind decides how much room counts as urgent. The API's coll.kind when present (eth, btc, lst, stable).
// When the API gives no kind (un-curated assets), the collateral counts as stable if the debt is near $1 and the collateral symbol
// contains "USD": yield-bearing stables (syrupUSDC $1.18, sUSDe $1.25) price well above $1, so a near-$1 test on both sides misses them.
function riskTier(p) {
  const ck = p.market?.coll?.kind || null, dk = p.market?.borrow?.kind || null;
  const nearOne = (x) => x?.priceUsd != null && Math.abs(x.priceUsd - 1) < 0.05;
  const debtStable = dk === "stable" || (!dk && p.debt.every(nearOne));
  if (ck === "stable" && debtStable) return "stable";
  if (ck === "lst" && dk === "eth") return "lst";
  if (ck) return "volatile";
  if (debtStable && p.collateral.every((c) => /USD/i.test(c.symbol || ""))) return "stable";
  return "volatile";
}

// ---------------- ladder ----------------
// LTV and health for the dominant collateral asset moved −10/−20/−30% (or the borrowed asset +10/+20/+30% when the risk runs that way),
// then the collateral to add or debt to repay to get back to the venue's working ceiling.
function ladder(n) {
  const p = pos.positions[n - 1];
  if (!p) return `No position ${n}. The brief numbers them 1 to ${pos.positions.length}.`;
  const L = p.liquidationPrice; const up = L?.direction === "up";
  const colls = p.collateral.filter((c) => c.usd != null); const lt = (c) => c.liquidationThreshold ?? p.liquidationThreshold;
  if (!colls.length || !p.debtUsd || colls.some((c) => !lt(c))) return `${cap(label(p))}: ${p.note || "not enough priced data for a ladder."}`;
  const main = colls.reduce((a, b) => (b.usd > a.usd ? b : a)); const others = colls.filter((c) => c !== main);
  const debtMain = up ? p.debt.filter((d) => d.usd != null).sort((a, b) => b.usd - a.usd)[0] : null;
  const at = (shock) => { // shock as a fraction: −0.10 on collateral, or +0.10 on the borrowed asset
    const collUsd = up ? p.collateralUsd : main.usd * (1 + shock) + others.reduce((s, c) => s + c.usd, 0);
    const cover = up ? colls.reduce((s, c) => s + c.usd * lt(c), 0) : main.usd * (1 + shock) * lt(main) + others.reduce((s, c) => s + c.usd * lt(c), 0);
    const debt = up ? p.debtUsd + debtMain.usd * shock : p.debtUsd;
    return { ltv: debt / collUsd, health: cover / debt };
  };
  const out = [];
  const ltPct = (p.liquidationThreshold * 100).toFixed(0);
  const sym = up ? debtMain.symbol : main.symbol;
  const shock = args.shock != null ? Math.abs(Number(args.shock)) / 100 : null;
  if (shock) {
    const r = at(up ? shock : -shock); const distNow = up ? L?.risePct : L?.dropPct;
    // distance left from the shocked price, as a move of that price: (1+r)/(1+s)−1 up, 1−(1−d)/(1−s) down; not points subtracted
    const left = distNow == null ? null : up ? ((1 + distNow / 100) / (1 + shock) - 1) * 100 : (1 - (1 - distNow / 100) / (1 - shock)) * 100;
    out.push(r.health < 1.01 && r.health >= 1 ? `${sym} ${up ? "+" : "−"}${(shock * 100).toFixed(0)}% puts ${label(p)} on the liquidation line, health ${fmtHf(r.health)}.`
      : r.health < 1 ? `${sym} ${up ? "+" : "−"}${(shock * 100).toFixed(0)}% liquidates ${label(p)}${distNow != null ? `; liquidation comes at ${up ? "+" : "−"}${distNow.toFixed(0)}%` : ""}.`
      : `${sym} ${up ? "+" : "−"}${(shock * 100).toFixed(0)}% leaves ${label(p)} open at LTV ${(r.ltv * 100).toFixed(0)}%, health ${fmtHf(r.health)}${left != null ? `, with liquidation a further ${left.toFixed(0)}% ${up ? "rise" : "drop"} away` : ""}.`);
  }
  out.push(`${shock ? "Now" : cap(label(p))}: LTV ${(p.ltv * 100).toFixed(0)}%, health ${fmtHf(p.healthFactor)}. ${venueShort(p)} liquidates at ${ltPct}% LTV.`);
  for (const k of [0.1, 0.2, 0.3]) { const r = at(up ? k : -k); out.push(`  ${sym} ${up ? "+" : "−"}${(k * 100).toFixed(0)}%   LTV ${(r.ltv * 100).toFixed(0)}%   health ${fmtHf(r.health)}${r.health < 1 ? "   liquidated" : ""}`); }
  if (L?.price) out.push(up ? `  liquidates if ${L.symbol} rises to ${usd(L.price)} (+${L.risePct.toFixed(0)}%).` : `  liquidates at ${usd(L.price)} ${L.symbol} (−${L.dropPct.toFixed(0)}%)${L.note ? `, ${L.note}` : ""}.`);
  else if (L?.note) out.push(`  ${L.note}.`);
  const ceil = p.mine?.recLtv != null ? p.mine.recLtv / 100 : p.mine?.maxLtv != null ? p.mine.maxLtv / 100 : null;
  if (ceil) {
    const src = p.mine?.recLtv != null ? `Loanscape's working ceiling here is ${(ceil * 100).toFixed(0)}% LTV, the level to stay under rather than the ${ltPct}% where you'd be liquidated.` : `The venue's max LTV is ${(ceil * 100).toFixed(0)}%.`;
    if (p.ltv <= ceil) { const room = p.collateralUsd * ceil - p.debtUsd; out.push(`${src} You're under it with ${usd(room)} of borrowing room.`); }
    else { const add = p.debtUsd / ceil - p.collateralUsd, repay = p.debtUsd - p.collateralUsd * ceil; out.push(`${src} To get back under it: add ${usd(add)} of collateral or repay ${usd(repay)}.`); }
  }
  return out.join("\n");
}

// ---------------- move ladder ----------------
// "Should I move it?" answered as the five moves in order of cost. Refinance is step four, not the reflex.
// Headroom target: back under the venue's working ceiling if the loan is over it; otherwise a liquidation distance of T.moveTargetPct.
function moveLadder(n) {
  const p = pos.positions[n - 1];
  if (!p) return `No position ${n}. The brief numbers them 1 to ${pos.positions.length}.`;
  if (!p.debtUsd || p.collateralUsd == null || !p.liquidationThreshold) return `${cap(label(p))}: ${p.note || "not enough priced data to lay out the moves."}`;
  const L = p.liquidationPrice; const up = L?.direction === "up"; const dist = up ? L?.risePct : L?.dropPct;
  const lt = p.liquidationThreshold; const ceil = p.mine?.recLtv != null ? p.mine.recLtv / 100 : null;
  const yearly = p.borrowApr != null ? (p.debtUsd * p.borrowApr) / 100 : null;
  const main = p.collateral.filter((c) => c.usd != null).sort((a, b) => b.usd - a.usd)[0]; const debtMain = p.debt.filter((d) => d.usd != null).sort((a, b) => b.usd - a.usd)[0];
  const out = [`Should you move ${label(p)}? The moves, from leaving it alone to closing it.`];
  // 1 do nothing
  const stand = [yearly != null ? `${usd(yearly)} a year` : null, dist != null ? `liquidation ${up ? "a " + dist.toFixed(0) + "% rise" : "a " + dist.toFixed(0) + "% drop"} away` : p.healthFactor != null ? `health ${fmtHf(p.healthFactor)}` : null, ceil != null ? (p.ltv <= ceil ? `under the ${(ceil * 100).toFixed(0)}% working ceiling` : `over the ${(ceil * 100).toFixed(0)}% working ceiling`) : null].filter(Boolean);
  out.push(`1  Do nothing: ${stand.join(", ")}.`);
  // 2 add collateral / 3 repay some, to the same target
  const overCeil = ceil != null && p.ltv > ceil;
  const targetDist = T.moveTargetPct / 100;
  let addUsd = null, repayUsd = null, goal = null;
  if (overCeil) { addUsd = p.debtUsd / ceil - p.collateralUsd; repayUsd = p.debtUsd - p.collateralUsd * ceil; goal = `get back under the ${(ceil * 100).toFixed(0)}% working ceiling`; }
  else if (dist != null && dist < T.moveTargetPct) {
    if (up) { const needColl = (p.debtUsd * (1 + targetDist)) / lt; addUsd = needColl - p.collateralUsd; repayUsd = p.debtUsd - (p.collateralUsd * lt) / (1 + targetDist); goal = `put liquidation a ${T.moveTargetPct}% rise away`; }
    else { const needColl = p.debtUsd / (lt * (1 - targetDist)); addUsd = needColl - p.collateralUsd; repayUsd = p.debtUsd - p.collateralUsd * lt * (1 - targetDist); goal = `put liquidation a ${T.moveTargetPct}% drop away`; }
  }
  if (goal) {
    const collAmt = main?.priceUsd ? `${amt(addUsd / main.priceUsd)} ${main.symbol} (${usd(addUsd)})` : usd(addUsd);
    const debtAmt = debtMain?.priceUsd ? `${amt(repayUsd / debtMain.priceUsd)} ${debtMain.symbol} (${usd(repayUsd)})` : usd(repayUsd);
    out.push(`2  Add collateral: ${collAmt} would ${goal}.`);
    out.push(`3  Repay some: ${debtAmt} does the same.`);
  } else {
    out.push(`2  Add collateral: not needed for headroom; liquidation is already ${dist != null ? `a ${dist.toFixed(0)}% ${up ? "rise" : "drop"} away` : "far off"}.`);
    out.push(`3  Repay some: same; it only lowers the bill in proportion.`);
  }
  // 4 refinance
  const q = refiQuote(p);
  if (q?.uncertain) {
    out.push(`4  Refinance: can't call it today. The chain shows ${p.pair?.partial ? "this part" : "this loan"} at ${pct(q.chain)}; Loanscape's feed has the same market at ${pct(q.feed)}. ${cap(offerShort(p.best, p))} at ${pct(p.best.apr)} is cheaper than one reading and not the other, so there's no saving to claim until they agree.`);
  } else if (q && q.bps < T.refiMinBps && q.perYear < T.refiMinUsdPerYear) {
    out.push(`4  Refinance: nothing worth a move today. The cheapest alternative with room, ${cap(offerShort(p.best, p))} at ${pct(p.best.apr)}, is ${q.bps} bps less, about ${usd(q.perYear)} a year, under the $${T.refiMinUsdPerYear} a year the brief treats as worth mentioning.`);
  } else if (q) {
    const partUsd = q.partUsd;
    const sharePct = p.best.liquidityUsd ? (partUsd / p.best.liquidityUsd) * 100 : null;
    const share = sharePct != null ? ` (your loan is ${sharePct < 0.1 ? "under 0.1%" : sharePct.toFixed(1) + "%"} of it${sharePct >= 10 ? ", enough to move the rate you came for" : ""})` : "";
    const fit = p.best.maxLtv != null && p.ltv != null ? `, max LTV ${p.best.maxLtv}% against your ${(p.ltv * 100).toFixed(0)}%` : "";
    const what = p.pair?.partial ? `the ${p.pair.coll.symbol} → ${p.pair.debt.symbol} part` : "it";
    const saving = q.range ? `would save at least ${q.bps} bps and ${usd(q.perYear)} a year on ${what} (the chain and Loanscape's feed read your rate ${pct(q.chain)} and ${pct(q.feed)}; the smaller saving is the one quoted)` : `would make ${what} ${usd(q.newCost)} a year instead of ${usd(q.nowCost)}, ${q.bps} bps less`;
    out.push(`4  Refinance: ${cap(offerShort(p.best, p))} at ${pct(p.best.apr)} ${saving}; ${usdShort(p.best.liquidityUsd)} available there${share}${fit}. Repay here, reborrow there, two or three transactions with gas on each.`);
  } else out.push(`4  Refinance: no venue is cheaper on this pair with enough depth for your size today.`);
  // 5 close
  const back = p.collateral.map((c) => `${amt(c.amount)} ${c.symbol}`).join(" + ");
  out.push(`5  Close: repay ${p.debt.map((d) => `${amt(d.amount)} ${d.symbol}`).join(" + ")} and ${back} comes back.`);
  out.push("Your call.");
  return out.join("\n");
}

// ---------------- logic ----------------
function matchOwnOffer(p, offers) {
  const same = offers.filter((o) => o.protocol === p.protocol);
  if (!same.length) return null;
  if (p.protocol === "fluid" && p.vaultAddress) { const hit = same.find((o) => String(o.marketRef || "").toLowerCase() === p.vaultAddress.toLowerCase()); if (hit) return hit; }
  if (p.protocol === "morpho-blue" && p.marketId) { const hit = same.find((o) => (o.marketRef && p.marketId.toLowerCase().startsWith(String(o.marketRef).toLowerCase().replace(/^0x/, ""))) || (o.venue && p.marketId.toLowerCase().includes(o.venue.split("·").pop().trim().toLowerCase()))); if (hit) return hit; }
  const tag = /prime/i.test(p.venue) ? /prime/i : /main/i.test(p.venue) ? /main/i : null;
  if (tag) { const hit = same.find((o) => tag.test(o.venue)); if (hit) return hit; }
  return same[0];
}
// What you pay, read two ways: the chain (what the table shows) and Loanscape's feed for the same market.
// Selection and presentation both go through this, so a venue is never picked on one baseline and priced on another.
function rateBase(p) {
  const chain = p.pair?.partial ? (p.pair.debt.apr ?? p.borrowApr) : p.borrowApr, feed = p.mine?.apr ?? null;
  const vals = [chain, feed].filter((x) => x != null);
  return { chain, feed, hi: vals.length ? Math.max(...vals) : null, agree: vals.length < 2 || Math.abs(chain - feed) * 100 <= T.rateAgreeBps };
}
function bestAlternative(p, offers) {
  const need = p.pair?.partial ? p.pair.debt.usd : p.debtUsd; const b = rateBase(p);
  const c = offers.filter((o) => o.apr != null && o !== p.mine && (o.liquidityUsd ?? 0) >= need && (o.maxLtv == null || p.ltv == null || o.maxLtv >= p.ltv * 100)).sort((a, b) => a.apr - b.apr);
  return c.length && b.hi != null && c[0].apr < b.hi ? c[0] : null;
}
// The saving, or null when there is none. When the two readings agree, it's priced off the chain rate (the table's number).
// When they disagree: cheaper than both → the smaller saving, flagged range; cheaper than one only → uncertain, no saving claimed.
function refiQuote(p) {
  if (!p.best || !p.pair) return null;
  const b = rateBase(p); const partUsd = p.pair.partial ? p.pair.debt.usd : p.debtUsd;
  const base = b.chain ?? b.feed; if (base == null || !partUsd) return null;
  const mk = (cur, extra) => { const bps = Math.round((cur - p.best.apr) * 100); return bps > 0 ? { bps, perYear: (bps / 10000) * partUsd, nowCost: (cur / 100) * partUsd, newCost: (p.best.apr / 100) * partUsd, partUsd, chain: b.chain, feed: b.feed, ...extra } : null; };
  if (b.agree) return mk(base, {});
  const lo = Math.min(b.chain, b.feed);
  if (p.best.apr < lo) return mk(lo, { range: true });
  return { uncertain: true, chain: b.chain, feed: b.feed, partUsd };
}
// The line that says why a read died: an ENS or address complaint if there is one, else the thrown error, never Node's version footer.
function firstReason(t) { const lines = t.split("\n").map((l) => l.trim()).filter(Boolean); return lines.find((l) => /^\w*Error:.*(ENS name|not an address)/.test(l)) || lines.find((l) => /^\w*Error:/.test(l)) || lines[0] || t; }
function reason() {
  const e = pos.errors.map((x) => x.error || "").join(" ");
  return /429|rate.?limit|too many|capacity/i.test(e) ? " (the public endpoints were rate-limiting)" : /timeout|timed out|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|fetch failed|Could not resolve/i.test(e) ? " (the network didn't reach them)" : "";
}
function computeDiff(prev, pos, unread = () => false) {
  const lines = []; const before = prev.snapshot || {};
  const seen = new Set();
  for (const p of pos.positions) {
    const b = before[p.key]; seen.add(p.key);
    if (!b) { lines.push(`New: ${label(p)}.`); continue; }
    const name = shortName(p);
    if (b.collPrice && p.collateral[0]?.priceUsd) { const ch = (p.collateral[0].priceUsd / b.collPrice - 1) * 100; if (Math.abs(ch) >= T.diffPricePct) lines.push(`${p.collateral[0].symbol} ${ch > 0 ? "+" : "−"}${Math.abs(ch).toFixed(0)}%.`); }
    const nowDist = p.liquidationPrice?.direction === "up" ? p.liquidationPrice.risePct : p.liquidationPrice?.dropPct;
    if (b.dropPct != null && nowDist != null && Math.abs(nowDist - b.dropPct) >= T.diffHeadroomPts) lines.push(`Headroom on the ${name} loan ${b.dropPct.toFixed(0)}% → ${nowDist.toFixed(0)}%.`);
    if (b.apr != null && p.borrowApr != null && Math.abs(p.borrowApr - b.apr) * 100 >= T.diffRateBps) lines.push(`${name} rate ${pct(b.apr)} → ${pct(p.borrowApr)}.`);
    if (b.debtUsd && Math.abs(p.debtUsd / b.debtUsd - 1) * 100 >= T.diffDebtPct) lines.push(`${name} debt ${usd(b.debtUsd)} → ${usd(p.debtUsd)}.`);
  }
  for (const k of Object.keys(before)) if (!seen.has(k) && !unread(k, before[k])) lines.push(`Closed: ${before[k].venue}.`);
  const uniq = [...new Set(lines)];
  return { lines: uniq.slice(0, 3), all: uniq };
}
// Two findings from the same rule on two positions become one line naming both.
function collapse(list) {
  const out = []; const byKind = {};
  for (const f of list) (byKind[f.kind] ||= []).push(f);
  for (const [kind, fs] of Object.entries(byKind)) {
    if (fs.length < 2 || !["ltv", "trend"].includes(kind)) { out.push(...fs); continue; }
    const keys = fs.map((f) => f.key); const names = fs.map((f) => f.name.replace(/^the /, ""));
    if (kind === "ltv") {
      const ceils = [...new Set(fs.map((f) => f.ceil))]; const ltvs = fs.map((f) => f.ltvPct); const spread = Math.max(...ltvs) - Math.min(...ltvs);
      const ltvTxt = spread <= 1 ? `at or near ${Math.round(ltvs.reduce((a, b) => a + b) / ltvs.length)}% LTV` : `at ${listJoin(ltvs.map((x) => `${x}%`))} LTV`;
      const venues = [...new Set(fs.map((f) => f.venue))]; const allStable = fs.every((f) => f.stable);
      const total = pos.positions.filter((p) => venues.length === 1 ? venueShort(p) === venues[0] : true).length;
      const who = fs.length === total && venues.length === 1 ? `All ${fs.length === 2 ? "both" : words(fs.length)} ${venues[0]} loans` : `The ${venues.length === 1 ? venues[0] + " " : ""}${listJoin(fs.map((f) => (venues.length === 1 ? f.pair : `${f.venue} ${f.pair}`) || f.name))} loans`;
      const ceilTxt = ceils.length === 1 ? (allStable ? `which is how these markets run; the working ceiling Loanscape gives them is ${ceils[0]}%` : `above the ${ceils[0]}% working ceiling there`) : `above their ${listJoin(fs.map((f) => `${f.ceil}%`))} working ceilings`;
      out.push({ tier: "worth", kind, key: keys.join("+"), keys, text: `${who.replace("All both", "Both")} sit ${ltvTxt}, ${ceilTxt}.` });
    } else {
      // "the Morpho cbBTC → USDC loan's rate" → "cbBTC → USDC"; the shared venue is said once
      const bare = names.map((n) => n.replace(/'s rate$/, "").replace(/ loan$/, "").replace(/ rate on .*$/, "")); const venues = [...new Set(bare.map((n) => n.split(" ")[0]))];
      const pairs = venues.length === 1 ? bare.map((n) => n.split(" ").slice(1).join(" ")) : bare;
      out.push({ tier: "worth", kind, key: keys.join("+"), keys, text: `The ${venues.length === 1 ? venues[0] + " " : ""}${listJoin(pairs)} rates have risen ${T.risingDays} days running, ${listJoin(fs.map((f) => `${pct(f.from)} to ${pct(f.to)}`))}.` });
    }
  }
  return out;
}
function words(n) { return ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][n] || String(n); }
function dedupe(list) { const seen = new Set(); return list.filter((f) => { const k = f.kind + f.key; if (seen.has(k)) return false; seen.add(k); return true; }); }

// ---------------- helpers ----------------
function linkSym(s) { return s === "ETH" ? "WETH" : s; }
function posKey(p) { return `${p.chainId}:${p.protocol}:${p.marketId || p.venue}`; }
function label(p) { return p.collateral.length === 1 && p.debt.length === 1 ? `the ${venueShort(p)} ${p.collateral[0].symbol} → ${p.debt[0].symbol} loan` : `the ${venueShort(p)} position`; }
function shortName(p) { return venueShort(p).split(" · ")[0]; }
// "Morpho" when it's the only Morpho loan, "Morpho cbBTC → USDC" when another loan shares the venue.
function loanName(p) { const v = shortName(p); const dup = pos.positions.some((x) => x !== p && shortName(x) === v); return dup && p.pair ? `${v} ${p.pair.coll.symbol} → ${p.pair.debt.symbol}` : v; }
function cacheKey(ws) { return `${args.chain || "all"}|${[...ws].map((w) => w.toLowerCase()).sort().join(",")}`; }
function loadCache(ws) { const p = cachePath(); if (!p) return null; try { const c = JSON.parse(readFileSync(p, "utf8")); if (c.key !== cacheKey(ws) || Date.now() - new Date(c.at).getTime() > CACHE_MS) return null; return c; } catch { return null; } }
function saveCache(ws, rs) { const p = cachePath(); if (!p) return; try { writeFileSync(p, JSON.stringify({ key: cacheKey(ws), at: new Date().toISOString(), runs: rs.map(({ prev, ...r }) => r) })); } catch {} }
function offerShort(v, p) {
  const label = typeof v === "string" ? v : v?.venue || "";
  if (p?.protocol === "morpho-blue" && /^Morpho/.test(label)) { const h = label.match(/ · ([0-9a-f]{6})$/); return h ? `another Morpho market (${h[1]})` : "another Morpho market"; }
  return venueName(typeof v === "string" ? v : v, p?.market?.offers);
}
function venueShort(p) { if (p.protocol === "morpho-blue") return "Morpho"; if (p.protocol === "compound-v3") return "Compound"; if (p.protocol === "fluid") return "Fluid"; return p.venue.replace(" v3", "").replace(" · Main", ""); }
function strip(p) { const { market, supplied, ...rest } = p; return { ...rest, mine: p.mine ? { venue: p.mine.venue, apr: p.mine.apr, maxLtv: p.mine.maxLtv, recLtv: p.mine.recLtv, liquidityUsd: p.mine.liquidityUsd, stability: p.mine.stability } : null, best: p.best ? { venue: p.best.venue, apr: p.best.apr, maxLtv: p.best.maxLtv, liquidityUsd: p.best.liquidityUsd } : null }; }
function when(iso) { if (!iso) return "last time"; const d = new Date(iso), now = new Date(); const days = (now - d) / 86400000; if (days < 1 && now.getDate() === d.getDate()) return "earlier today"; if (days < 2 && now.getDate() - d.getDate() === 1) return "yesterday"; if (days < 7) return d.toLocaleDateString("en-US", { weekday: "long" }); return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); }
function chainName(id) { return { 1: "Ethereum", 8453: "Base", 42161: "Arbitrum" }[id] || `chain ${id}`; }
function short(a) { return a.slice(0, 6) + "…" + a.slice(-4); }
function pct(x) { return `${Number(x).toFixed(2)}%`; }
function fmtHf(h) { return h == null ? "n/a" : h > 99 ? ">99" : h.toFixed(2); }
function amt(x) { if (x == null) return "?"; if (x >= 1000) return x.toLocaleString("en-US", { maximumFractionDigits: 0 }); if (x >= 1) return x.toLocaleString("en-US", { maximumFractionDigits: 2 }); return x.toLocaleString("en-US", { maximumFractionDigits: 4 }); }
function usdShort(x) { if (x == null) return "?"; if (x >= 1e9) return `$${(x / 1e9).toFixed(1)}B`; if (x >= 1e6) return `$${(x / 1e6).toFixed(1)}M`; if (x >= 1e3) return `$${(x / 1e3).toFixed(0)}K`; return `$${x.toFixed(0)}`; }
function cap(t) { return t.charAt(0).toUpperCase() + t.slice(1); }
function listJoin(a) { return a.length <= 1 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]; }
function usd(x) { if (x == null) return "?"; return "$" + Number(x).toLocaleString("en-US", { maximumFractionDigits: x >= 100 ? 0 : 2 }); }
function parseArgs(a) { const o = {}; for (let i = 0; i < a.length; i++) { const k = a[i]; if (k.startsWith("--")) { const key = k.slice(2); const v = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : true; o[key] = v; } } return o; }
