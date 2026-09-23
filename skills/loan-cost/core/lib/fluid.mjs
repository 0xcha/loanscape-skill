// Fluid (Instadapp) vault positions. Positions are NFTs; the VaultResolver lists a user's NFT ids and decodes each one.
// Vault metadata (tokens, prices, liquidation threshold, borrow rate) comes from Fluid's public API, one fetch per chain.
// Type 1 vaults (one collateral token, one debt token) are priced fully. Smart-collateral / smart-debt vaults (types 2-4)
// hold DEX shares; those are reported with share amounts and no USD until the share pricing is verified.
import { makeRpc, postJson } from "./rpc.mjs";
import { encode, words, asUint, asAddress } from "./abi.mjs";
import { execFileSync } from "node:child_process";

const vaultCache = new Map();
async function vaultList(api, chainId) {
  if (vaultCache.has(chainId)) return vaultCache.get(chainId);
  const url = `${api}/v2/${chainId}/vaults`;
  let text;
  try { const r = await fetch(url, { headers: { "user-agent": "loanscape-skill/0.1" }, signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); text = await r.text(); }
  catch (e) { if (String(e.message).startsWith("HTTP")) throw e; text = execFileSync("curl", ["-sS", "--max-time", "20", url], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 26 }); }
  const list = JSON.parse(text); const byAddr = new Map(list.map((v) => [v.address.toLowerCase(), v]));
  vaultCache.set(chainId, byAddr); return byAddr;
}
const tok = (t) => (t && t.address && !/^0x0{40}$/.test(t.address) ? t : null);

export async function fluid(cfg, chainId, user, { normalise }) {
  const rpc = makeRpc(chainId);
  const idsHex = await rpc.call(cfg.resolver, encode("positionsNftIdOfUser(address)", [user]));
  const w = words(idsHex); if (w.length < 2) throw new Error(`no Fluid resolver at ${cfg.resolver}`);
  const ids = w.slice(2, 2 + Number(asUint(w[1]))).map((x) => asUint(x));
  if (!ids.length) return [];
  const raw = await rpc.calls(ids.map((id) => [cfg.resolver, encode("positionByNftId(uint256)", [id])]));
  const open = [];
  raw.forEach((hex, k) => { const p = words(hex); const isLiq = asUint(p[2]) === 1n, isSupply = asUint(p[3]) === 1n, supply = asUint(p[9]), borrow = asUint(p[10]); if (!isLiq && !isSupply && borrow > 0n) open.push({ id: ids[k], supply, borrow }); });
  if (!open.length) return [];
  const vaults = (await rpc.calls(open.map((o) => [cfg.resolver, encode("vaultByNftId(uint256)", [o.id])]))).map((h) => asAddress(words(h)[0]));
  const meta = await vaultList(cfg.api, chainId);
  return open.map((o, k) => {
    const v = meta.get(vaults[k]);
    const url = `${cfg.appUrl}/vaults/${chainId}/${v ? v.id : "?"}`;
    if (!v) return normalise({ venue: `Fluid · vault ${vaults[k].slice(0, 8)}`, protocol: "fluid", chainId, kind: "vault", nftId: o.id.toString(), collateral: [], debt: [], collateralUsd: null, debtUsd: null, liquidationThreshold: null, healthFactor: null, url, note: "vault not in Fluid's API; amounts unpriced" });
    const s0 = tok(v.supplyToken?.token0), s1 = tok(v.supplyToken?.token1), b0 = tok(v.borrowToken?.token0), b1 = tok(v.borrowToken?.token1);
    const lt = Number(v.liquidationThreshold) / 10000, apr = Number(v.borrowRate?.vault?.rate ?? v.borrowRate?.liquidity?.token0 ?? 0) / 100;
    const label = `Fluid · ${[s0, s1].filter(Boolean).map((t) => t.symbol).join("+")} / ${[b0, b1].filter(Boolean).map((t) => t.symbol).join("+")} vault ${v.id}`;
    // Vault types: 1 = token collateral, token debt · 2 = DEX-share collateral, token debt · 3 = token collateral, DEX-share debt · 4 = shares both sides.
    const t = String(v.type); const smartCol = t === "2" || t === "4", smartDebt = t === "3" || t === "4";
    const collateral = smartCol || !s0
      ? [{ symbol: `${[s0, s1].filter(Boolean).map((x) => x.symbol).join("+")} shares`, amount: Number(o.supply) / 1e18, priceUsd: null, usd: null, liquidationThreshold: lt }]
      : [{ symbol: s0.symbol, address: s0.address, amount: Number(o.supply) / 10 ** s0.decimals, priceUsd: Number(s0.price), usd: (Number(o.supply) / 10 ** s0.decimals) * Number(s0.price), liquidationThreshold: lt }];
    const debt = smartDebt || !b0
      ? [{ symbol: `${[b0, b1].filter(Boolean).map((x) => x.symbol).join("+")} shares`, amount: Number(o.borrow) / 1e18, priceUsd: null, usd: null, apr: null }]
      : [{ symbol: b0.symbol, address: b0.address, amount: Number(o.borrow) / 10 ** b0.decimals, priceUsd: Number(b0.price), usd: (Number(o.borrow) / 10 ** b0.decimals) * Number(b0.price), apr }];
    const collateralUsd = collateral[0].usd, debtUsd = debt[0].usd;
    const note = smartCol && smartDebt ? "smart collateral and debt vault; both sides are DEX shares, USD not computed" : smartCol ? "smart collateral vault; collateral is DEX shares, USD not computed" : smartDebt ? "smart debt vault; debt is DEX shares, USD not computed" : null;
    return normalise({ venue: label, protocol: "fluid", chainId, kind: "vault", nftId: o.id.toString(), vaultId: String(v.id), vaultAddress: vaults[k], collateral, debt, collateralUsd, debtUsd, liquidationThreshold: lt,
      healthFactor: collateralUsd != null && debtUsd ? (collateralUsd * lt) / debtUsd : null, url, note });
  });
}
