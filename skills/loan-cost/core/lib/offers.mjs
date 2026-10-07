// Loanscape offers for one pair, by token address. Same endpoint the borrow-rates script reads.
import { getJson } from "./rpc.mjs";
export const LOANSCAPE = process.env.LOANSCAPE_BASE_URL || "https://loanscape.lotuslabs.net";
export const APP = "https://loanscape.lotuslabs.net";
export async function fetchOffers(chainId, collAddr, borrowAddr) {
  const j = await getJson(`${LOANSCAPE}/api/offers?chain=${chainId}&coll=${collAddr}&borrow=${borrowAddr}`);
  if (j.error) throw new Error(j.error);
  return { coll: j.coll, borrow: j.borrow, updatedAt: j.updatedAt, offers: (j.offers || []).map((o) => ({
    venue: o.instanceLabel || o.protocolName || o.protocol, protocol: o.protocol, apr: num(o.apr), maxLtv: num(o.maxLtv), recLtv: num(o.recLtv), lltv: num(o.lltv), liquidityUsd: num(o.liquidityUsd), stability: o.stability || null, sparkline: Array.isArray(o.sparkline) ? o.sparkline.map(Number) : [], marketRef: o.marketRef || null, note: o.note || null, url: o.url || null })) };
}
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };
export const deepLink = (collSym, borrowSym, rank, src = "claude") => `${APP}/?coll=${encodeURIComponent(collSym)}&borrow=${encodeURIComponent(borrowSym)}${rank ? `&rank=${rank}` : ""}&src=${src}`;

// Link policy: a link is a next move the chat can't deliver, offered once per pair per conversation (6h window), never as a footer.
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
const LINK_TTL_MS = 6 * 3600 * 1000;
// Memory lives in the first writable home: $LOANSCAPE_HOME, then ~/.loanscape, then ./.claude/loanscape in the working
// directory (sandboxes that block the home folder still allow the project), else nowhere (the scripts print, just without memory).
const CANDIDATES = [process.env.LOANSCAPE_HOME, join(homedir(), ".loanscape"), join(process.cwd(), ".claude", "loanscape")].filter(Boolean);
function writable(dir) { try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); const probe = join(dir, ".w"); writeFileSync(probe, "1"); try { unlinkSync(probe); } catch {} return true; } catch { return false; } }
let HOME = null;
// The project fallback holds wallet addresses and positions, so it ignores itself: a `git add -A` there commits nothing from it.
export function memHome() { if (HOME !== null) return HOME; for (const d of CANDIDATES) { if (writable(d)) { if (d === CANDIDATES[CANDIDATES.length - 1] && !process.env.LOANSCAPE_HOME) { try { writeFileSync(join(d, ".gitignore"), "*\n"); } catch {} } HOME = d; return HOME; } } HOME = ""; return HOME; }
export function memPath() { const h = memHome(); return h ? join(h, "memory.json") : null; }
// Read from the same home we write to, never from another candidate: a fresh LOANSCAPE_HOME must not see ~/.loanscape,
// and "forget my wallet" must not bring back a wallet saved somewhere else.
export function loadMem() { const p = memPath(); if (p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch {} } return { version: 1, wallets: {}, defaultWallet: null }; }
export function cachePath() { const h = memHome(); return h ? join(h, "cache.json") : null; }
export function saveMem(m) { const p = memPath(); if (!p) return false; try { writeFileSync(p, JSON.stringify(m, null, 2)); return true; } catch { return false; } }
// Returns the link line for this pair if it hasn't been offered recently, and marks it offered in `mem` (caller saves).
export function pairLinkOnce(mem, chainId, collSym, borrowSym, rank = null) {
  if (Number(chainId) !== 1) return null; // the app's page shows Ethereum; a link from a Base or Arbitrum read would land on the wrong chain
  const key = `${chainId}:${collSym}/${borrowSym}`; mem.linked ||= {};
  const last = mem.linked[key]; if (last && Date.now() - new Date(last).getTime() < LINK_TTL_MS) return null;
  mem.linked[key] = new Date().toISOString();
  return `Every venue on this pair, live: ${deepLink(collSym, borrowSym, rank)}`;
}

function depthWord(x) { return x >= 1e9 ? `$${(x / 1e9).toFixed(1)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${Math.round(x / 1e3)}k` : `$${Math.round(x)}`; }

// One prose name for a venue across every script: "Aave", "Aave Prime", "Aave e-mode", "Spark", "Compound", "Fluid", "Morpho".
// Morpho carries its LLTV ("Morpho 94.5%") only when the context list holds more than one Morpho market.
export function venueName(o, ctx) {
  const v = (typeof o === "string" ? o : o.venue) || ""; const proto = typeof o === "string" ? "" : o.protocol;
  if (proto === "morpho-blue" || /^Morpho/.test(v)) {
    const peers = ctx ? ctx.filter((x) => x.protocol === "morpho-blue" || /^Morpho/.test(x.venue || "")) : []; const m = v.match(/(\d+(?:\.\d+)?)% LLTV/);
    if (peers.length < 2 || !m) return "Morpho";
    // Two markets at the same LLTV (different oracle) would read as one name. A reader can't use a market hash, so the twin is named by
    // what's available in it ("Morpho 86% ($53.9M market)"); the hash is the fallback only when two twins round to the same depth.
    const twins = peers.filter((x) => x !== o && (x.venue || "").includes(`${m[1]}% LLTV`)); const ref = typeof o === "string" ? null : o.marketRef;
    if (!twins.length) return `Morpho ${m[1]}%`;
    const depth = typeof o === "string" || o.liquidityUsd == null ? null : depthWord(o.liquidityUsd);
    if (depth && !twins.some((x) => x.liquidityUsd != null && depthWord(x.liquidityUsd) === depth)) return `Morpho ${m[1]}% (${depth} market)`;
    return ref ? `Morpho ${m[1]}% (${String(ref).replace(/^0x/, "").slice(0, 6)})` : `Morpho ${m[1]}%`;
  }
  if (/^Fluid/.test(v)) return "Fluid";
  if (/^Compound/.test(v)) return "Compound";
  if (/^Spark/.test(v)) return "Spark";
  if (/^Aave/.test(v)) return ["Aave", /prime/i.test(v) ? "Prime" : null, /e-mode/i.test(v) ? "e-mode" : null].filter(Boolean).join(" ");
  return v.replace(" v3", "").replace(" · Main", "").replace(/ · [0-9a-f]{6}$/, "");
}
