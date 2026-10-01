// Minimal JSON-RPC over keyless public endpoints. No deps. Node's fetch ignores HTTP(S)_PROXY, so behind a proxy we fall back to curl.
// Free public RPCs fail in different ways: dRPC rejects batches over 3 calls, publicnode rate-limits bursts, others go keyed or dead.
// So every request goes to the least-busy healthy endpoint (preference order, at most MAX_INFLIGHT open requests each), a batch is split
// to that endpoint's limit, an endpoint that rejects a batch is sent the calls one by one, and a 429, 5xx or timeout cools that endpoint
// down with backoff while the request retries on the next. Endpoint health is shared by every reader in the process.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

// Keyless, best first. batch = the largest JSON-RPC batch the free tier accepts. Each was called live on 2026-10-01 (eth_call, batches
// of 3/4/10, a burst of 12). Dropped: Ankr (now needs an API key), 1rpc (usage limit reached), llamarpc and blockpi (down).
// LOANSCAPE_RPC_<chainId>=url[,url...] puts your own endpoints first, e.g. LOANSCAPE_RPC_1=https://my-node.example.
export const RPCS = {
  1: [{ url: "https://eth-pokt.nodies.app", batch: 10 }, { url: "https://eth-mainnet.public.blastapi.io", batch: 10 }, { url: "https://ethereum-rpc.publicnode.com", batch: 10 }, { url: "https://rpc.mevblocker.io", batch: 10 }, { url: "https://eth.drpc.org", batch: 3 }],
  8453: [{ url: "https://base-rpc.publicnode.com", batch: 10 }, { url: "https://base-pokt.nodies.app", batch: 10 }, { url: "https://base-mainnet.public.blastapi.io", batch: 10 }, { url: "https://base.drpc.org", batch: 3 }, { url: "https://mainnet.base.org", batch: 3 }],
  42161: [{ url: "https://arbitrum-one-rpc.publicnode.com", batch: 10 }, { url: "https://arb1.arbitrum.io/rpc", batch: 10 }, { url: "https://arb-pokt.nodies.app", batch: 10 }, { url: "https://arbitrum-one.public.blastapi.io", batch: 10 }, { url: "https://arbitrum.drpc.org", batch: 3 }],
};
const DEFAULT_BATCH = 10, MAX_INFLIGHT = 4, CALL_BUDGET_MS = 30000, MAX_COOLDOWN_MS = 5000;
const UA = "loanscape-skill/0.1 (+https://loanscape.lotuslabs.net)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const host = (url) => { try { return new URL(url).host; } catch { return url; } };
let curlFirst = false; // set once fetch fails and curl gets through (a proxy), so later requests don't wait on fetch again

