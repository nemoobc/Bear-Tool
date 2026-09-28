// 14 — Tools is ONE view.
//
// The EIP-7702 suite and the deploy wizard used to be two separate nav entries
// pointing at two separate views, and the copy of the EIP-7702 forms inside the
// Tools view was never bound to any JS: btnBatchAdd2 / btnRescue2 / btnClaim2
// had zero references in js/, so those buttons silently did nothing. They are
// now merged into a single Tools view. These tests stop that regressing.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { gotoApp, skipIntro, createWallet, appClick } from './helpers.js';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../js/app.js', import.meta.url), 'utf8');

test.describe('Tools merge — static', () => {
  test('there is no separate EIP-7702 view or nav entry', () => {
    expect(html).not.toMatch(/id="view-eip7702"/);
    expect(html).not.toMatch(/data-view="eip7702"/);
  });

  test('the dead duplicated forms are gone', () => {
    // These were the 0-reference copies.
    for (const dead of ['btnBatchAdd2', 'btnBatchExecute2', 'btnRescue2', 'btnClaim2',
      'btnRescueKeyToggle2', 'btnClaimKeyToggle2', 'batchList2']) {
      expect(html, `${dead} must not come back`).not.toMatch(new RegExp(`id="${dead}"`));
    }
  });

  test('the live EIP-7702 forms and the deploy wizard share the Tools view', () => {
    const start = html.indexOf('id="view-deploy"');
    const end = html.indexOf('id="view-activity"');
    expect(start).toBeGreaterThan(-1);
    const view = html.slice(start, end === -1 ? undefined : end);
    // deploy side
    for (const id of ['deployStandard', 'btnDeploy']) {
      expect(view, `${id} must live in Tools`).toMatch(new RegExp(`id="${id}"`));
    }
    // EIP-7702 side
    for (const id of ['helperStatusList', 'delegateAddr', 'btnDelegate', 'btnRevoke',
      'batchList', 'btnBatchAdd', 'rescueTarget', 'btnRescue', 'claimContract', 'btnClaim',
      'revokeTarget', 'btnCheckDelegation', 'deployedRegistryList']) {
      expect(view, `${id} must live in Tools`).toMatch(new RegExp(`id="${id}"`));
    }
    // The OpenSea market actions are contract calls against the wallet, so they
    // belong with the Tools view.
    for (const id of ['openSeaPanel', 'btnCheckWL', 'btnOpenSeaList', 'btnAcceptTopOffer']) {
      expect(view, `${id} must live in Tools`).toMatch(new RegExp(`id="${id}"`));
    }
  });

  test('the OpenSea market actions live in the Tools view', () => {
    const nft = html.slice(html.indexOf('id="view-nft"'), html.indexOf('id="view-dapps"'));
    for (const id of ['openSeaPanel', 'btnCheckWL', 'btnOpenSeaList',
      'btnOpenSeaCancel', 'btnAcceptTopOffer', 'openSeaStatus', 'openSeaApiKey']) {
      expect(nft, `${id} must NOT be in the NFT view`).not.toMatch(new RegExp(`id="${id}"`));
    }
    expect(nft, 'the gallery itself must stay').toMatch(/id="nftList"/);
  });

  test('no id is declared twice anywhere in the document', () => {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    expect(dupes, 'duplicate ids break getElementById and label wiring').toEqual([]);
  });

  test('the nav label is translated, not hardcoded', () => {
    const navItem = html.match(/<div class="nav-item" data-view="deploy"[\s\S]*?<\/div>/);
    expect(navItem, 'the Tools nav item must exist').not.toBeNull();
    expect(navItem[0]).toMatch(/data-i18n="nav\.deploy"/);
  });

    // These used to pin the exact spacing of one line each, so a reformat broke
    // them and nothing else. They now say what they mean: which branch, and what
    // it calls.
    test('refreshView runs the EIP-7702 loader for the Tools view', () => {
      const branch = app.split("view === 'deploy'").pop().split('\n')[0];
      expect(branch, 'a deploy branch must exist in refreshView').toContain('loadEip7702()');
      const hits = app.match(/view === 'deploy'/g) || [];
      expect(hits.length, 'exactly one deploy branch in refreshView').toBe(1);
    });

    test('refreshView binds the OpenSea panel on the Tools view, not the NFT view', () => {
      // This demanded the OPPOSITE — the panel on the NFT view — and has failed
      // since that decision changed. It changed deliberately:
      // opensea-integration.test.js pins "the OpenSea panel is in the Tools view,
      // not the NFT view", and the code does that. Two suites in one repo were
      // asserting opposite requirements; the stale one is this.
      const deploy = app.split("view === 'deploy'").pop().split('\n')[0];
      expect(deploy, 'the OpenSea panel belongs on the Tools view').toContain('bindOpenSeaPanel()');
      const nft = app.split("view === 'nft'").pop().split('\n')[0];
      expect(nft, 'the NFT view must not re-bind the panel that lives in Tools').not.toContain('bindOpenSeaPanel()');
    });
});

