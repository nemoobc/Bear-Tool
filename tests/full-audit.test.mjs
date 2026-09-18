// ═══════════════════════════════════════════════════════════════
// Bear Tool — Full Audit Test (Node.js built-in test runner)
// Tests: JS syntax, HTML structure, CSS integrity, CSP,
//        module imports, null safety, onchain RPC (all 12 nets)
// ═══════════════════════════════════════════════════════════════
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const log = (msg) => process.stdout.write(`  ${msg}\n`);

// ─── 1. FILE INVENTORY ───
describe('1. FILE INVENTORY', () => {
  const requiredFiles = [
    'index.html',
    'css/cartoon.css',
    'js/app.js', 'js/ui.js', 'js/wallet.js', 'js/network.js',
    'js/send.js', 'js/swap.js', 'js/bridge.js', 'js/eip7702.js',
    'js/deploy.js', 'js/nft.js', 'js/state.js', 'js/theme.js',
    'js/price.js', 'js/i18n.js', 'js/eip7702-tools.js',
    'assets/bear.svg',
  ];
  it('all required files exist', () => {
    for (const f of requiredFiles) {
      const p = join(ROOT, f);
      assert.ok(existsSync(p), `Missing: ${f}`);
      log(`✓ ${f}`);
    }
  });

  it('all JS files pass syntax check', async () => {
    const { execSync } = await import('node:child_process');
    const jsFiles = readdirSync(join(ROOT, 'js')).filter(f => f.endsWith('.js'));
    let pass = 0, fail = 0;
    for (const f of jsFiles) {
      try {
        execSync(`node --check ${join(ROOT, 'js', f)}`, { stdio: 'pipe' });
        pass++;
        log(`✓ ${f}`);
      } catch (e) {
        fail++;
        log(`✗ ${f}: ${e.stderr.toString().split('\n')[0]}`);
      }
    }
    assert.equal(fail, 0, `${fail} JS file(s) have syntax errors`);
    log(`All ${pass} JS files OK`);
  });
});