// One HTTP exchange. Returns parsed JSON; throws "HTTP <status>: <provider's message>" on a non-2xx or non-JSON reply.
async function exchange(url, init, curlArgs, timeoutMs) {
  let status, reply;
  if (!curlFirst) {
    try { const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }); status = res.status; reply = await res.text(); }
    catch { ({ status, reply } = await curl(curlArgs, url, timeoutMs)); curlFirst = true; }
  } else ({ status, reply } = await curl(curlArgs, url, timeoutMs));
  let j; try { j = JSON.parse(reply); } catch {}
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status}${detail(j, reply)}`);
  if (j === undefined) throw new Error(`HTTP ${status}: non-JSON reply`);
  return j;
}
async function curl(args, url, timeoutMs) {
  try {
    const { stdout } = await run("curl", ["-sS", "--max-time", String(Math.ceil(timeoutMs / 1000)), "-A", UA, "-w", "\n%{http_code}", ...args, url], { encoding: "utf8", maxBuffer: 1 << 26 });
    const cut = stdout.lastIndexOf("\n");
    return { status: Number(stdout.slice(cut + 1)), reply: stdout.slice(0, cut) };
  } catch (e) { const m = String(e.stderr || e.message).trim().split("\n").pop(); throw new Error(m.startsWith("curl:") ? m : `curl: ${m}`); }
}
function detail(j, reply) {
  const first = Array.isArray(j) ? j.find((r) => r?.error)?.error : j?.error;
  const m = (typeof first === "string" ? first : first?.message) || j?.message || String(reply || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return m ? `: ${String(m).slice(0, 120)}` : "";
}

export async function postJson(url, body, timeoutMs = 15000) {
  const text = JSON.stringify(body);
  return exchange(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": UA }, body: text }, ["-H", "content-type: application/json", "-d", text], timeoutMs);
}

// Why a request failed decides what happens next: try the next endpoint now, cool this one down, drop it for the run, or stop.
const REVERT = /revert/i; // the contract said no: every endpoint will say the same
const DEAD = /HTTP 40[1-4]\b|HTTP 410\b|unauthori[sz]ed|api key|authenticate|usage limit|paid plan|discontinued|not whitelisted|not supported|Failed to connect|Could not connect|Could not resolve|ECONNREFUSED|ENOTFOUND/i; // unreachable counts too: a run lasts seconds
const health = new Map(); // url → { busy, until, fails, batch, dead, last }, shared by every makeRpc() in the process
const stateOf = (e) => { let s = health.get(e.url); if (!s) health.set(e.url, (s = { busy: 0, until: 0, fails: 0, batch: e.batch || DEFAULT_BATCH, dead: false, last: null })); return s; };

export function makeRpc(chainId, endpoints = RPCS[chainId]) {
  const own = String(process.env[`LOANSCAPE_RPC_${chainId}`] || "").split(",").map((u) => u.trim()).filter(Boolean);
  const eps = [...own, ...(endpoints || [])].map((e) => (typeof e === "string" ? { url: e, batch: DEFAULT_BATCH } : e));
  if (!eps.length) throw new Error(`no RPC endpoints for chain ${chainId}`);
  let id = 1;

  // The least-busy healthy endpoint, preferring one this request hasn't tried yet; waits out cooldowns, null when none is left.
  async function pick(tried, deadline) {
    for (;;) {
      const live = eps.filter((e) => !stateOf(e).dead); if (!live.length) return null;
      const now = Date.now();
      const ready = live.filter((e) => stateOf(e).until <= now && stateOf(e).busy < MAX_INFLIGHT);
      const e = ready.find((x) => !tried.has(x.url)) || ready[0];
      if (e) { stateOf(e).busy++; return e; }
      const wait = Math.max(25, Math.min(...live.map((x) => stateOf(x).until - now)));
      if (now + wait > deadline) return null;
      await sleep(Math.min(wait, 250));
    }
  }

  // calls: [{ method, params }] → results in the same order. One call goes alone; several go as batches no larger than the endpoint takes.
  async function send(calls) {
    const deadline = Date.now() + CALL_BUDGET_MS, tried = new Set(), maxTries = Math.max(4, eps.length * 2 + 1);
    for (let tries = 0; tries < maxTries;) {
      const e = await pick(tried, deadline); if (!e) break;
      const s = stateOf(e);
      if (calls.length > s.batch) { s.busy--; return chunked(calls, s.batch); }
      tries++; tried.add(e.url);
      const single = calls.length === 1;
      const body = single ? { jsonrpc: "2.0", id: id++, method: calls[0].method, params: calls[0].params } : calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, method: c.method, params: c.params }));
      try {
        const j = await postJson(e.url, body, single ? 12000 : 15000);
        let rows;
        if (single) rows = [j];
        else {
          if (!Array.isArray(j)) throw Object.assign(new Error(`batch of ${calls.length} answered with one object${detail(j, "")}`), { batch: true });
          const byId = new Map(j.map((r) => [Number(r?.id), r]));
          rows = calls.map((_, i) => byId.get(i + 1));
          if (rows.some((r) => !r)) throw Object.assign(new Error(`batch of ${calls.length} came back with ${j.length} results`), { batch: true });
        }
        const bad = rows.find((r) => r.error || r.result === undefined);
        if (bad) throw new Error(bad.error ? String(bad.error.message || JSON.stringify(bad.error)) : "reply had no result");
        s.busy--; s.fails = 0; s.until = 0;
        return rows.map((r) => r.result);
      } catch (err) {
        s.busy--;
        const msg = String(err.message || err); s.last = msg.slice(0, 140);
        if (REVERT.test(msg)) throw new Error(`${host(e.url)}: ${msg}`);
        if (!single && (err.batch || /batch/i.test(msg))) {
          // The endpoint refused the batch itself, not the calls: remember its limit and resend smaller, down to one by one.
          const n = /more than (\d+)/i.exec(msg); s.batch = Math.max(1, Math.min(n ? Number(n[1]) : 1, calls.length - 1));
          tries--; tried.delete(e.url); continue;
        }
        if (DEAD.test(msg)) { s.dead = true; continue; }
        // 429, 5xx, timeout, network, or anything unrecognised: cool down with exponential backoff and jitter, retry elsewhere.
        // Readers failing together on one endpoint count as one failure, so a burst doesn't escalate the backoff.
        const now = Date.now(); if (s.until <= now) s.fails++;
        s.until = Math.max(s.until, now + Math.min(MAX_COOLDOWN_MS, 300 * 2 ** (s.fails - 1)) * (0.75 + Math.random() / 2));
      }
    }
    throw new Error(`no RPC endpoint for chain ${chainId} answered: ${eps.map((e) => `${host(e.url)} (${stateOf(e).last || "not tried"})`).join("; ")}`);
  }
  async function chunked(calls, n) {
    const parts = []; for (let i = 0; i < calls.length; i += n) parts.push(calls.slice(i, i + n));
    return (await Promise.all(parts.map(send))).flat();
  }

  const one = async (method, params) => (await send([{ method, params }]))[0];
  const batch = (calls) => (calls.length ? send(calls) : Promise.resolve([]));
  const call = (to, data) => one("eth_call", [{ to, data }, "latest"]);
  const calls = (list) => batch(list.map(([to, data]) => ({ method: "eth_call", params: [{ to, data }, "latest"] })));
  return { one, batch, call, calls, chainId };
}

export async function getJson(url, timeoutMs = 15000) {
  try { return await exchange(url, { headers: { "user-agent": UA, "x-loanscape-client": "claude-skill" } }, ["-L", "-H", "x-loanscape-client: claude-skill"], timeoutMs); }
  catch (e) { const m = /^HTTP (\d+)/.exec(e.message); throw m ? new Error(`HTTP ${m[1]} from ${url}`) : e; }
}
