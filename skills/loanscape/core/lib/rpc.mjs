// Minimal JSON-RPC with fallback endpoints. No deps. Node's fetch ignores HTTP(S)_PROXY, so behind a proxy we fall back to curl.
import { execFileSync } from "node:child_process";
export const RPCS = {
  1: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org", "https://rpc.ankr.com/eth", "https://1rpc.io/eth"],
  8453: ["https://base-rpc.publicnode.com", "https://base.drpc.org", "https://mainnet.base.org"],
  42161: ["https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org", "https://arb1.arbitrum.io/rpc"],
};
const UA = "loanscape-skill/0.1 (+https://loanscape.lotuslabs.net)";
export async function postJson(url, body, timeoutMs = 15000) {
  const text = JSON.stringify(body);
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": UA }, body: text, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (String(e.message).startsWith("HTTP")) throw e;
    const out = execFileSync("curl", ["-sS", "--max-time", String(Math.ceil(timeoutMs / 1000)), "-A", UA, "-H", "content-type: application/json", "-d", text, url], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 24 });
    return JSON.parse(out);
  }
}
export function makeRpc(chainId, endpoints = RPCS[chainId]) {
  if (!endpoints) throw new Error(`no RPC endpoints for chain ${chainId}`);
  let idx = 0; let id = 1;
  const limited = (e) => /429|rate.?limit|too many|limit exceeded|capacity/i.test(String(e.message || e));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function one(method, params) {
    let lastErr;
    for (let tries = 0; tries < endpoints.length; tries++) {
      const url = endpoints[(idx + tries) % endpoints.length];
      for (let attempt = 0; attempt < 2; attempt++) { // one backoff retry on the same endpoint when it rate-limits, then rotate
        try {
          const j = await postJson(url, { jsonrpc: "2.0", id: id++, method, params });
          if (j.error) throw new Error(`${url}: ${j.error.message}`);
          idx = (idx + tries) % endpoints.length; return j.result;
        } catch (e) { lastErr = e; if (!limited(e) || attempt) break; await sleep(400 + 400 * attempt); }
      }
    }
    throw lastErr;
  }
  // batch: array of {method, params}; falls back to sequential if the endpoint rejects batches
  async function batch(calls) {
    let lastErr;
    for (let tries = 0; tries < endpoints.length; tries++) {
      const url = endpoints[(idx + tries) % endpoints.length];
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const j = await postJson(url, calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, method: c.method, params: c.params })), 20000);
          if (!Array.isArray(j)) throw new Error(`${url}: batch unsupported`);
          if (j.some((r) => r.error)) throw new Error(`${url}: ${j.find((r) => r.error).error.message}`);
          idx = (idx + tries) % endpoints.length; return j.sort((a, b) => a.id - b.id).map((r) => r.result);
        } catch (e) { lastErr = e; if (!limited(e) || attempt) break; await sleep(400 + 400 * attempt); }
      }
    }
    throw lastErr;
  }
  const call = (to, data) => one("eth_call", [{ to, data }, "latest"]);
  const calls = (list) => batch(list.map(([to, data]) => ({ method: "eth_call", params: [{ to, data }, "latest"] })));
  return { one, batch, call, calls, chainId };
}
export async function getJson(url, timeoutMs = 15000) {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, "x-loanscape-client": "claude-skill" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } catch (e) {
    if (String(e.message).startsWith("HTTP")) throw e;
    const out = execFileSync("curl", ["-sS", "-L", "--max-time", String(Math.ceil(timeoutMs / 1000)), "-A", UA, "-H", "x-loanscape-client: claude-skill", url], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 24 });
    return JSON.parse(out);
  }
}
