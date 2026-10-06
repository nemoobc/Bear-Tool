// 14 — Tools is ONE view.
//
// The EIP-7702 suite and the deploy wizard used to be two separate nav entries
// pointing at two separate views, and the copy of the EIP-7702 forms inside the
// Tools view was never bound to any JS: btnBatchAdd2 / btnRescue2 / btnClaim2
// had zero references in js/, so those buttons silently did nothing. They are
// now merged into a single Tools view. These tests stop that regressing.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { gotoApp, skipIntro, createWallet, appClick, staticHtml } from './helpers.js';

// M2: view markup lives in src/views/*.jsx — staticHtml = shell + views in
// App.jsx render order (the slice between view-deploy and view-activity below
// depends on that order). Reading index.html alone returned indexOf -1.
const html = staticHtml;
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
    // The locked address is derived from the target key / the unlocked wallet,
    // so the input it replaced must not come back either.
    expect(html, 'the Locked wallet address field is gone').not.toMatch(/id="rescueTarget"/);
    expect(html, 'the target key field stays').toMatch(/id="rescueTargetKey"/);
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
    // EIP-7702 side — the four flows the reference tool ships, plus the
    // deployed-registry card. helperStatusList (the removed Helper Contracts
    // card, pinned as gone by tests/deploy-contracts.test.js:313) and the
    // manual delegate form (owner confirmation 2026-10-05) are asserted gone
    // instead: the old list demanded ids that no longer exist anywhere.
    for (const id of ['batchList', 'btnBatchAdd', 'btnBatchExecute',
      'btnRescue', 'claimContract', 'btnClaim',
      'revokeTarget', 'btnCheckDelegation', 'btnRevokeDelegation',
      'deployedRegistryList']) {
      expect(view, `${id} must live in Tools`).toMatch(new RegExp(`id="${id}"`));
    }
    for (const gone of ['helperStatusList', 'delegateAddr', 'delegateChainId',
      'delegateAnyChain', 'btnDelegate', 'btnRevoke']) {
      expect(view, `${gone} was removed with the Smart EOA / Helper Contracts cards`)
        .not.toMatch(new RegExp(`id="${gone}"`));
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
    // batch / rescue / claim / revoke + the deployed registry — the flows that
    // replaced the removed manual delegate form (#delegateAddr / #btnDelegate).
    for (const id of ['deployStandard', 'btnDeploy', 'batchList', 'btnBatchAdd',
      'btnRescue', 'btnClaim', 'btnCheckDelegation', 'btnRevokeDelegation',
      'deployedRegistryList']) {
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
    // live ones. Assert they respond rather than sit there inert. A button that
    // is NOT bound times out here, because an address the app refuses must
    // raise its error toast synchronously — before any RPC round-trip.
    await page.fill('#revokeTarget', '0x123');
    await expect(page.locator('#revokeTarget')).toHaveValue('0x123');
    await appClick(page, '#btnCheckDelegation');
    await expect(page.locator('#toast-wrap')).toContainText(/Invalid address/i, { timeout: 5000 });
    // Same guard on the Revoke button itself (checkDelegation and
    // revokeDelegation are separate bindings). Clear the first toast so the
    // second assertion proves THIS click fired, not the previous one.
    await page.evaluate(() => { document.querySelector('#toast-wrap').innerHTML = ''; });
    await appClick(page, '#btnRevokeDelegation');
    await expect(page.locator('#toast-wrap')).toContainText(/Invalid address/i, { timeout: 5000 });
    // Batch: one click, one row. `.batch-item`, not `#batchList > *` — an EMPTY
    // queue also renders exactly one child (the "No calls yet." placeholder),
    // so `> *` passed whether or not the button did anything.
    await appClick(page, '#btnBatchAdd');
    await expect(page.locator('#batchList .batch-item')).toHaveCount(1, { timeout: 5000 });
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
