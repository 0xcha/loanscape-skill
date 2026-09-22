#!/usr/bin/env node
// The manager brief: positions, ranked by urgency, with one money line and what changed since last time.
// Prints the finished text; the skill passes it through. --json for the structured form.
//
//   node brief.mjs [--wallet <0x | name.eth>] [--chain ethereum|base|arbitrum|all] [--json] [--no-save] [--ladder <position#> [--shock <pct>]]
//   --move <position#> prints the five moves in order of cost (do nothing, add collateral, repay some, refinance, close) with the numbers for each.
//   With no --wallet, every remembered wallet is read into one brief. --json, --ladder and --move never write memory.
//
// Memory: $LOANSCAPE_HOME/memory.json (default ~/.loanscape). Holds the remembered wallet(s) and the last snapshot per wallet,
// which is what makes the second run better than the first. Nothing leaves the machine except the RPC and API reads.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fetchOffers, deepLink } from "./lib/offers.mjs";
import { trustedHistory } from "./lib/rules.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.LOANSCAPE_HOME || join(homedir(), ".loanscape");
const MEM = join(HOME, "memory.json");
const T = { urgentDropPct: 15, urgentHealth: 1.15, urgentRateStepBps: 100, refiMinBps: 20, refiMinUsdPerYear: 100, risingDays: 3, diffPricePct: 2, diffHeadroomPts: 2, diffRateBps: 10, diffDebtPct: 1, idleMinUsd: 50, moveTargetPct: 30 };

const args = parseArgs(process.argv.slice(2));
const mem = loadMem();
// One wallet when given; otherwise every remembered wallet, one brief.
const walletArgs = args.wallet ? [args.wallet] : Object.keys(mem.wallets).length ? Object.keys(mem.wallets).sort((a, b) => (a === mem.defaultWallet ? -1 : b === mem.defaultWallet ? 1 : 0)) : [];
if (!walletArgs.length) { console.log(args.json ? JSON.stringify({ needWallet: true }) : "NEED_WALLET"); process.exit(0); }
if (args.ladder && !args.wallet && walletArgs.length > 1) walletArgs.splice(1); // a ladder is asked about one brief's numbering; use the default wallet

// 1. positions, per wallet, merged
const runs = [];
for (const w of walletArgs) {
  const raw = execFileSync(process.execPath, [join(HERE, "positions.mjs"), "--wallet", w, "--chain", args.chain || "all", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 24 });
  const r = JSON.parse(raw); r.prev = mem.wallets[r.wallet] || null; r.label = r.resolvedFrom || r.prev?.label || null;
  for (const p of r.positions) { p.walletKey = r.wallet; p.walletLabel = r.label || short(r.wallet); }
  runs.push(r);
}
const multi = runs.length > 1;
const pos = { wallet: runs[0].wallet, resolvedFrom: runs[0].label, fetchedAt: runs[0].fetchedAt, chains: runs[0].chains, coverage: runs[0].coverage, positions: runs.flatMap((r) => r.positions), errors: runs.flatMap((r) => r.errors.map((e) => ({ ...e, wallet: r.label || short(r.wallet) }))) };
const key = pos.wallet;
const prev = runs[0].prev;
const firstRun = runs.every((r) => !r.prev);
const prevFor = (p) => runs.find((r) => r.wallet === p.walletKey)?.prev;

// 2. market context: the position's dominant pair (largest collateral × largest debt); partial when the position holds more than that pair
for (const p of pos.positions) {
  p.key = posKey(p);
  const c = p.collateral.filter((x) => x.address && x.usd != null).sort((a, b) => b.usd - a.usd)[0], d = p.debt.filter((x) => x.address && x.usd != null).sort((a, b) => b.usd - a.usd)[0];
  if (!c || !d) continue;
  p.pair = { coll: c, debt: d, partial: p.collateral.length > 1 || p.debt.length > 1 };
  try {
    const m = await fetchOffers(p.chainId, c.address, d.address);
    m.offers = m.offers.map((o) => ({ ...o, ...trustedHistory(o) })); p.market = m; p.mine = matchOwnOffer(p, m.offers);
    p.best = bestAlternative(p, m.offers);
  } catch (e) { p.marketError = String(e.message || e); }
}

