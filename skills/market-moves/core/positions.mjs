#!/usr/bin/env node
// Loanscape positions fetch: every open borrow position for a wallet across Aave v3 (Main, Prime), Spark, Morpho Blue and Compound v3.
// Node 18+, no dependencies, public RPCs + Morpho's public API. No keys.
//
//   node positions.mjs --wallet <0xaddress | name.eth> [--chain ethereum|base|arbitrum|all] [--json]
//
// Output is one normalised shape per position (see normalise() below) so every card upstream reads the same fields.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeRpc, postJson } from "./lib/rpc.mjs";
import { encode, words, asUint, asAddress, encAddress } from "./lib/abi.mjs";
import { namehash } from "./lib/keccak.mjs";
import { fluid } from "./lib/fluid.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(HERE, "venues.json"), "utf8"));
const SECONDS_PER_YEAR = 31536000;
const CHAIN_ARG = { ethereum: [1], mainnet: [1], eth: [1], base: [8453], arbitrum: [42161], arb: [42161], all: [1, 8453, 42161] };

const args = parseArgs(process.argv.slice(2));
if (!args.wallet) { console.error("usage: node positions.mjs --wallet <0xaddress | name.eth> [--chain ethereum|base|arbitrum|all] [--json]"); process.exit(2); }
const chains = CHAIN_ARG[String(args.chain || "all").toLowerCase()];
if (!chains) { console.error(`unknown chain "${args.chain}"`); process.exit(2); }

const { address, resolvedFrom } = await resolveWallet(args.wallet);
const positions = []; const errors = []; const attempted = [];
await Promise.all([
  ...V.aaveLike.filter((v) => chains.includes(v.chainId)).map((v) => guard(v.venue, v.protocol, v.chainId, () => aaveLike(v, address))),
  ...V.comets.filter((v) => chains.includes(v.chainId)).map((v) => guard(v.venue, "compound-v3", v.chainId, () => comet(v, address))),
  ...chains.filter((c) => V.morpho.chains.includes(c)).map((c) => guard("Morpho Blue", "morpho-blue", c, () => morpho(c, address))),
  ...chains.filter((c) => V.fluid.chains.includes(c)).map((c) => guard("Fluid", "fluid", c, () => fluid(V.fluid, c, address, { normalise }))),
]);
// Every read is counted, so a caller can tell "checked and quiet" from "partly checked" from "couldn't check at all".
async function guard(venue, protocol, chainId, fn) { attempted.push({ venue, protocol, chainId }); try { const r = await fn(); if (r) positions.push(...r); } catch (e) { errors.push({ venue, protocol, chainId, error: String(e.message || e) }); } }
const status = !errors.length ? "ok" : errors.length >= attempted.length ? "failed" : "partial";

positions.sort((a, b) => (a.healthFactor ?? 1e9) - (b.healthFactor ?? 1e9));
const out = { wallet: address, resolvedFrom, chains, fetchedAt: new Date().toISOString(), status, attempted: attempted.length, positions, errors, coverage: coverageLine(chains) };
if (args.json) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
printText(out);

// ---------------- venues ----------------

