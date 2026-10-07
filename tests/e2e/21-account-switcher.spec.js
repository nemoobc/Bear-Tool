// 21 — Account switcher: the brand mark, and the promise that choosing an
// account does not change which account is active until the password proves it.
//
// The switcher used to call setActiveAccount(i) and then ask for the password.
// setActiveAccount writes localStorage immediately, so cancelling that prompt or
// mistyping it left the stored active index on an account the topbar was still
// not showing — and the next unlock, after a lock or a reload, signed with that
// other account. In a wallet the damage is not a stale label: the address on
// screen and the address that signs are different, and nothing says so.
//
// The brand mark is checked here rather than only in markup because a markup
// assertion cannot prove the file loaded. An <img> with alt="" that 404s still
// satisfies "the pill points at the asset".
import { test, expect } from '@playwright/test';
import {
  gotoApp, skipIntro, createWallet, expectUnlocked, appClick,
  collectErrors, assertNoErrors,
} from './helpers.js';

// Read the active-account index out of the page rather than from the module, so
// the assertion is about the state the app will use, not about a value imported
// into the test process.
const activeIndex = (page) => page.evaluate(async () => {
  const w = await import('/js/wallet.js');
  return w.getActiveAccountIndex();
});

const topbarLabel = (page) => page.locator('#accountShort').textContent();

async function addSecondAccount(page, password = 'password123') {
  await appClick(page, '#accountPill');
  await page.waitForSelector('#addAccBtn', { timeout: 10_000 });
  await appClick(page, '#addAccBtn');
  await page.waitForSelector('#pwInput', { timeout: 10_000 });
  await page.fill('#pwInput', password);
  await appClick(page, '#pwOk');
  await page.waitForSelector('#addAccBtn', { timeout: 15_000 });
  await expect(page.locator('[data-acc]')).toHaveCount(2);
  // Deriving re-opens the switcher, so it is left open. closeModal() hides the
  // overlay but leaves the markup behind, and a later click on the pill then
  // lands on the overlay and closes the switcher instead of opening it — the
  // rows sit in the DOM, hidden, and waitForSelector times out on a row that is
  // right there. Every test starts from a closed switcher.
  await page.keyboard.press('Escape');
  await expect(page.locator('#modalOverlay')).toBeHidden();
}

