// Bear Tool — tests/e2e/22-discord.spec.js
//
// End-to-end for the Discord view WITHOUT a real account (user request:
// "test fitur discord end to end"). Every discord.com/api/v10 call is
// intercepted at the route layer, so what is proven is the app side:
// connect → servers → in-app Chat (read + send, escaped) → join via
// invite link → leave. The old "Open" handed the user to the INSTALLED
// Discord app via an external link; this suite pins that it cannot.
import { test, expect } from '@playwright/test';
import { gotoApp, skipIntro, createWallet } from './helpers.js';

const API = 'https://discord.com/api/v10';

function json(body, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

// One shared mock server. State lives in the closure so join/leave change
// what the NEXT render is told — a static fixture would pass while the
// refresh path was broken.
function mockDiscord(page) {
  const state = {
    guilds: [
      { id: 'G1', name: 'Bear HQ', owner: true, icon: null },
      { id: 'G2', name: 'Lurkers', owner: false, icon: null },
    ],
    sent: [],
  };
  page.route('https://discord.com/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const path = url.pathname.replace('/api/v10', '');

    if (path === '/users/@me' && method === 'GET') {
      return route.fulfill(json({ id: 'U1', username: 'beartester', global_name: 'Bear Tester', avatar: null }));
    }
    if (path === '/users/@me/guilds' && method === 'GET') {
      return route.fulfill(json(state.guilds));
    }
    if (path === '/guilds/G1/channels' && method === 'GET') {
      return route.fulfill(json([{ id: 'C1', name: 'general', type: 0 }]));
    }
    if (path === '/channels/C1/messages' && method === 'GET') {
      return route.fulfill(json([
        { id: 'M2', content: '<b>markup stays text</b>', author: { id: 'U9', username: 'pal' }, timestamp: '2026-10-07T02:00:00Z' },
        { id: 'M1', content: 'Hello from Bear', author: { id: 'U9', username: 'pal' }, timestamp: '2026-10-07T01:00:00Z' },
        ...state.sent.map((m, i) => ({ id: `MS${i}`, content: m, author: { id: 'U1', username: 'beartester' }, timestamp: '2026-10-07T03:00:00Z' })),
      ]));
    }
    if (path === '/channels/C1/messages' && method === 'POST') {
      const body = req.postDataJSON();
      state.sent.push(body.content);
      return route.fulfill(json({ id: 'MNEW', content: body.content }));
    }
    if (path === '/invites/xyz' && method === 'POST') {
      state.guilds.push({ id: 'G3', name: 'Joined Server', owner: false, icon: null });
      return route.fulfill(json({ id: 'G3', name: 'Joined Server' }));
    }
    if (path.startsWith('/users/@me/guilds/') && method === 'DELETE') {
      const id = path.split('/').pop();
      state.guilds = state.guilds.filter((g) => g.id !== id);
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fulfill(json({ message: `unmocked ${method} ${path}` }, 404));
  });
  return state;
}

test.describe('Discord view — in-app, no trip to the installed app', () => {
  test.beforeEach(async ({ page }) => {
    // Onboarding is the slow part on this device; the hook needs its own
    // budget (a body-level setTimeout never reaches beforeEach).
    test.setTimeout(120_000);
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
  });

  test('connect → chat reads & sends → join via invite → leave, all inside Bear Tool', async ({ page }) => {
    test.setTimeout(120_000);
    await mockDiscord(page);

    await page.locator('.nav-item[data-view="discord"]').click();
    await page.waitForSelector('#discordRoot', { timeout: 15_000 });
    // No manual Client ID: the shipped default fills the field.
    await expect(page.locator('#discordClientId')).toHaveValue('1557488535903404154');

    // Token connect (validates against the mocked /users/@me). The paste is
    // 70 chars: tokenLooksWrong rejects anything under 50 (URL fragments,
    // labels) before it ever reaches the API.
    await page.fill('#discordToken', 't'.repeat(70));
    await page.locator('#btnDiscordConnect').click();
    await expect(page.locator('text=Bear Tester')).toBeVisible({ timeout: 15_000 });

    // The installed app must have no handle: no external guild links at all.
    await expect(page.locator('a[href*="discord.com/channels"]')).toHaveCount(0);

    // Chat: opens channels, auto-picks the first, READS the pane.
    await page.locator('[data-guild-chat="G1"]').click();
    await expect(page.locator('.discord-msg-body', { hasText: 'Hello from Bear' })).toBeVisible({ timeout: 15_000 });
    // Escaping is proven by markup arriving as text, not as a tag.
    await expect(page.locator('.discord-msg-body', { hasText: '<b>markup stays text</b>' })).toBeVisible();
    await expect(page.locator('.discord-msg img[onerror]')).toHaveCount(0);

    // Send through the same pane.
    await page.fill('#discordMsg', 'waved from Bear Tool');
    await page.locator('[data-chan-send="G1"]').click();
    await expect(page.locator('text=Message sent')).toBeVisible({ timeout: 10_000 });

    // Join via an invite link — the in-app route, no discord.gg hand-off.
    await page.fill('#discordInvite', 'discord.gg/xyz');
    await page.locator('#btnDiscordJoin').click();
    // EXACT match: `text=Joined Server` (substring) also matched the success
    // toast "Joined Joined Server" the instant it rendered — strict-mode
    // violation on runs 38074850202 ×2. The guild row is matched exactly.
    await expect(page.getByText('Joined Server', { exact: true })).toBeVisible({ timeout: 10_000 });

    // Leave: confirm dialog → the row is gone from the REFRESHED list.
    await page.locator('[data-guild-leave="G2"]').click();
    await expect(page.locator('#btnDiscordLeaveConfirm')).toBeVisible({ timeout: 10_000 });
    await page.locator('#btnDiscordLeaveConfirm').click();
    await expect(page.locator('.discord-guild[data-guild="G2"]')).toHaveCount(0, { timeout: 15_000 });
  });
});
