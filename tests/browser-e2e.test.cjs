const { chromium } = require('/root/Bear-Tool/node_modules/playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  page.on('requestfailed', (r) => errors.push('REQFAIL: ' + (r.failure()?.errorText || '') + ' ' + r.url()));

  const resp = await page.goto('http://localhost/', { waitUntil: 'networkidle', timeout: 40000 });
  await page.waitForTimeout(3000);

  const out = { http: resp.status(), errors };

  out.globals = await page.evaluate(() => ({
    appLoaded: typeof window.BearTool !== 'undefined',
    appInit: typeof window.initApp,
    dashboard: typeof window.initDashboard,
    coinPrice: typeof window.renderCoinPricePanel,
    coinsFound: typeof window.renderCoinChips,
    netShowcase: typeof window.renderNetworkShowcase,
    spark: typeof window.renderHeroSpark,
    scripts: [...document.scripts].map((s) => s.src.replace(location.origin, '')),
  }));

  out.coin = await page.evaluate(() => {
    const p = document.getElementById('coinPricePanel');
    return {
      exists: !!p,
      html: p ? p.innerHTML.slice(0, 200) : null,
      chips: p ? p.querySelectorAll('[data-sym]').length : -1,
      syms: p ? [...p.querySelectorAll('[data-sym]')].map((c) => c.dataset.sym) : [],
    };
  });

  out.spark = await page.evaluate(() => {
    const c = document.getElementById('heroSpark');
    if (!c) return { exists: false };
    let drawn = false;
    try {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      drawn = d.some((v) => v !== 0);
    } catch (e) {}
    return { exists: true, tag: c.tagName, w: c.width, h: c.height, drawn };
  });

  out.net = await page.evaluate(() => {
    const mm = document.getElementById('netListMainnet');
    const tt = document.getElementById('netListTestnet');
    const rows = (el) => (el ? [...el.querySelectorAll('[data-net]')].map((x) => x.dataset.net) : []);
    const mn = rows(mm);
    const tn = rows(tt);
    return { mainnet: mn, testnet: tn, total: mn.length + tn.length };
  });

  out.rows = await page.evaluate(() => {
    const data = [];
    const mm = document.getElementById('netListMainnet');
    const tt = document.getElementById('netListTestnet');
    for (const net of [mm, tt]) {
      if (!net) continue;
      for (const row of net.querySelectorAll('[data-net]')) {
        data.push({ net: row.dataset.net, name: row.textContent.trim().slice(0, 30) });
      }
    }
    return data;
  });

  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch((e) => { console.error('CRASH:', e.message); process.exit(1); });