async function aaveLike(v, user) {
  const rpc = makeRpc(v.chainId);
  const acct = words(await rpc.call(v.pool, encode("getUserAccountData(address)", [user])));
  if (acct.length < 6) throw new Error(`no Aave-style pool at ${v.pool}`);
  const debtBase = asUint(acct[1]);
  if (debtBase === 0n) return [];
  const collateralBase = asUint(acct[0]), ltBps = Number(asUint(acct[3])), hf = Number(asUint(acct[5])) / 1e18;
  const reserves = decodeAddressArray(await rpc.call(v.pool, encode("getReservesList()")));
  const rd = (await rpc.calls(reserves.map((r) => [v.pool, encode("getReserveData(address)", [r])]))).map(words);
  // ReserveData words: 0 configuration bitmap (bits 0-15 LTV, 16-31 liquidation threshold, both in bps), 4 variable borrow rate (ray), 7 reserve id, 8 aToken, 10 variable debt token
  const aTokens = rd.map((w) => asAddress(w[8])), debtTokens = rd.map((w) => asAddress(w[10])), rates = rd.map((w) => Number(asUint(w[4])) / 1e27);
  const ids = rd.map((w) => Number(asUint(w[7]))), ltOf = rd.map((w) => Number((asUint(w[0]) >> 16n) & 0xffffn) / 10000), ltvOf = rd.map((w) => Number(asUint(w[0]) & 0xffffn) / 10000);
  const bals = await rpc.calls([...aTokens, ...debtTokens].map((t) => [t, encode("balanceOf(address)", [user])]));
  const n = reserves.length;
  const held = [];
  for (let i = 0; i < n; i++) { const a = asUint(words(bals[i])[0]), d = asUint(words(bals[n + i])[0]); if (a > 0n || d > 0n) held.push({ i, a, d }); }
  const [providerW, cfgW, emodeW] = await rpc.calls([[v.pool, encode("ADDRESSES_PROVIDER()")], [v.pool, encode("getUserConfiguration(address)", [user])], [v.pool, encode("getUserEMode(address)", [user])]]);
  const provider = asAddress(words(providerW)[0]);
  const userCfg = asUint(words(cfgW)[0]); // bit 2*id = borrowing, bit 2*id+1 = used as collateral
  const emode = Number(asUint(words(emodeW)[0]));
  const oracle = asAddress(words(await rpc.call(provider, encode("getPriceOracle()")))[0]);
  const meta = await rpc.calls(held.flatMap(({ i }) => [[reserves[i], encode("symbol()")], [reserves[i], encode("decimals()")], [oracle, encode("getAssetPrice(address)", [reserves[i]])]]));
  let emodeLabel = null;
  if (emode) { try { emodeLabel = decodeString(await rpc.call(v.pool, encode("getEModeCategoryLabel(uint8)", [emode]))) || null; } catch { emodeLabel = null; } }
  const collateral = [], supplied = [], debt = [];
  held.forEach(({ i, a, d }, k) => {
    const symbol = decodeString(meta[3 * k]) || short(reserves[i]); const decimals = Number(asUint(words(meta[3 * k + 1])[0])); const price = Number(asUint(words(meta[3 * k + 2])[0])) / 1e8;
    const enabled = ((userCfg >> BigInt(2 * ids[i] + 1)) & 1n) === 1n;
    if (a > 0n) { const row = { symbol, address: reserves[i], amount: Number(a) / 10 ** decimals, priceUsd: price, usd: (Number(a) / 10 ** decimals) * price, liquidationThreshold: emode ? ltBps / 10000 : ltOf[i], maxLtv: ltvOf[i] }; (enabled ? collateral : supplied).push(row); }
    if (d > 0n) debt.push({ symbol, address: reserves[i], amount: Number(d) / 10 ** decimals, priceUsd: price, usd: (Number(d) / 10 ** decimals) * price, apr: rates[i] * 100 });
  });
  const keep = (x) => x.usd >= 1;
  // collateralUsd is the pool's own figure (enabled collateral only) so LTV and health match what Aave shows; `supplied` holds deposits not backing the loan.
  return [normalise({ venue: v.venue, protocol: v.protocol, chainId: v.chainId, kind: "pooled", collateral: collateral.filter(keep), supplied: supplied.filter(keep), debt: debt.filter(keep), collateralUsd: Number(collateralBase) / 1e8, debtUsd: Number(debtBase) / 1e8, liquidationThreshold: ltBps / 10000, healthFactor: hf, emode: emode ? { id: emode, label: emodeLabel } : null, url: v.url })];
}