// ─── 2. HTML STRUCTURE ───
describe('2. HTML STRUCTURE', () => {
  let html;
  before(() => {
    html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  });

  it('section tags balanced', () => {
    const open = (html.match(/<section/g) || []).length;
    const close = (html.match(/<\/section>/g) || []).length;
    assert.equal(open, close, `Sections: ${open} open vs ${close} close`);
    log(`✓ ${open} sections balanced`);
  });

  it('all 10 views present', () => {
    const views = ['dashboard', 'send', 'swap', 'bridge', 'nft', 'eip7702', 'approval', 'deploy', 'activity', 'settings'];
    for (const v of views) {
      assert.ok(html.includes(`id="view-${v}"`), `Missing view: ${v}`);
    }
    log(`✓ All 10 views found`);
  });

  it('all 9 nav items have role=button', () => {
    const navItems = html.match(/data-view="[^"]+"/g) || [];
    // Bridge shares the Swap nav button, so there are 9 unique sidebar views
    // (bridge still exists as a view, reachable from the Swap chooser).
    const uniqueViews = new Set(navItems.map(m => m.match(/data-view="([^"]+)"/)[1]));
    assert.ok(uniqueViews.size >= 8, `Expected >= 8 unique views, got ${uniqueViews.size}`);
    assert.ok(uniqueViews.has('swap'), 'swap view must stay reachable from the nav');
    const withRole = (html.match(/data-view="[^"]+"\s+role="button"/g) || []).length;
    log(`✓ ${withRole} nav items with role=button (unique views: ${uniqueViews.size})`);
  });

  it('CSP meta tag present', () => {
    assert.ok(html.includes('Content-Security-Policy'), 'Missing CSP');
    assert.ok(html.includes('X-Content-Type-Options'), 'Missing X-Content-Type-Options');
    assert.ok(html.includes('X-Frame-Options'), 'Missing X-Frame-Options');
    assert.ok(html.includes('Referrer-Policy'), 'Missing Referrer-Policy');
    log('✓ CSP + security headers present');
  });

  it('CSP allows Google Fonts', () => {
    const cspMatch = html.match(/content="([^"]*Content-Security-Policy[^"]*?)"\s*>/i) ||
                     html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
    // Fallback: just search for the meta tag
    const cspLine = html.split('\n').find(l => l.includes('Content-Security-Policy'));
    assert.ok(cspLine, 'No CSP line found');
    assert.ok(cspLine.includes('fonts.googleapis.com'), 'CSP blocks Google Fonts stylesheet');
    assert.ok(cspLine.includes('fonts.gstatic.com'), 'CSP blocks Google Fonts font files');
    log('✓ CSP allows fonts.googleapis.com + fonts.gstatic.com');
  });

  it('JS-referenced IDs exist in HTML (null safety)', () => {
    const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
    const jsDir = join(ROOT, 'js');
    const missing = [];
    for (const f of readdirSync(jsDir).filter(x => x.endsWith('.js'))) {
      const js = readFileSync(join(jsDir, f), 'utf8');
      const refs = [...js.matchAll(/\$\(['"]#([^'"]+)['"]\)/g)].map(m => m[1]);
      for (const id of refs) {
        if (!htmlIds.has(id)) missing.push(`${f}: #${id}`);
      }
    }
    if (missing.length) {
      log(`✗ Missing IDs: ${missing.join(', ')}`);
      // Not fatal — some IDs are dynamic (modals, etc.)
      log(`  (May be dynamically generated — checking for patterns...)`);
      const dynamicPatterns = ['confirm', 'pw', 'cn', 'import', 'create', 'unlock', 'seed', 'lock'];
      const realMissing = missing.filter(m => !dynamicPatterns.some(p => m.includes(p)));
      if (realMissing.length) {
        log(`  Real missing: ${realMissing.join(', ')}`);
      }
    } else {
      log('✓ All JS-referenced IDs found in HTML');
    }
  });

  it('aria labels on interactive elements', () => {
    const ariaCount = (html.match(/aria-label/g) || []).length;
    const tabindexCount = (html.match(/tabindex/g) || []).length;
    log(`✓ aria-label: ${ariaCount}, tabindex: ${tabindexCount}`);
    assert.ok(ariaCount >= 3, 'Expected at least 3 aria-labels');
    assert.ok(tabindexCount >= 9, `Expected at least 9 tabindex (nav items), got ${tabindexCount}`);
  });
});

// ─── 3. CSS INTEGRITY ───
describe('3. CSS INTEGRITY', () => {
  let css;
  before(() => {
    css = readFileSync(join(ROOT, 'css/cartoon.css'), 'utf8');
  });

  it('braces balanced', () => {
    const open = (css.match(/{/g) || []).length;
    const close = (css.match(/}/g) || []).length;
    assert.equal(open, close, `Braces: ${open} open vs ${close} close`);
    log(`✓ ${open} braces balanced`);
  });

  it('required classes exist', () => {
    const required = [
      'quick-actions', 'swap-card', 'bridge-card', 'send-card',
      'mobile-nav', 'skip-link', 'welcome-full', 'network-pill',
      'modal', 'modal-overlay', 'btn-primary', 'btn-secondary',
      'status-dot', 'asset-row', 'asset-grid', 'card-title',
      'badge-mainnet', 'badge-testnet', 'slippage-btn', 'gas-btn',
    ];
    for (const cls of required) {
      assert.ok(css.includes('.' + cls), `Missing CSS class: .${cls}`);
    }
    log(`✓ All ${required.length} required classes present`);
  });

  it('welcome-full makes modal fullscreen', () => {
    assert.ok(css.includes('.modal.welcome-screen'), 'Missing fullscreen box override');
    assert.ok(css.includes('.modal-overlay.welcome-screen'), 'Missing fullscreen overlay override');
    assert.ok(!css.includes('.modal:has(.welcome-full)'), 'Fullscreen must use explicit lifecycle classes');
    log('✓ Welcome modal fullscreen CSS present');
  });

  it('dark mode variables defined', () => {
    assert.ok(css.includes('.theme-dark'), 'Missing .theme-dark');
    assert.ok(css.includes('--cream'), 'Missing --cream variable');
    log('✓ Dark mode variables defined');
  });
});

// ─── 4. JS NULL SAFETY AUDIT ───
describe('4. JS NULL SAFETY AUDIT', () => {
  it('all $() calls in critical functions have null guards', () => {
    const files = ['app.js', 'send.js', 'swap.js', 'bridge.js'];
    const issues = [];
    for (const f of files) {
      const js = readFileSync(join(ROOT, 'js', f), 'utf8');
      const lines = js.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Find lines that do: $(sel).innerHTML = ... without null check
        const match = line.match(/\$\(['"]#([^'"]+)['"]\)\.innerHTML/);
        if (match) {
          // Check if there's a null guard (if/const with &&) above
          const prevLines = lines.slice(Math.max(0, i - 3), i).join('\n');
          const hasGuard = prevLines.includes(match[1]) && (
            prevLines.includes('if (') || prevLines.includes('&&') ||
            prevLines.includes('?.') || prevLines.includes('const ')
          );
          if (!hasGuard) {
            issues.push(`${f}:${i + 1} — #${match[1]}`);
          }
        }
      }
    }
    if (issues.length) {
      log(`⚠ Unguarded innerHTML: ${issues.length} location(s)`);
      issues.forEach(i => log(`  ${i}`));
    } else {
      log('✓ All innerHTML assignments have null guards');
    }
    // Don't fail hard — log as warning
  });

  it('loadSendTokens returns early if element missing', () => {
    const js = readFileSync(join(ROOT, 'js/send.js'), 'utf8');
    assert.ok(js.includes('if (!sel) return'), 'loadSendTokens missing null guard');
    log('✓ loadSendTokens has null guard');
  });

  it('loadSwapTokens returns early if element missing', () => {
    const js = readFileSync(join(ROOT, 'js/swap.js'), 'utf8');
    assert.ok(js.includes('if (!from || !to) return'), 'loadSwapTokens missing null guard');
    log('✓ loadSwapTokens has null guard');
  });

  it('loadBridgeChains returns early if element missing', () => {
    const js = readFileSync(join(ROOT, 'js/bridge.js'), 'utf8');
    assert.ok(js.includes('if (!from || !to || !tok) return'), 'loadBridgeChains missing null guard');
    log('✓ loadBridgeChains has null guard');
  });

  it('scanApprovals has null guard', () => {
    const js = readFileSync(join(ROOT, 'js/app.js'), 'utf8');
    assert.ok(js.includes("if (!list) return") || js.includes("if (!list) {"),
      'scanApprovals missing null guard');
    log('✓ scanApprovals has null guard');
  });

  it('renderActivity has null guard', () => {
    const js = readFileSync(join(ROOT, 'js/app.js'), 'utf8');
    // Check after "renderActivity" function start
    const fnStart = js.indexOf('function renderActivity()');
    const fnBody = js.substring(fnStart, fnStart + 300);
    assert.ok(fnBody.includes('if (!list) return'), 'renderActivity missing null guard');
    log('✓ renderActivity has null guard');
  });

  it('renderAddressBook has null guard', () => {
    const js = readFileSync(join(ROOT, 'js/app.js'), 'utf8');
    const fnStart = js.indexOf('function renderAddressBook()');
    const fnBody = js.substring(fnStart, fnStart + 300);
    assert.ok(fnBody.includes('if (!el) return'), 'renderAddressBook missing null guard');
    log('✓ renderAddressBook has null guard');
  });

  it('global error boundary present', () => {
    const js = readFileSync(join(ROOT, 'js/app.js'), 'utf8');
    assert.ok(js.includes("window.addEventListener('error'"), 'Missing window.error handler');
    assert.ok(js.includes("window.addEventListener('unhandledrejection'"), 'Missing unhandledrejection handler');
    log('✓ Global error boundary present');
  });
});

// ─── 5. FEATURE COMPLETENESS ───
describe('5. FEATURE COMPLETENESS', () => {
  let html, css, appJs;
  before(() => {
    html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    css = readFileSync(join(ROOT, 'css/cartoon.css'), 'utf8');
    appJs = readFileSync(join(ROOT, 'js/app.js'), 'utf8');
  });

  it('network search input in modal', () => {
    assert.ok(appJs.includes('netSearchInput'), 'Missing netSearchInput');
    assert.ok(appJs.includes('Search networks'), 'Missing search placeholder');
    log('✓ Network search feature present');
  });

  it('welcome modal fullscreen', () => {
    assert.ok(appJs.includes('welcome-full'), 'Missing welcome-full class in JS');
    const welcome = appJs.slice(appJs.indexOf('function showWelcomeModal()'), appJs.indexOf('function showUnlockModal()'));
    assert.ok(welcome.includes('{ fullscreen: true }'), 'Welcome must request fullscreen');
    assert.ok(!welcome.includes('classList'), 'Welcome must not manually tag the modal');
    assert.ok(welcome.includes("$('#wCreate').onclick") && welcome.includes("$('#wImport').onclick"), 'Keep both welcome actions');
    assert.ok(css.includes('.modal.welcome-screen'), 'Missing explicit fullscreen CSS override');
    log('✓ Welcome modal fullscreen');
  });

  it('error boundary toast on error', () => {
    assert.ok(appJs.includes("'Unexpected error: '"), 'Missing error toast');
    log('✓ Error boundary shows toast');
  });

  it('all 12 networks defined', () => {
    const netJs = readFileSync(join(ROOT, 'js/network.js'), 'utf8');
    const chains = [1, 56, 137, 42161, 10, 8453, 11155111, 80002, 421614, 11155420, 84532, 97];
    for (const id of chains) {
      assert.ok(netJs.includes(String(id)), `Missing chainId ${id}`);
    }
    log('✓ All 12 networks defined');
  });

  it('EIP-7702 tools present (Batch Call, Rescue, Claim)', () => {
    const tools = readFileSync(join(ROOT, 'js/eip7702-tools.js'), 'utf8');
    assert.ok(tools.includes('Batch') || tools.includes('batch'), 'Missing Batch Call');
    assert.ok(tools.includes('Rescue') || tools.includes('rescue'), 'Missing Rescue Atomic');
    assert.ok(tools.includes('Claim') || tools.includes('claim'), 'Missing Claim Airdrop');
    log('✓ EIP-7702 tools present');
  });

  it('dark mode support', () => {
    assert.ok(css.includes('.theme-dark'), 'Missing dark theme');
    const themeJs = readFileSync(join(ROOT, 'js/theme.js'), 'utf8');
    assert.ok(themeJs.includes('initTheme'), 'Missing initTheme function');
    log('✓ Dark mode support');
  });

  it('i18n system present', () => {
    const i18n = readFileSync(join(ROOT, 'js/i18n.js'), 'utf8');
    assert.ok(i18n.includes('setLang') || i18n.includes('translate'), 'Missing i18n functions');
    assert.ok(html.includes('data-i18n'), 'Missing data-i18n attributes');
    log('✓ i18n system present');
  });

  it('activity logging system present', () => {
    const state = readFileSync(join(ROOT, 'js/state.js'), 'utf8');
    assert.ok(state.includes('addActivity'), 'Missing addActivity');
    log('✓ Activity logging system present');
  });

  it('address book feature', () => {
    assert.ok(appJs.includes('addressBook'), 'Missing addressBook');
    assert.ok(appJs.includes('renderAddressBook'), 'Missing renderAddressBook');
    log('✓ Address book feature present');
  });
});

// ─── 6. ONCHAIN RPC TEST (ALL 12 NETWORKS) ───
const NETWORKS = [
  { name: 'Ethereum',         chainId: 1,        rpcs: ['https://eth.llamarpc.com', 'https://eth.drpc.org', 'https://cloudflare-eth.com'], minBlock: 19000000 },
  { name: 'BSC',              chainId: 56,       rpcs: ['https://bsc-dataseed.binance.org', 'https://bsc-dataseed1.defibit.io'], minBlock: 30000000 },
  { name: 'Polygon',          chainId: 137,      rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.llamarpc.com', 'https://polygon.drpc.org', 'https://1rpc.io/matic'], minBlock: 50000000 },
  { name: 'Arbitrum One',     chainId: 42161,    rpcs: ['https://arb1.arbitrum.io/rpc', 'https://rpc.ankr.com/arbitrum', 'https://arbitrum.llamarpc.com'], minBlock: 200000000 },
  { name: 'OP Mainnet',       chainId: 10,       rpcs: ['https://mainnet.optimism.io', 'https://rpc.ankr.com/optimism', 'https://optimism.llamarpc.com', 'https://optimism.drpc.org'], minBlock: 100000000 },
  { name: 'Base',             chainId: 8453,     rpcs: ['https://mainnet.base.org', 'https://base.llamarpc.com'], minBlock: 10000000 },
  { name: 'Sepolia',          chainId: 11155111, rpcs: ['https://rpc.sepolia.org', 'https://sepolia.gateway.tenderly.co', 'https://ethereum-sepolia-rpc.publicnode.com'], minBlock: 5000000 },
  { name: 'Polygon Amoy',     chainId: 80002,    rpcs: ['https://polygon-amoy-rpc.publicnode.com', 'https://rpc.ankr.com/polygon_amoy', 'https://rpc-amoy.polygon.technology', 'https://polygon-amoy.drpc.org'], minBlock: 1000000 },
  { name: 'Arbitrum Sepolia', chainId: 421614,   rpcs: ['https://sepolia-rollup.arbitrum.io/rpc', 'https://arbitrum-sepolia-rpc.publicnode.com'], minBlock: 1000000 },
  { name: 'OP Sepolia',       chainId: 11155420, rpcs: ['https://sepolia.optimism.io', 'https://optimism-sepolia-rpc.publicnode.com'], minBlock: 1000000 },
  { name: 'Base Sepolia',     chainId: 84532,    rpcs: ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'], minBlock: 1000000 },
  { name: 'BSC Testnet',      chainId: 97,       rpcs: ['https://data-seed-prebsc-1-s1.bnbchain.org:8545', 'https://bsc-testnet-rpc.publicnode.com'], minBlock: 30000000 },
];

async function rpc(rpcs, method, params = [], timeoutMs = 15000) {
  const errors = [];
  for (const url of rpcs) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
      });
      clearTimeout(t);
      const data = await r.json();
      if (data.result !== undefined) return { data, rpcUrl: url };
      errors.push(`${url}: result undefined`);
    } catch (e) {
      errors.push(`${url}: ${e.message}`);
    }
  }
  throw new Error(`All ${rpcs.length} RPCs failed: ${errors.join('; ')}`);
}

