// tests/dex-bot-notice.test.js
// Market maker: the bot panel must tell the user no new private keys are
// created or shown — all addresses are derived from the unlocked seed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('token page shows the "no new private keys" notice next to the bot panel', () => {
  const tp = read('../js/dex/token-page.js');
  assert.match(tp, /dex\.bot\.noNewKeys/, 'notice key referenced');
  assert.match(tp, /bot-notice/, 'notice element rendered beside botHtml');
  assert.match(tp, /\$\{botHtml\(\)\}/, 'bot panel mounted on the token page');
});

test('bot no-new-keys i18n keys balanced EN vs ID', () => {
  const i18n = read('../js/i18n.js');
  assert.ok(/'dex\.bot\.noNewKeys': 'All bot addresses/.test(i18n), 'EN notice key');
  assert.ok(/'dex\.bot\.noNewKeys': 'Semua alamat bot/.test(i18n), 'ID notice key');
});
