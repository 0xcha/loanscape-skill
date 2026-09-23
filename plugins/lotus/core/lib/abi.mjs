// Just enough ABI encoding/decoding for static calls with address/uint args and word-aligned returns.
import { selector } from "./keccak.mjs";
const w = (h) => h.replace(/^0x/, "").padStart(64, "0");
export const encAddress = (a) => w(a.toLowerCase());
export const encUint = (n) => w(BigInt(n).toString(16));
export const encode = (sig, args = []) => selector(sig) + args.map((a) => (typeof a === "string" && a.startsWith("0x") && a.length === 42 ? encAddress(a) : encUint(a))).join("");
export function words(hex) { const h = (hex || "0x").replace(/^0x/, ""); const out = []; for (let i = 0; i + 64 <= h.length; i += 64) out.push(h.slice(i, i + 64)); return out; }
export const asUint = (word) => BigInt("0x" + (word || "0"));
export const asAddress = (word) => "0x" + (word || "").slice(24);
export const asInt = (word) => { const v = asUint(word); return v > (1n << 255n) ? v - (1n << 256n) : v; };
export const fmt = (big, decimals, dp = 6) => Number(big) / 10 ** decimals; // fine for display; not for accounting