test.describe('Account switcher', () => {
  test('the pill and every account row load the brand asset, not an emoji', async ({ page }) => {
    const errors = collectErrors(page);
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await expectUnlocked(page);
    await addSecondAccount(page);

    // Reopen before measuring. A closed overlay reports every box as 0x0, and an
    // unsized image inside a hidden modal looks exactly like one that has no size
    // at all — the assertion below would fail on a mark that is perfectly fine.
    await appClick(page, '#accountPill');
    await expect(page.locator('[data-acc]')).toHaveCount(2);
    await expect(page.locator('[data-acc="1"]')).toBeVisible();

    // Identity slots as of 2026-10-06 (user): topbar = the brand FILE, the
    // pill and the account rows = the same inline wallet glyph. The bear
    // images are gone, so what gets measured is: the topbar image still
    // loads, the three glyph boxes have deliberate sizes (a box with no
    // pixels is indistinguishable from an unsized one in a hidden modal —
    // hence reopening before measuring), and no bear image hides anywhere
    // in the header.
    const marks = await page.evaluate(() => {
      const readImg = (el) => {
        const r = el.getBoundingClientRect();
        return {
          src: el.getAttribute('src'),
          complete: el.complete,
          natural: el.naturalWidth,
          w: Math.round(r.width),
          h: Math.round(r.height),
          display: getComputedStyle(el).display,
        };
      };
      const readBox = (el) => {
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), display: getComputedStyle(el).display };
      };
      return {
        topbar: readImg(document.querySelector('.topbar-logo img')),
        pill: readBox(document.querySelector('.pill-wallet .wallet-glyph')),
        bearImgsInHeader: document.querySelectorAll('.topbar-right img').length,
        rows: [...document.querySelectorAll('.asset-wallet')].map(readBox),
        pillLabelCentres: (() => {
          const p = document.getElementById('accountPill');
          // The lockup box is the mark the label centres against.
          const i = p.querySelector('.pill-wallet').getBoundingClientRect();
          const l = p.querySelector('.label').getBoundingClientRect();
          return Math.abs((i.top + i.height / 2) - (l.top + l.height / 2));
        })(),
      };
    });

    expect(marks.topbar.src, 'the topbar is the one place the brand file lives').toContain('bear.svg');
    expect(marks.bearImgsInHeader, 'no bear image may survive beside the wallet glyph').toBe(0);
    expect(marks.topbar.complete, 'the brand image did not load').toBe(true);
    expect(marks.topbar.natural, 'the brand image has no pixels').toBeGreaterThan(0);
    expect(marks.topbar.w, 'no explicit width').toBeGreaterThan(0);
    expect(marks.topbar.h, 'no explicit height').toBeGreaterThan(0);
    expect(marks.topbar.display, 'inline images leave a baseline gap').toBe('block');
    for (const [where, m] of [['pill glyph', marks.pill], ...marks.rows.map((m, i) => [`row ${i} glyph`, m])]) {
      expect(m.w, `${where}: no explicit size`).toBeGreaterThan(0);
      expect(m.h, `${where}: no explicit size`).toBeGreaterThan(0);
      expect(m.display, `${where}: an inline mark leaves a baseline gap`).toBe('block');
    }
    // A text glyph sits on the baseline, so its centre drifts from the label's.
    // A whole pixel of slack is already visible in a pill this small.
    expect(marks.pillLabelCentres, 'the brand mark is not vertically centred on its label')
      .toBeLessThanOrEqual(1);
    expect(marks.rows, 'each account row must show the mark').toHaveLength(2);
    await assertNoErrors(errors);
  });

  test('cancelling the switch prompt leaves the active account alone', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await expectUnlocked(page);
    await addSecondAccount(page);

    const before = await activeIndex(page);
    const labelBefore = await topbarLabel(page);
    expect(before, 'the first account must be active before the test switches').toBe(0);

    await appClick(page, '#accountPill');
    await page.waitForSelector('[data-acc="1"]', { timeout: 10_000 });
    await appClick(page, '[data-acc="1"]');
    await page.waitForSelector('#pwInput', { timeout: 10_000 });
    await appClick(page, '#pwCancel');
    await page.waitForSelector('#pwInput', { state: 'hidden', timeout: 10_000 });

    expect(await activeIndex(page),
      'cancelling the password prompt moved the active account — the next unlock would use an account the topbar never showed')
      .toBe(before);
    expect(await topbarLabel(page), 'the topbar must still show the account the user is on').toBe(labelBefore);
  });

  test('a wrong password leaves the active account alone', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await expectUnlocked(page);
    await addSecondAccount(page);

    const before = await activeIndex(page);
    const labelBefore = await topbarLabel(page);

    await appClick(page, '#accountPill');
    await page.waitForSelector('[data-acc="1"]', { timeout: 10_000 });
    await appClick(page, '[data-acc="1"]');
    await page.waitForSelector('#pwInput', { timeout: 10_000 });
    await page.fill('#pwInput', 'definitely-not-the-password');
    await appClick(page, '#pwOk');
    // Assert that an ERROR was reported, not what it says. The wording belongs to
    // the translator in errors.js — "Wrong password" is rewritten to "That
    // password did not unlock this wallet…", and pinning either string here would
    // break on a copy change that improves the message. `.last()` because toasts
    // stack: the ones from wallet creation and account derivation are still in
    // the DOM, and a bare .toast matches several and dies on strict mode before
    // it ever asks whether the password was rejected.
    await expect(page.locator('.toast.error').last())
      .toBeVisible({ timeout: 15_000 });

    expect(await activeIndex(page),
      'a wrong password moved the active account — the rejected attempt still changed which key the wallet would use')
      .toBe(before);
    expect(await topbarLabel(page), 'the topbar must not claim a switch that did not happen').toBe(labelBefore);
  });

  test('the correct password switches, and the topbar follows', async ({ page }) => {
    const errors = collectErrors(page);
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await expectUnlocked(page);
    await addSecondAccount(page);

    const labelBefore = await topbarLabel(page);
    // The pill labels the account by NAME, not by address — the bear mark sits
    // beside the name. Read the expected name from the wallet rather than
    // hardcoding it: deriveNextAccount auto-names the second account, and the
    // first one is called "Test Wallet", so the generated name is not obvious.
    const secondName = await page.evaluate(async () => {
      const w = await import('/js/wallet.js');
      return w.getAccounts()[1].name;
    });

    await appClick(page, '#accountPill');
    await page.waitForSelector('[data-acc="1"]', { timeout: 10_000 });
    await appClick(page, '[data-acc="1"]');
    await page.waitForSelector('#pwInput', { timeout: 10_000 });
    await page.fill('#pwInput', 'password123');
    await appClick(page, '#pwOk');
    await page.waitForSelector('#pwInput', { state: 'hidden', timeout: 15_000 });

    // The prompt closing is NOT the switch finishing. promptPassword resolves as
    // soon as the button is pressed, while the keystore decryption that follows is
    // deliberately slow, so the account index is still the old one for a moment
    // after the modal is gone. Reading it immediately found 0, with no toast at all
    // — neither the success nor the failure — which is what a still-running handler
    // looks like. Poll instead of sampling once.
    await expect.poll(() => activeIndex(page), { timeout: 30_000, message: 'the right password must switch the active account' })
      .toBe(1);
    await expect(page.locator('.toast', { hasText: /switched account/i }).last())
      .toBeVisible({ timeout: 15_000 });
    const labelAfter = await topbarLabel(page);
    expect(labelAfter, 'the topbar must follow the switch').not.toBe(labelBefore);
    expect(labelAfter.trim(), 'the pill must name the account that is now active')
      .toBe(secondName);

    // Reopening must mark the new account active, not the first one.
    await appClick(page, '#accountPill');
    await page.waitForSelector('[data-acc]', { timeout: 10_000 });
    await expect(page.locator('[data-acc="1"].active')).toHaveCount(1);
    await expect(page.locator('[data-acc="0"].active')).toHaveCount(0);
    await assertNoErrors(errors);
  });
});