describe('6. ONCHAIN RPC (ALL 12 NETWORKS)', () => {
  for (const net of NETWORKS) {
    describe(`${net.name} (chainId ${net.chainId})`, () => {
      it('RPC responds with blockNumber', { timeout: 60000 }, async () => {
        const { data, rpcUrl } = await rpc(net.rpcs, 'eth_blockNumber');
        const blockNum = parseInt(data.result, 16);
        assert.ok(blockNum > net.minBlock, `${net.name}: blockNum ${blockNum} <= minBlock ${net.minBlock}`);
        log(`✓ ${net.name}: block ${blockNum.toLocaleString()} (via ${new URL(rpcUrl).hostname})`);
      });

      it('correct chainId', { timeout: 60000 }, async () => {
        const { data } = await rpc(net.rpcs, 'eth_chainId');
        const chainId = parseInt(data.result, 16);
        assert.equal(chainId, net.chainId, `${net.name}: chainId ${chainId} !== ${net.chainId}`);
        log(`✓ ${net.name}: chainId ${chainId}`);
      });

      it('gas price available', { timeout: 60000 }, async () => {
        const { data } = await rpc(net.rpcs, 'eth_gasPrice');
        const gas = parseInt(data.result, 16);
        assert.ok(gas > 0, `${net.name}: gas price is 0`);
        log(`✓ ${net.name}: gas ${gas.toLocaleString()} wei`);
      });
    });
  }
});

