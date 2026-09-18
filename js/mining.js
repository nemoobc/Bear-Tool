// ═══════════════════════════════════════════════════════════════
// Bear Tool — mining.js
// Proof-of-Work mining (SHA-256), fully client-side.
//   challenge:  prefix + target (target = 2^(256 - 4*difficulty) - 1)
//   work:       find nonce so that sha256(prefix + nonce) < target
// Pure core (sha256Hex / makeChallenge / isValidPoW / findNonce) is
// testable in Node; the UI orchestrates threads + progress + stop.
// ═══════════════════════════════════════════════════════════════

// SHA-256 of a string → lowercase hex (crypto.subtle, available in
// browsers and Node >= 20).
export async function sha256Hex(data) {
  const bytes = new TextEncoder().encode(String(data));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Build a challenge. difficulty = number of leading zero hex digits in the
// target (bitcoin-style). prefix is hex; a random one is generated if absent.
export function makeChallenge({ difficulty = 4, prefix } = {}) {
  if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 32) {
    throw new Error('difficulty must be an integer 1..32');
  }
  if (!prefix) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    prefix = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  if (!/^[0-9a-fA-F]+$/.test(prefix)) throw new Error('prefix must be hex');
  const target = (1n << (256n - 4n * BigInt(difficulty))) - 1n;
  return { prefix, difficulty, target };
}

// Verify a nonce against the challenge: sha256(prefix + nonce) < target.
export async function isValidPoW({ prefix, nonce, target }) {
  const hash = await sha256Hex(prefix + BigInt(nonce).toString(16));
  return BigInt('0x' + hash) < target;
}

// Search for a valid nonce. Async + chunked so the UI stays responsive.
//   startNonce: where to start (threads split the space: i * 2^32)
//   maxNonce:   hard stop (default 2^32 per thread)
//   onProgress: ({ nonce, hashes, speed }) called every chunk
//   signal:     AbortSignal → stops and resolves null
// Returns { nonce, hash } or null when stopped / not found.
export async function findNonce({ prefix, target, startNonce = 0, maxNonce = 2 ** 32, onProgress, signal }) {
  const CHUNK = 256;
  let nonce = startNonce;
  let hashes = 0;
  const started = Date.now();
  for (; nonce < startNonce + maxNonce; nonce++) {
    if (signal?.aborted) return null;
    const hash = await sha256Hex(prefix + BigInt(nonce).toString(16));
    hashes++;
    if (BigInt('0x' + hash) < target) {
      return { nonce, hash, hashes, elapsedMs: Date.now() - started };
    }
    if (hashes % CHUNK === 0) {
      const elapsedMs = Date.now() - started;
      onProgress?.({ nonce, hashes, speed: elapsedMs > 0 ? Math.round((hashes / elapsedMs) * 1000) : 0 });
      // yield to the event loop so the UI can paint / stop can land
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  return null;
}

// Run `threads` parallel searches over disjoint nonce ranges.
// Resolves the first valid nonce found (or null on stop / exhaustion).
export async function mineChallenge({ prefix, target, threads = 1, onProgress, signal }) {
  const started = Date.now();
  let totalHashes = 0;
  const progress = (p) => {
    totalHashes += p.hashes;
    const elapsedMs = Date.now() - started;
    onProgress?.({
      nonce: p.nonce,
      hashes: totalHashes,
      speed: elapsedMs > 0 ? Math.round((totalHashes / elapsedMs) * 1000) : 0
    });
  };
  const workers = [];
  for (let i = 0; i < threads; i++) {
    workers.push(findNonce({
      prefix, target,
      startNonce: i * 2 ** 32,
      maxNonce: 2 ** 32,
      onProgress: progress,
      signal
    }));
  }
  const results = await Promise.all(workers);
  const found = results.find(Boolean);
  if (found) {
    found.elapsedMs = Date.now() - started;
    found.hashes = totalHashes;
  }
  return found || null;
}