test.describe('Tools merge — in the browser', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="deploy"]');
    await page.waitForTimeout(1200);
  });

  test('Tools shows both the wizard and the EIP-7702 panel', async ({ page }) => {
    await expect(page.locator('#view-deploy')).toHaveClass(/active/);
    for (const id of ['deployStandard', 'btnDeploy', 'delegateAddr', 'btnDelegate',
      'btnBatchAdd', 'btnRescue', 'btnClaim', 'btnCheckDelegation']) {
      await expect(page.locator('#' + id), `#${id} must be present in Tools`).toHaveCount(1);
    }
  });

  test('the NFT view shows only the gallery', async ({ page }) => {
    await appClick(page, '.nav-item[data-view="nft"]');
    await page.waitForTimeout(1500);
    await expect(page.locator('#view-nft')).toHaveClass(/active/);
    await expect(page.locator('#nftList')).toHaveCount(1);
    // OpenSea is a Tools concern, not a gallery one.
          // toHaveCount(0) counts the whole document, and the panel lives in the Tools
      // section whether or not you are looking at it — .view is display:none, not
      // absent. So this said 1 and blamed the NFT view for a panel that is not in
      // it. What is actually claimed is that the panel is not VISIBLE here; that it
      // is in the Tools section at all is pinned statically above and by
      // opensea-integration.test.js.    );
      await expect(page.locator('#openSeaPanel')).toBeHidden();
    // The empty state centres on both axes.
    await expect(page.locator('.nft-empty')).toHaveCount(1);
  });

  test('every EIP-7702 control in Tools is actually wired to JS', async ({ page }) => {
    // The whole point of the merge: the forms that used to be dead are now the
    // live ones. Assert they respond rather than sit there inert.
    await page.fill('#delegateAddr', '0x1234567890123456789012345678901234567890');
    await expect(page.locator('#delegateAddr')).toHaveValue('0x1234567890123456789012345678901234567890');
    await page.click('#btnBatchAdd');
    await expect(page.locator('#batchList .batch-row, #batchList li, #batchList > *'))
      .toHaveCount(1, { timeout: 5000 });
  });

  test('the sidebar has exactly one Tools entry and no EIP-7702 entry', async ({ page }) => {
    const views = await page.locator('.sidebar .nav-item').evaluateAll((els) => els.map((e) => e.dataset.view));
    expect(views).toContain('deploy');
    expect(views).not.toContain('eip7702');
    expect(views.filter((v) => v === 'deploy').length, 'exactly one Tools entry').toBe(1);
  });

  test('Approvals is still its own view', async ({ page }) => {
    await appClick(page, '.nav-item[data-view="approval"]');
    await expect(page.locator('#view-approval')).toHaveClass(/active/);
    await expect(page.locator('#view-deploy')).not.toHaveClass(/active/);
  });
});
