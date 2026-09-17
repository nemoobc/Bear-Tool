const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:8080');
  
  // Check if intro exists
  const intro = await page.$('#intro');
  console.log('Intro exists:', !!intro);
  
  // Check if modal exists
  const modal = await page.$('#modalOverlay');
  console.log('Modal exists:', !!modal);
  
  // Check if modal has 'open' class
  const isOpen = await page.$eval('#modalOverlay', el => el.classList.contains('open')).catch(() => false);
  console.log('Modal open:', isOpen);
  
  // Check intro display
  const introStyle = await page.$eval('#intro', el => el.style.display).catch(() => 'N/A');
  console.log('Intro display:', introStyle);
  
  // Check console errors
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  
  // Try skipIntro
  await page.evaluate(() => {
    const intro = document.getElementById('intro');
    if (intro) { intro.style.display = 'none'; intro.remove(); }
    const overlay = document.getElementById('modalOverlay');
    if (overlay) overlay.classList.remove('open');
  });
  await page.waitForTimeout(500);
  
  // Check views
  const viewCount = await page.$$eval('section.view', els => els.length);
  console.log('Views count:', viewCount);
  
  // Check nav items
  const navCount = await page.$$eval('.nav-item', els => els.length);
  console.log('Nav items:', navCount);
  
  // Check JS errors
  const jsErrors = await page.evaluate(() => window.__errors || []);
  
  await browser.close();
  console.log('Done');
})();