async function comet(v, user) {
  const rpc = makeRpc(v.chainId);
  const bw = words(await rpc.call(v.comet, encode("borrowBalanceOf(address)", [user])));
  if (bw.length < 1) throw new Error(`no comet at ${v.comet}`);
  const borrow = asUint(bw[0]);
  if (borrow === 0n) return [];
  const [baseW, baseFeedW, nW, utilW] = await rpc.calls([[v.comet, encode("baseToken()")], [v.comet, encode("baseTokenPriceFeed()")], [v.comet, encode("numAssets()")], [v.comet, encode("getUtilization()")]]);
  const base = asAddress(words(baseW)[0]), baseFeed = asAddress(words(baseFeedW)[0]), n = Number(asUint(words(nW)[0])), util = asUint(words(utilW)[0]);
  const [rateW, basePxW, baseSymW, baseDecW] = await rpc.calls([[v.comet, encode("getBorrowRate(uint256)", [util])], [v.comet, encode("getPrice(address)", [baseFeed])], [base, encode("symbol()")], [base, encode("decimals()")]]);
  const apr = (Number(asUint(words(rateW)[0])) / 1e18) * SECONDS_PER_YEAR * 100;
  const basePx = Number(asUint(words(basePxW)[0])) / 1e8, baseSym = decodeString(baseSymW) || "base", baseDec = Number(asUint(words(baseDecW)[0]));
  const infos = (await rpc.calls(Array.from({ length: n }, (_, i) => [v.comet, encode("getAssetInfo(uint8)", [i])]))).map(words);
  const assets = infos.map((w) => ({ asset: asAddress(w[1]), feed: asAddress(w[2]), scale: asUint(w[3]), liqCF: Number(asUint(w[5])) / 1e18 }));
  const colls = (await rpc.calls(assets.map((a) => [v.comet, encode("userCollateral(address,address)", [user, a.asset])]))).map((w) => asUint(words(w)[0]));
  const heldIdx = colls.map((c, i) => (c > 0n ? i : -1)).filter((i) => i >= 0);
  const meta = await rpc.calls(heldIdx.flatMap((i) => [[assets[i].asset, encode("symbol()")], [v.comet, encode("getPrice(address)", [assets[i].feed])]]));
  const collateral = []; let liqCap = 0;
  heldIdx.forEach((i, k) => { const symbol = decodeString(meta[2 * k]) || short(assets[i].asset); const price = Number(asUint(words(meta[2 * k + 1])[0])) / 1e8; const amount = Number(colls[i]) / Number(assets[i].scale); const usd = amount * price; liqCap += usd * assets[i].liqCF; collateral.push({ symbol, address: assets[i].asset, amount, priceUsd: price, usd, liquidationThreshold: assets[i].liqCF }); });
  const debtAmt = Number(borrow) / 10 ** baseDec, debtUsd = debtAmt * basePx;
  const collateralUsd = collateral.reduce((s, c) => s + c.usd, 0);
  return [normalise({ venue: v.venue, protocol: "compound-v3", chainId: v.chainId, kind: "pooled", collateral, debt: [{ symbol: baseSym, address: base, amount: debtAmt, priceUsd: basePx, usd: debtUsd, apr }], collateralUsd, debtUsd, liquidationThreshold: collateralUsd ? liqCap / collateralUsd : null, healthFactor: debtUsd ? liqCap / debtUsd : null, url: v.url })];
}

async function morpho(chainId, user) {
  const q = `{ userByAddress(address:"${user}", chainId:${chainId}) { marketPositions { healthFactor priceVariationToLiquidationPrice market { marketId lltv loanAsset { symbol address decimals } collateralAsset { symbol address decimals } state { borrowApy } } state { collateral collateralUsd borrowAssets borrowAssetsUsd } } } }`;
  const j = await postJson(V.morpho.api, { query: q }, 20000);
  if (j.errors && !j.data?.userByAddress) { if (/not found/i.test(JSON.stringify(j.errors))) return []; throw new Error(j.errors.map((e) => e.message).join("; ")); }
  const mps = j.data?.userByAddress?.marketPositions || [];
  return mps.filter((p) => Number(p.state?.borrowAssets || 0) > 0).map((p) => {
    const m = p.market, la = m.loanAsset, ca = m.collateralAsset || {};
    const collAmt = Number(p.state.collateral) / 10 ** (ca.decimals ?? 18), collUsd = Number(p.state.collateralUsd ?? 0);
    const debtAmt = Number(p.state.borrowAssets) / 10 ** la.decimals, debtUsd = Number(p.state.borrowAssetsUsd ?? 0);
    const lltv = Number(m.lltv) / 1e18;
    return normalise({ venue: `Morpho Blue · ${ca.symbol || "?"} / ${la.symbol} · ${(lltv * 100).toFixed(1)}% LLTV`, protocol: "morpho-blue", chainId, kind: "isolated", marketId: m.marketId,
      collateral: ca.symbol ? [{ symbol: ca.symbol, address: ca.address, amount: collAmt, priceUsd: collAmt ? collUsd / collAmt : null, usd: collUsd }] : [],
      debt: [{ symbol: la.symbol, address: la.address, amount: debtAmt, priceUsd: debtAmt ? debtUsd / debtAmt : null, usd: debtUsd, apr: Number(m.state?.borrowApy ?? 0) * 100 }],
      collateralUsd: collUsd, debtUsd, liquidationThreshold: lltv, healthFactor: p.healthFactor ?? null, url: `${V.morpho.appUrl}/${chainName(chainId).toLowerCase()}/market/${m.marketId}` });
  });
}

