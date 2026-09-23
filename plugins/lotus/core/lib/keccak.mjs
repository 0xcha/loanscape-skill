// Keccak-256 (the Ethereum variant, padding 0x01), pure JS, BigInt lanes. Inputs here are tiny (names, selectors), speed is irrelevant.
const RC = [0x1n,0x8082n,0x800000000000808an,0x8000000080008000n,0x808bn,0x80000001n,0x8000000080008081n,0x8000000000008009n,0x8an,0x88n,0x80008009n,0x8000000an,0x8000808bn,0x800000000000008bn,0x8000000000008089n,0x8000000000008003n,0x8000000000008002n,0x8000000000000080n,0x800an,0x800000008000000an,0x8000000080008081n,0x8000000000008080n,0x80000001n,0x8000000080008008n];
const ROT = [[0,36,3,41,18],[1,44,10,45,2],[62,6,43,15,61],[28,55,25,21,56],[27,20,39,8,14]];
const M = (1n << 64n) - 1n;
const rotl = (x, n) => n === 0 ? x : (((x << BigInt(n)) | (x >> BigInt(64 - n))) & M);
function f(st) {
  for (let r = 0; r < 24; r++) {
    const C = [0, 1, 2, 3, 4].map((x) => st[x] ^ st[x + 5] ^ st[x + 10] ^ st[x + 15] ^ st[x + 20]);
    for (let x = 0; x < 5; x++) { const d = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1); for (let y = 0; y < 25; y += 5) st[x + y] ^= d; }
    const B = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(st[x + 5 * y], ROT[x][y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) st[x + 5 * y] = B[x + 5 * y] ^ ((~B[(x + 1) % 5 + 5 * y] & M) & B[(x + 2) % 5 + 5 * y]);
    st[0] ^= RC[r];
  }
}
export function keccak256(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : Uint8Array.from(input);
  const rate = 136; const st = new Array(25).fill(0n);
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate); padded.set(bytes); padded[bytes.length] ^= 0x01; padded[padded.length - 1] ^= 0x80;
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) { let lane = 0n; for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]); st[i] ^= lane; }
    f(st);
  }
  let out = ""; for (let i = 0; i < 4; i++) { let lane = st[i]; for (let b = 0; b < 8; b++) { out += (lane & 0xffn).toString(16).padStart(2, "0"); lane >>= 8n; } }
  return "0x" + out;
}
export const selector = (sig) => keccak256(sig).slice(0, 10);
export function namehash(name) {
  let node = new Uint8Array(32);
  if (!name) return "0x" + Buffer.from(node).toString("hex");
  for (const label of name.toLowerCase().split(".").reverse()) {
    const lh = hexToBytes(keccak256(label));
    node = hexToBytes(keccak256(new Uint8Array([...node, ...lh])));
  }
  return "0x" + Buffer.from(node).toString("hex");
}
export const hexToBytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
