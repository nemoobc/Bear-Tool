// Browser E2E runner. Starts the static server, runs Playwright, stops the server.
//
// This replaces `bash tests/e2e/run.sh`, and for the same reason tools/check.mjs
// replaced the shell loop that ran `npm run check`.
//
// The shell version was the second time a gate was written in a form that could
// not run where the tests run. It used python3 -m http.server, curl -sf, seq, a
// backgrounded subshell and LD_LIBRARY_PATH — every one of those is a Linux shape.
// `test:e2e` is in package.json, so it looked like part of the suite, and it never
// ran: 21 specs sat in tests/e2e/ and `test:all` does not include test:e2e, so
// nothing ever noticed. On a machine that does not have Git Bash and a matching
// python3, the script fails before it reaches Playwright.
//
// A Node runner fixes it at the root: no shell, no curl, no backgrounded process
// with an orphaned port, and the server's lifetime is a try/finally rather than a
// hope. The same command then works on Termux and on the Windows box, which is
// the only property that matters for a gate.
//
//   node tools/e2e.mjs                    # whole suite, chromium
//   node tools/e2e.mjs --browser firefox  # the browser we have no coverage for
//   node tools/e2e.mjs 01-wallet-create    # one spec, by substring
//   node tools/e2e.mjs --headed           # watch it run
//   node tools/e2e.mjs --list             # what would run, and where each stands

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const PORT = Number(process.env.BEAR_PORT || 8080);
const BASE_URL = process.env.BEAR_BASE_URL || `http://127.0.0.1:${PORT}`;

// The first endpoint that actually answers, and the block it reports. A real
// POST with eth_blockNumber, because an OPTIONS preflight says nothing about
// whether the node answers — and because the app's own path is a POST.
async function pickRpc() {
  const urls = String(process.env.E2E_RPC_URLS || [
    'https://ethereum-rpc.publicnode.com',
    'https://eth.drpc.org',
  ]).split(',').map((x) => x.trim()).filter(Boolean);
  const tried = [];
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
        signal: AbortSignal.timeout(8000),
      });
      const j = await r.json();
      if (j && j.result) return { ok: true, url, block: parseInt(j.result, 16) };
      tried.push(url + ' (no result)');
    } catch (e) {
      tried.push(url + ' (' + (e?.name || 'error') + ')');
    }
  }
  return { ok: false, tried };
}

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

// ── a static server, in this process ───────────────────────────────────────
// serve.js already exists for the box, but this needs to start and stop with the
// run. A port left behind by a crashed run is the failure mode that makes the
// next run adopt a stale server and test somebody else's files.

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
};