// 3. findings
const findings = [];
for (const p of pos.positions) {
  const name = label(p);
  const L = p.liquidationPrice;
  const dist = L?.direction === "up" ? L.risePct : L?.dropPct;
  if ((dist != null && dist <= T.urgentDropPct) || (p.healthFactor != null && p.healthFactor < T.urgentHealth)) {
    const txt = L?.direction === "up" && dist != null ? `${name} liquidates if ${L.symbol} rises ${dist.toFixed(0)}%, to ${usd(L.price)}.`
      : dist != null ? `${name} liquidates if ${L.symbol} drops ${dist.toFixed(0)}%, to ${usd(L.price)}.` : `${name} is close to liquidation.`;
    findings.push({ tier: "urgent", kind: "liq", key: p.key, text: `${txt} Health ${fmtHf(p.healthFactor)}.` });
  }
  const before = prevFor(p)?.snapshot?.[p.key];
  if (before && p.borrowApr != null && before.apr != null && Math.abs(p.borrowApr - before.apr) * 100 >= T.urgentRateStepBps) {
    findings.push({ tier: "urgent", kind: "step", key: p.key, text: `${name} rate stepped from ${pct(before.apr)} to ${pct(p.borrowApr)} since ${when(prevFor(p).lastRun)}.` });
  }
  if (p.best) {
    const partUsd = p.pair.partial ? p.pair.debt.usd : p.debtUsd;
    const curApr = p.pair.partial ? (p.pair.debt.apr ?? p.borrowApr) : p.borrowApr;
    const spreadBps = (curApr - p.best.apr) * 100, perYear = (spreadBps / 10000) * partUsd;
    const what = p.pair.partial ? `the ${p.pair.coll.symbol} → ${p.pair.debt.symbol} part of the ${venueShort(p)} position` : `the ${shortName(p)} loan`;
    const nowCost = (curApr / 100) * partUsd, newCost = (p.best.apr / 100) * partUsd;
    if (spreadBps >= T.refiMinBps || perYear >= T.refiMinUsdPerYear) findings.push({ tier: "worth", key: p.key, kind: "refi", bps: Math.round(spreadBps), perYear, venue: offerShort(p.best.venue), loan: p.pair.partial ? `${p.pair.coll.symbol} → ${p.pair.debt.symbol} part of the ${venueShort(p)}` : shortName(p), text: `${offerShort(p.best.venue)} would charge ${pct(p.best.apr)} on ${what}: about ${usd(newCost)} a year instead of ${usd(nowCost)}, ${Math.round(spreadBps)} bps less, with ${usdShort(p.best.liquidityUsd)} available there.`, link: deepLink(linkSym(p.pair.coll.symbol), linkSym(p.pair.debt.symbol), null) });
  }
  if (p.mine?.sparkline?.length >= T.risingDays + 1) {
    const s = p.mine.sparkline.slice(-(T.risingDays + 1)); const rising = s.every((v, i) => i === 0 || v > s[i - 1]);
    const what = p.pair?.partial ? `the ${p.pair.coll.symbol} → ${p.pair.debt.symbol} rate on ${venueShort(p)}` : `${name}'s rate`;
    if (rising) findings.push({ tier: "worth", key: p.key, kind: "trend", text: `${what} has risen ${T.risingDays} days running, ${pct(s[0])} to ${pct(s[s.length - 1])}.` });
  }
  if (firstRun && p.supplied?.length) {
    const idle = p.supplied.filter((c) => c.usd >= T.idleMinUsd).sort((a, b) => b.usd - a.usd);
    if (idle.length) findings.push({ tier: "worth", key: p.key, kind: "idle", text: `${idle.map((c) => `${amt(c.amount)} ${c.symbol}`).join(" and ")} on ${venueShort(p)} ${idle.length === 1 ? "isn't" : "aren't"} enabled as collateral, so ${idle.length === 1 ? "it adds" : "they add"} no headroom to the loan.` });
  }
  if (p.mine?.recLtv != null && p.ltv != null && p.ltv * 100 > p.mine.recLtv) {
    findings.push({ tier: "worth", key: p.key, kind: "ltv", text: `${name} sits at ${(p.ltv * 100).toFixed(0)}% LTV, above the ${p.mine.recLtv}% Loanscape treats as the working ceiling there.` });
  }
}
const urgent = findings.filter((f) => f.tier === "urgent");
const worth = dedupe(findings.filter((f) => f.tier === "worth")).slice(0, 2);