// ---------------- shape ----------------

function normalise(p) {
  const ltv = p.collateralUsd && p.debtUsd != null ? p.debtUsd / p.collateralUsd : null;
  const liquidationPrice = liquidationPriceFor(p);
  const priced = p.debt.filter((d) => d.usd != null && d.apr != null);
  const borrowApr = priced.length ? priced.reduce((s, d) => s + d.apr * d.usd, 0) / priced.reduce((s, d) => s + d.usd, 0) : (p.debt[0]?.apr ?? null);
  return { ...p, ltv, borrowApr, liquidationPrice };
}

// Price of the largest collateral asset at which the position reaches liquidation, holding every other price where it is today.
// Liquidation when Σ collateral_j × LT_j == debt. Solve for the dominant asset's price; LT_j falls back to the position-level threshold.
function liquidationPriceFor(p) {
  const colls = p.collateral.filter((c) => c.usd != null && c.amount > 0 && c.priceUsd);
  if (!colls.length || p.debtUsd == null || !p.debtUsd) return null;
  const lt = (c) => c.liquidationThreshold ?? p.liquidationThreshold;
  if (colls.some((c) => !lt(c))) return null;
  const main = colls.reduce((a, b) => (b.usd > a.usd ? b : a));
  const isStable = (x) => x.priceUsd != null && Math.abs(x.priceUsd - 1) < 0.05;
  const volatileDebts = p.debt.filter((d) => d.usd != null && !isStable(d));
  if (isStable(main) && colls.every(isStable) && volatileDebts.length === 1 && p.debt.filter((d) => d.usd != null).length === 1 && volatileDebts[0].amount > 0) {
    // stable collateral, one volatile debt: liquidation comes from the debt asset rising, not the collateral falling
    const d = volatileDebts[0]; const cover = colls.reduce((s, c) => s + c.usd * lt(c), 0); const price = cover / d.amount;
    return { symbol: d.symbol, direction: "up", price, currentPrice: d.priceUsd, dropPct: null, risePct: (price / d.priceUsd - 1) * 100, note: "collateral is stable; liquidation if the borrowed asset rises to this price" };
  }
  const others = colls.filter((c) => c !== main).reduce((s, c) => s + c.usd * lt(c), 0);
  const debtInSameAsset = p.debt.some((d) => d.symbol === main.symbol);
  if (debtInSameAsset && p.debt.length === 1 && p.collateral.length === 1) return null; // ETH against ETH: price cancels
  const price = (p.debtUsd - others) / (main.amount * lt(main));
  if (!(price > 0)) return { symbol: main.symbol, direction: "down", price: null, currentPrice: main.priceUsd, dropPct: null, note: `no ${main.symbol} price triggers liquidation: the other collateral alone covers the debt at today's prices` };
  const notes = [];
  if (colls.length > 1 || p.collateral.length > 1) notes.push("assumes other collateral prices hold");
  const nonStableDebt = p.debt.filter((d) => d.priceUsd != null && Math.abs(d.priceUsd - 1) >= 0.05).map((d) => d.symbol);
  if (nonStableDebt.length) notes.push(`assumes ${[...new Set(nonStableDebt)].join(", ")} price holds`);
  return { symbol: main.symbol, direction: "down", price, currentPrice: main.priceUsd, dropPct: (1 - price / main.priceUsd) * 100, note: notes.length ? notes.join("; ") : null };
}

// ---------------- output ----------------