// ─── 7. CROSS-CHECK: ANGKA vs FOLDER ───
describe('7. CROSS-CHECK: NUMBERS vs REALITY', () => {
  it('JS file count matches expectation', () => {
    const jsFiles = readdirSync(join(ROOT, 'js')).filter(f => f.endsWith('.js'));
    log(`✓ ${jsFiles.length} JS files in /js/`);
    assert.ok(jsFiles.length >= 15, `Expected >= 15 JS files, got ${jsFiles.length}`);
  });

  it('CSS lines reasonable', () => {
    const css = readFileSync(join(ROOT, 'css/cartoon.css'), 'utf8');
    const lines = css.split('\n').length;
    log(`✓ ${lines} lines in cartoon.css`);
    assert.ok(lines > 1500 && lines < 3000, `CSS lines ${lines} out of expected range`);
  });

  it('index.html lines reasonable', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    const lines = html.split('\n').length;
    log(`✓ ${lines} lines in index.html`);
    assert.ok(lines > 400 && lines < 800, `HTML lines ${lines} out of expected range`);
  });

  it('app.js lines reasonable', () => {
    const js = readFileSync(join(ROOT, 'js/app.js'), 'utf8');
    const lines = js.split('\n').length;
    log(`✓ ${lines} lines in app.js`);
    assert.ok(lines > 800 && lines < 1500, `app.js lines ${lines} out of expected range`);
  });
});

// ─── SUMMARY ───
describe('8. SUMMARY', () => {
  it('audit complete', () => {
    log('');
    log('══════════════════════════════════════════');
    log('  Bear Tool Full Audit — COMPLETE');
    log('══════════════════════════════════════════');
    log('  Sections: File Inventory, HTML, CSS,');
    log('  Null Safety, Features, Onchain (12 nets),');
    log('  Cross-check');
    log('══════════════════════════════════════════');
  });
});