// 4. diff since last run, per wallet, merged
const diffs = runs.filter((r) => r.prev).map((r) => ({ r, d: computeDiff(r.prev, { positions: r.positions }) }));
const diff = diffs.length ? { lines: diffs.flatMap(({ r, d }) => d.lines.map((l) => (multi ? `${r.label || short(r.wallet)}: ${l}` : l))).slice(0, 3), all: diffs.flatMap(({ d }) => d.all) } : null;
if (diff) { const stepped = new Set(urgent.filter((u) => u.kind === "step").map((u) => u.key)); if (stepped.size) diff.lines = diff.lines.filter((l) => !/ rate .* → /.test(l)); }
const lastRunOf = () => { const ts = runs.map((r) => r.prev?.lastRun).filter(Boolean).sort(); return ts[0] || null; };

// 5. persist, per wallet
const snapshotOf = (r) => Object.fromEntries(r.positions.map((p) => [p.key, { venue: p.venue, chainId: p.chainId, debtUsd: p.debtUsd, collateralUsd: p.collateralUsd, ltv: p.ltv, dropPct: p.liquidationPrice?.direction === "up" ? (p.liquidationPrice.risePct ?? null) : (p.liquidationPrice?.dropPct ?? null), apr: p.borrowApr, collSymbol: p.collateral[0]?.symbol ?? null, collPrice: p.collateral[0]?.priceUsd ?? null, health: p.healthFactor }]));
if (!args["no-save"] && !args.json && !args.ladder && !args.move) {
  for (const r of runs) {
    const keys = [...urgent, ...worth].filter((f) => r.positions.some((p) => p.key === f.key)).map((f) => f.kind + ":" + f.key);
    mem.wallets[r.wallet] = { label: r.label, firstSeen: r.prev?.firstSeen || r.fetchedAt, lastRun: r.fetchedAt, snapshot: snapshotOf(r), findingKeys: keys, runs: (r.prev?.runs || 0) + 1 };
  }
  if (args.wallet) mem.defaultWallet = key; else if (!mem.defaultWallet) mem.defaultWallet = key;
  saveMem(mem);
}

// 6. output
const who = multi ? `${runs.length} wallets` : (pos.resolvedFrom || prev?.label || short(key));
if (args.ladder) { console.log(ladder(Number(args.ladder))); process.exit(0); }
if (args.move) { console.log(moveLadder(Number(args.move))); process.exit(0); }
const urgentAll = findings;
const out = { wallet: key, wallets: runs.map((r) => ({ wallet: r.wallet, label: r.label })), label: pos.resolvedFrom || prev?.label || null, firstRun, lastRun: lastRunOf(), fetchedAt: pos.fetchedAt, positions: pos.positions.map(strip), urgent, worth, diff, errors: pos.errors, coverage: pos.coverage, memoryPath: MEM, text: render() };
if (args.json) console.log(JSON.stringify(out, null, 2)); else console.log(out.text);

