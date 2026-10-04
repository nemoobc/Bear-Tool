// Bear Tool — debug relay.
//
// Receives auto-reports from js/debug-collector.js (POST /report, CORS any),
// appends them as JSONL and prints one line per report. POST /clear truncates
// the file (the Settings "Delete logs" button). Run beside the app:
//
//   node tools/debug-relay.mjs &
//
// Env: BEAR_DEBUG_PORT (default 7331), BEAR_DEBUG_FILE (default
// tmp/debug-reports.ndjson). Loop protection: this server never calls the
// app; the collector bypasses its own hook for this port (it reads the SAME
// BEAR_DEBUG_PORT knob, so moving the relay moves the bypass with it).
// Log ceiling: after every append, a file past 512KB is trimmed to its newest
// 256KB (trimLog) — growth is bounded, and only the newest reports are lost.

import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.BEAR_DEBUG_PORT || 7331);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILE = process.env.BEAR_DEBUG_FILE || path.join(ROOT, 'tmp', 'debug-reports.ndjson');
mkdirSync(path.dirname(FILE), { recursive: true });

// Trim ceiling. The EIP-7702 sweep writes one line per endpoint and a full run
// is ~25 lines; nobody chases a failure through a file that has grown without
// limit. Above 512KB the file is cut back to its LAST 256KB — the newest
// reports, which is where the failure being chased lives.
const TRIM_AT_BYTES = 512 * 1024;
const TRIM_KEEP_BYTES = 256 * 1024;

/**
 * Cut the log back to its newest 256KB when it passed 512KB.
 *
 * Runs after every append, so growth is bounded by the ceiling, not by how long
 * the relay stays up. The cut starts at a newline: a slice that began mid-line
 * would leave one unparseable record at the head, and every reader does
 * `split('\n').map(JSON.parse)`. Truncate in place (writeFileSync over the same
 * path), never unlink — appendFileSync holds the inode open, and unlinking
 * would leave the running process appending to a file nobody can see (the same
 * reason /clear truncates rather than deletes).
 *
 * @returns {boolean} true when the file was trimmed
 */
export function trimLog(file = FILE, atBytes = TRIM_AT_BYTES, keepBytes = TRIM_KEEP_BYTES) {
  try {
    if (statSync(file).size <= atBytes) return false;
    const buf = readFileSync(file);
    let slice = buf.subarray(Math.max(0, buf.length - keepBytes));
    const nl = slice.indexOf(0x0a);
    if (nl >= 0 && nl + 1 < slice.length) slice = slice.subarray(nl + 1);
    writeFileSync(file, slice);
    return true;
  } catch (e) {
    // A trimming failure must never take the relay down: the report is already
    // on disk, only the ceiling was missed.
    console.error('relay: trim gagal:', e.message);
    return false;
  }
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  // Chrome Private Network Access: public origin → loopback target.
  'access-control-allow-private-network': 'true',
};

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  if (req.method === 'POST' && req.url === '/report') {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= 65536) chunks.push(c);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let entry;
      try { entry = JSON.parse(body); } catch { entry = { kind: 'malformed', raw: body.slice(0, 500) }; }
      try { appendFileSync(FILE, JSON.stringify(entry) + '\n'); } catch (e) {
        console.error('relay: tulis gagal:', e.message);
      }
      // Bounded growth: a report flood (a 7702 sweep) cannot make the log
      // unreadable-by-size. Runs only after a write, so /clear stays a clear.
      trimLog(FILE);
      console.log(`[report] seq=${entry.seq ?? '?'} kind=${entry.kind ?? '?'} ${entry.detail?.msg || entry.detail?.message || entry.detail?.url || ''}`.slice(0, 300));
      res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }
  // The EIP-7702 scan floods this file with one rpc-error per endpoint (a full
  // sweep is ~25 lines). POST /clear truncates it so the Settings button can
  // hand the user an empty log again — truncate, never unlink, so the running
  // appendFileSync keeps pointing at the same inode.
  if (req.method === 'POST' && req.url === '/clear') {
    try { writeFileSync(FILE, ''); } catch (e) {
      console.error('relay: clear gagal:', e.message);
      res.writeHead(500, { ...CORS, 'content-type': 'application/json' });
      res.end('{"ok":false}');
      return;
    }
    console.log('[clear] log dihapus oleh klien');
    res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  res.writeHead(404, CORS);
  res.end('{"error":"not found"}');
});

// Listen only when run as a program: `node tools/debug-relay.mjs` (the way the
// docs and tests spawn it). Importing this module for trimLog() must not open
// a port — a test that wants the function gets the function, not a server.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`bear-debug-relay: http://127.0.0.1:${PORT}/report → ${FILE}`);
  });
}