function printText(o) {
  const src = o.resolvedFrom ? `${o.resolvedFrom} → ${o.wallet}` : o.wallet;
  if (o.status === "failed") { console.log(`Could not check ${src}: every venue read failed.`); printErrors(o.errors); return; }
  if (!o.positions.length) { console.log(`No open borrow positions for ${src} on ${o.chains.map(chainName).join(", ")}${o.status === "partial" ? " in the venues that answered" : ""}.`); printErrors(o.errors); if (o.status === "ok") console.log(o.coverage); return; }
  console.log(`${o.positions.length} open borrow position${o.positions.length === 1 ? "" : "s"} for ${src} · ${o.fetchedAt}`);
  o.positions.forEach((p, i) => {
    const coll = p.collateral.map((c) => `${amt(c.amount)} ${c.symbol}`).join(" + ") || "no collateral";
    const debt = p.debt.map((d) => `${amt(d.amount)} ${d.symbol}`).join(" + ");
    const L = p.liquidationPrice;
    const lp = L?.price && L.direction === "up" ? `liquidates if ${L.symbol} rises to ${usd(L.price)} (+${L.risePct.toFixed(0)}%)`
      : L?.price ? `liquidates at ${usd(L.price)} ${L.symbol}${L.dropPct != null ? ` (−${L.dropPct.toFixed(0)}%)` : ""}`
      : p.healthFactor != null ? `health ${p.healthFactor.toFixed(2)}${L?.note ? ` · ${L.note}` : ""}` : "";
    const chain = o.chains.length > 1 ? ` [${chainName(p.chainId)}]` : "";
    console.log(`${i + 1}  ${p.venue}${chain}   ${coll} → ${debt}   LTV ${p.ltv != null ? (p.ltv * 100).toFixed(0) + "%" : "n/a"}   ${lp}   ${p.borrowApr != null ? p.borrowApr.toFixed(2) + "%" : ""}${p.emode ? `   e-mode: ${p.emode.label || p.emode.id}` : ""}${p.note ? `   (${p.note})` : ""}`);
    if (p.supplied?.length) console.log(`   also supplied, not backing the loan: ${p.supplied.map((c) => `${amt(c.amount)} ${c.symbol}`).join(", ")}`);
  });
  const totalDebt = o.positions.reduce((s, p) => s + (p.debtUsd || 0), 0), totalColl = o.positions.reduce((s, p) => s + (p.collateralUsd || 0), 0);
  console.log(`total: ${usd(totalDebt)} borrowed against ${usd(totalColl)}`);
  printErrors(o.errors); if (o.status === "ok") console.log(o.coverage);
}
function printErrors(errs) { for (const e of errs) console.log(`could not read ${e.venue} on ${chainName(e.chainId)}: ${e.error}`); }
function coverageLine(chains) {
  const fams = ["Aave v3", "Spark", "Morpho Blue", "Compound v3", "Fluid"];
  return `read ${fams.join(", ")} on ${chains.map(chainName).join(", ")}`;
}

// ---------------- helpers ----------------

async function resolveWallet(w) {
  if (/^0x[0-9a-fA-F]{40}$/.test(w)) return { address: w.toLowerCase(), resolvedFrom: null };
  if (!/\./.test(w)) throw new Error(`"${w}" is not an address or an ENS name`);
  const rpc = makeRpc(1); const node = namehash(w).slice(2);
  const resolver = asAddress(words(await rpc.call(V.ens.registry, "0x0178b8bf" + node))[0]);
  if (/^0x0{40}$/.test(resolver)) throw new Error(`ENS name ${w} has no resolver`);
  const addr = asAddress(words(await rpc.call(resolver, "0x3b3b57de" + node))[0]);
  if (/^0x0{40}$/.test(addr)) throw new Error(`ENS name ${w} does not resolve to an address`);
  return { address: addr, resolvedFrom: w };
}
function decodeAddressArray(hex) { const w = words(hex); const len = Number(asUint(w[1])); return w.slice(2, 2 + len).map(asAddress); }
function decodeString(hex) { const w = words(hex); if (w.length < 3) { const raw = Buffer.from(w[0] || "", "hex").toString().replace(/\0/g, ""); return raw || null; } const len = Number(asUint(w[1])); return Buffer.from(w.slice(2).join(""), "hex").subarray(0, len).toString(); }
function chainName(id) { return V.chains[String(id)] || `chain ${id}`; }
function short(a) { return a.slice(0, 6) + "…" + a.slice(-4); }
function amt(x) { if (x == null) return "?"; if (x >= 1000) return x.toLocaleString("en-US", { maximumFractionDigits: 0 }); if (x >= 1) return x.toLocaleString("en-US", { maximumFractionDigits: 2 }); return x.toLocaleString("en-US", { maximumFractionDigits: 4 }); }
function usd(x) { if (x == null) return "?"; return "$" + x.toLocaleString("en-US", { maximumFractionDigits: x >= 100 ? 0 : 2 }); }
function parseArgs(a) { const o = {}; for (let i = 0; i < a.length; i++) { const k = a[i]; if (k.startsWith("--")) { const key = k.slice(2); const v = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : true; o[key] = v; } } return o; }