const server = createServer(async (req, res) => {
  try {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    // Contain the path: a static server that will happily read outside its root is
    // a file-read hole, and this one is reachable from a test run.
    const target = path.join(root, rel === '/' ? 'index.html' : rel);
    if (!target.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[path.extname(target)] || 'application/octet-stream',
      'cache-control': 'no-store',
    }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

const closeServer = () => new Promise((r) => server.close(r));
let exitCode = 1;

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  });
  console.log(`server  ${BASE_URL}  (root ${root})`);

  const specDir = path.join(root, 'tests', 'e2e');
  if (!existsSync(specDir)) throw new Error(`tests/e2e tidak ada di ${root}`);
  const specs = (await readdir(specDir)).filter((f) => f.endsWith('.spec.js')).sort();

  if (flag('--list')) {
    for (const s of specs) {
      const size = (await stat(path.join(specDir, s))).size;
      console.log(`  ${s.padEnd(34)} ${String(size).padStart(6)} b`);
    }
    console.log(`\n${specs.length} spec di tests/e2e`);
    exitCode = 0;
    throw { silent: true };
  }

  // A bare argument filters specs by substring, so `01` and `wallet-create` both
  // work and a positional path is not mistaken for a filter. Flags are excluded and
  // so are the values that follow them.
  const flagVals = new Set(['--browser', '--project', '--grep', '--reporter']);
  const terms = argv.filter((a, i) =>
    !a.startsWith('--') && !flagVals.has(argv[i - 1]));
  const wanted = terms.length ? specs.filter((s) => terms.some((t) => s.includes(t))) : specs;
  if (terms.length && !wanted.length) {
    throw new Error(`tidak ada spec yang cocok dengan: ${terms.join(', ')}`);
  }

  // Invoke Playwright's Node entry directly, not `npx playwright`.
  //
  // `npx` resolves the binary through PATH, and on this machine the package is
  // installed — node_modules/@playwright/test/cli.js exists, node_modules/.bin has
  // the shim — while `npx playwright --version` answers "playwright: not found".
  // Going through PATH here is the same indirection that made `npm run check` fail
  // on Windows and `test:e2e` fail everywhere, and it is avoidable: spawn this
  // node against the CLI file. No shim, no PATH, no shell.
  const cli = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');
  if (!existsSync(cli)) {
    throw new Error(`@playwright/test tidak terpasang — npm install (diper_PLAYWRIGHT_PATH: ${cli})`);
  }

  // Does this machine have a chain for the specs to talk to?
  //
  // Measured: on a box where all four public Ethereum endpoints answered in
  // ~100ms, the specs still failed — every one of them, at exactly the 45s test
  // timeout. The reason is not reachability. The app boots against REAL mainnet
  // with a freshly generated wallet, which holds nothing, so the token list is
  // empty and every "wait for the token dropdown" step times out.
  //
  // That produces a wall of failures that says nothing about the app, and it is
  // indistinguishable from a real regression: the untouched HEAD produced MORE of
  // them than the patched tree did. A gate that fails identically with and
  // without the change under test measures nothing.
  //
  // So the precondition is checked up front and stated plainly, instead of being
  // discovered 45 seconds at a time.
  // await matters: without it this is a Promise, `rpc.ok` is undefined, the guard
  // takes the failure branch, and the error it then reports is about `tried`
  // being undefined — a complaint about the pre-flight instead of the network.
  const rpc = await pickRpc();
  if (!rpc.ok) {
    console.error('');
    console.error('  E2E TIDAK BISA MENGUKUR FITUR ON-CHAIN DI MESIN INI.');
    console.error('  Tidak ada endpoint RPC yang menjawab: ' + rpc.tried.join(', '));
    console.error('  Gejalanya: setiap spec yang butuh saldo atau token gagal pada timeout,');
    console.error('  bukan pada assertion — dan HEAD yang tidak disentuh gagal lebih banyak lagi.');
    console.error('  Jalankan dengan rantai berbiaya: FORK_PORT=<port anvil fork> node tools/e2e.mjs');
    throw { silent: true, code: 5 };
  }
  console.log(`  rpc  ${rpc.url}  (block ${rpc.block})`);

  // Point the app at a funded local chain when there is one.
  //
  // The specs import a funded key (helpers.fundedWallet) because a freshly
  // generated wallet holds nothing. That only means something if the app is
  // talking to a chain where the well-known tokens exist — so the chain has to be
  // a FORK, not a bare anvil, or the token contract reads fail and the list is
  // empty again. The override is seeded through storageState because that is
  // applied before any app code runs, which is the only point at which
  // localStorage is still empty.
  const local = String(process.env.E2E_RPC || '').trim();
  if (local) {
    const stateFile = path.join(os.tmpdir(), 'bear-e2e-storage.json');
    writeFileSync(stateFile, JSON.stringify({
      cookies: [],
      origins: [{
        origin: BASE_URL,
        localStorage: [{ name: 'bear.rpcOverrides', value: JSON.stringify({ ethereum: [local] }) }],
      }],
    }));
    process.env.BEAR_STORAGE_STATE = stateFile;
    console.log(`  chain ${local}  (seeded as an RPC override for every page)`);
  }

  // Check for an installed browser BEFORE launching, because the failure otherwise
  // arrives as a stack trace from inside playwright-core on stderr, which says
  // nothing to whoever ran the gate. Catching it afterwards is not possible either:
  // the error is the child process exiting non-zero, not a rejected promise here.
  const browserDirs = [
    path.join(process.env.HOME || '', '.cache', 'ms-playwright'),
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'),
    path.join(process.env.HOME || '', 'Library', 'Caches', 'ms-playwright'),
  ];
  const hasBrowser = browserDirs.some((d) => {
    try { return readdirSync(d).some((f) => f.startsWith('chromium') || f.startsWith('firefox')); }
    catch { return false; }
  });
  if (!hasBrowser) {
    console.error('');
    console.error('  E2E TIDAK BISA JALAN DI MESIN INI — tidak ada browser Playwright terpasang.');
    console.error('  Pasang di mesin yang bisa menjalankan browser: npx playwright install chromium');
    console.error('  Direktori yang diperiksa: ' + browserDirs.filter((d) => d).join(', '));
    console.error('  Ini bukan kegagalan app. Suite browser sengaja hanya jalan di mesin itu.');
    throw { silent: true, code: 5 };
  }

  // playwright.config.js declares no `projects`, so --project is not a valid choice
  // here and passing one fails with "project is not defined" before a single spec
  // runs. Playwright's own flag is --browser, which works without a projects array.
  // Left off entirely, the config's default browser is used.
  const browser = opt('--browser', null);
  const args = [cli, 'test'];
  if (browser) args.push(`--browser=${browser}`);
  if (flag('--headed')) args.push('--headed');
  for (const a of argv) {
    if (a.startsWith('--') && a !== '--headed' && a !== '--list' && a !== '--browser' && a !== browser) {
      args.push(a);
    }
  }
  for (const g of terms) args.push(g);

  const env = { ...process.env, BEAR_BASE_URL: BASE_URL };
  console.log(`playwright  browser=${browser || 'config default'}  specs=${wanted.length}  headless=${!flag('--headed')}`);

  exitCode = await new Promise((resolve) => {
    // process.execPath, not "npx" — see the note where the CLI path is resolved.
    const pw = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
    pw.on('exit', (code) => resolve(code ?? 1));
    pw.on('error', (e) => { console.error('gagal menjalankan playwright:', e.message); resolve(2); });
  });
} catch (e) {
  if (!e?.silent) console.error('e2e:', e?.message || e);
  if (e?.code === 5) { exitCode = 5; }
  if (!e?.silent && String(e?.code || '').includes('ENOENT')) {
    console.error('  playwright tidak terpasang — npm install');
  }
} finally {
  await closeServer();
}

process.exit(exitCode);