// ---------------- render ----------------
function render() {
  const L = [];
  const n = pos.positions.length;
  const prevKeys = new Set(runs.flatMap((r) => r.prev?.findingKeys || []));
  const isOld = (f) => prevKeys.has(f.kind + ":" + f.key);
  if (!n) {
    L.push(`No open borrow positions for ${who}.`);
    L.push(`I read Aave, Spark, Morpho, Compound and Fluid on ${listJoin(pos.chains.map(chainName))}. If you've got a loan elsewhere, tell me and I'll track it by hand.`);
    return L.join("\n");
  }
  const verdict = urgent.length ? (urgent.length === 1 ? "One needs attention." : `${urgent.length} need attention.`) : "Nothing urgent.";
  const oldWorth = worth.filter(isOld), newWorth = worth.filter((f) => !isOld(f));
  const still = oldWorth.map((f) => f.kind === "refi" ? `${f.venue} still ${f.bps} bps cheaper on the ${f.loan} loan, about ${usd(f.perYear)} a year.` : null).filter(Boolean);
  const across = multi ? ` across ${runs.length} wallets` : "";
  const newWallets = runs.filter((r) => !r.prev);
  const yearly = pos.positions.reduce((t, p) => t + (p.debtUsd && p.borrowApr != null ? (p.debtUsd * p.borrowApr) / 100 : 0), 0);
  const cost = yearly >= 1 ? `, about ${usd(yearly)} a year in interest` : "";
  if (firstRun) L.push(`Found ${n} position${n === 1 ? "" : "s"}${across}${cost}. ${verdict}`);
  else {
    const since = when(lastRunOf());
    const added = newWallets.length ? ` Added ${listJoin(newWallets.map((r) => r.label || short(r.wallet)))}.` : "";
    const head = (diff?.lines.length ? `Since ${since}: ${diff.lines.join(" ")}` : `Since ${since}: nothing moved much.`) + added;
    const tail = !urgent.length && !newWorth.length && !still.length ? "Nothing to do." : verdict;
    L.push([head, tail, ...still].join(" "));
  }
  pos.positions.forEach((p, i) => L.push(row(i + 1, p)));
  const detail = [];
  urgent.forEach((u) => detail.push(cap(u.text)));
  if (newWorth.length === 1) detail.push(`One thing worth knowing: ${newWorth[0].text}`);
  else newWorth.forEach((w) => detail.push(`Worth knowing: ${w.text}`));
  const refi = newWorth.find((w) => w.kind === "refi"); if (refi) detail.push(`Compare: ${refi.link}`);
  if (urgent.some((u) => u.kind === "liq")) detail.push("Want the numbers on adding collateral or paying some down?");
  if (detail.length) { L.push(""); L.push(...detail); }
  const errs = [...new Set(pos.errors.map((e) => `${e.venue} on ${chainName(e.chainId)}`))]; if (errs.length) L.push(`Could not read ${listJoin(errs)} this time.`);
  if (firstRun) { L.push(""); L.push(`Read Aave, Spark, Morpho, Compound and Fluid on ${listJoin(pos.chains.map(chainName))}. I'll remember this wallet.`); L.push(`Run /loanscape any morning and I'll tell you what changed.`); }
  return L.join("\n");
}
function row(i, p) {
  const side = (list, total) => list.length <= 1 ? list.map((c) => `${amt(c.amount)} ${c.symbol}`).join("") || "no collateral" : `${list.map((c) => c.symbol).join(" + ")} (${usd(total)})`;
  const coll = side(p.collateral, p.collateralUsd), debt = side(p.debt, p.debtUsd);
  const L = p.liquidationPrice;
  const risk = L?.price && L.direction === "up" ? `liquidates if ${L.symbol} rises to ${usd(L.price)} (+${L.risePct.toFixed(0)}%)`
    : L?.price ? `liquidates at ${usd(L.price)} ${L.symbol}${L.dropPct != null ? ` (−${L.dropPct.toFixed(0)}%)` : ""}`
    : p.healthFactor != null ? `health ${fmtHf(p.healthFactor)}` : p.note ? `(${p.note.replace(/, USD not computed$/, "")})` : "";
  const chain = pos.chains.length > 1 && p.chainId !== 1 ? ` (${chainName(p.chainId)})` : "";
  const wal = multi ? ` [${p.walletLabel}]` : "";
  const rate = p.borrowApr != null ? ` at ${pct(p.borrowApr)}` : "";
  const emode = p.emode ? " · e-mode" : "";
  return `${i}  ${venueShort(p)}${chain}${wal}   ${coll} → ${debt}${rate}   LTV ${p.ltv != null ? (p.ltv * 100).toFixed(0) + "%" : "n/a"}${emode}   ${risk}`;
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
    const left = distNow != null ? (distNow - shock * 100) : null;
    out.push(r.health < 1.01 && r.health >= 1 ? `${sym} ${up ? "+" : "−"}${(shock * 100).toFixed(0)}% puts ${label(p)} on the liquidation line, health ${fmtHf(r.health)}.`
      : r.health < 1 ? `${sym} ${up ? "+" : "−"}${(shock * 100).toFixed(0)}% liquidates ${label(p)}${distNow != null ? `; liquidation comes at ${up ? "+" : "−"}${distNow.toFixed(0)}%` : ""}.`
      : `${sym} ${up ? "+" : "−"}${(shock * 100).toFixed(0)}% leaves ${label(p)} open at LTV ${(r.ltv * 100).toFixed(0)}%, health ${fmtHf(r.health)}${left != null ? `, ${left.toFixed(0)}% ${up ? "further rise" : "further drop"} from liquidation` : ""}.`);
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
  const out = [`Should you move ${label(p)}? The moves, cheapest first.`];
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
  if (p.best) {
    const partUsd = p.pair?.partial ? p.pair.debt.usd : p.debtUsd; const curApr = p.pair?.partial ? (p.pair.debt.apr ?? p.borrowApr) : p.borrowApr;
    const nowCost = (curApr / 100) * partUsd, newCost = (p.best.apr / 100) * partUsd, bps = Math.round((curApr - p.best.apr) * 100);
    const sharePct = p.best.liquidityUsd ? (partUsd / p.best.liquidityUsd) * 100 : null;
    const share = sharePct != null ? ` (your loan is ${sharePct.toFixed(1)}% of it${sharePct >= 10 ? ", enough to move the rate you came for" : ""})` : "";
    const fit = p.best.maxLtv != null && p.ltv != null ? `, max LTV ${p.best.maxLtv}% against your ${(p.ltv * 100).toFixed(0)}%` : "";
    const what = p.pair?.partial ? `the ${p.pair.coll.symbol} → ${p.pair.debt.symbol} part` : "it";
    out.push(`4  Refinance: ${offerShort(p.best.venue)} at ${pct(p.best.apr)} would make ${what} ${usd(newCost)} a year instead of ${usd(nowCost)}, ${bps} bps less; ${usdShort(p.best.liquidityUsd)} available there${share}${fit}. Repay here, reborrow there, two or three transactions with gas on each.`);
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
function bestAlternative(p, offers) {
  const need = p.pair?.partial ? p.pair.debt.usd : p.debtUsd;
  const c = offers.filter((o) => o.apr != null && o !== p.mine && (o.liquidityUsd ?? 0) >= need && (o.maxLtv == null || p.ltv == null || o.maxLtv >= p.ltv * 100)).sort((a, b) => a.apr - b.apr);
  const cur = p.pair?.partial ? (p.pair.debt.apr ?? p.borrowApr) : (p.mine?.apr ?? p.borrowApr);
  return c.length && c[0].apr < cur ? c[0] : null;
}
function computeDiff(prev, pos) {
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
  for (const k of Object.keys(before)) if (!seen.has(k)) lines.push(`Closed: ${before[k].venue}.`);
  const uniq = [...new Set(lines)];
  return { lines: uniq.slice(0, 3), all: uniq };
}
function dedupe(list) { const seen = new Set(); return list.filter((f) => { const k = f.kind + f.key; if (seen.has(k)) return false; seen.add(k); return true; }); }

// ---------------- helpers ----------------
function linkSym(s) { return s === "ETH" ? "WETH" : s; }
function posKey(p) { return `${p.chainId}:${p.protocol}:${p.marketId || p.venue}`; }
function label(p) { return p.collateral.length === 1 && p.debt.length === 1 ? `the ${venueShort(p)} ${p.collateral[0].symbol} → ${p.debt[0].symbol} loan` : `the ${venueShort(p)} position`; }
function shortName(p) { return venueShort(p).split(" · ")[0]; }
function offerShort(v) { return String(v).replace(" v3", "").replace(" · Main", "").replace(" Instance", "").replace(" comet", "").replace(" vault", ""); }
function venueShort(p) { if (p.protocol === "morpho-blue") return "Morpho"; if (p.protocol === "compound-v3") return "Compound"; if (p.protocol === "fluid") return "Fluid"; return p.venue.replace(" v3", "").replace(" · Main", ""); }
function strip(p) { const { market, supplied, ...rest } = p; return { ...rest, mine: p.mine ? { venue: p.mine.venue, apr: p.mine.apr, maxLtv: p.mine.maxLtv, recLtv: p.mine.recLtv, liquidityUsd: p.mine.liquidityUsd, stability: p.mine.stability } : null, best: p.best ? { venue: p.best.venue, apr: p.best.apr, maxLtv: p.best.maxLtv, liquidityUsd: p.best.liquidityUsd } : null }; }
function loadMem() { try { return JSON.parse(readFileSync(MEM, "utf8")); } catch { return { version: 1, wallets: {}, defaultWallet: null }; } }
function saveMem(m) { if (!existsSync(HOME)) mkdirSync(HOME, { recursive: true }); writeFileSync(MEM, JSON.stringify(m, null, 2)); }
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
