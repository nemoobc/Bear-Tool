// Paste → auto-detect in the Tools cards (Rescue token / Claim token).
// Live reports (2026-10-03):
//   "fitur tools pas aku tempel contract address ngga auto detect token + nft"
//   "harusnya yang kedetect pk (drainner) tokennya bukan wallet sponsor"
//   "ada beberapa list wallet dan ketika dipilih warna masih putih"
// The probe must identify ERC-20 / ERC-721 / ERC-1155, report the DRAINER's
// balance (target-key wallet — deriveTargetAddress), never the sponsor's, and
// the sponsor picker's native option popup must be readable in dark theme.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(path.join(root, p), 'utf8');
const view = src('src/views/deploy.jsx');
const tools = src('js/eip7702-tools.js');
const css = src('css/cartoon.css');

test('T1: both Tools cards carry a detect output box', () => {
  assert.match(view, /id="rescueTokenDetect"/, 'Rescue token field has a detect box');
  assert.match(view, /id="claimTokenDetect"/, 'Claim token field has a detect box');
  assert.match(view, /id="rescueTokenDetect" role="status" aria-live="polite"/,
    'the box announces results to screen readers');
  assert.match(view, /id="claimTokenDetect" role="status" aria-live="polite"/,
    'claim box announces too');
});

test('T2: the probe is wired to both inputs (input + paste)', () => {
  assert.match(tools, /function wireTokenDetect\(inputSel, outSel/, 'the wiring helper exists');
  const slice = tools.slice(tools.indexOf('function wireTokenDetect'));
  assert.match(slice, /addEventListener\('input', run\)/, 'reacts to typing');
  assert.match(slice, /addEventListener\('paste'/, 'reacts to paste');
  assert.match(tools, /wireTokenDetect\('#rescueTokenAddr', '#rescueTokenDetect', \{ idSel: '#rescueTokenId' \}\)/,
    'Rescue field wired (token-id field feeds the 1155 balance)');
  assert.match(tools, /wireTokenDetect\('#claimToken', '#claimTokenDetect', \{ keySel: '#claimTargetKey' \}\)/,
    'Claim field wired with its OWN drainner key field');
});

test('T3: the balance shown is the DRAINER (target key), never the sponsor', () => {
  const start = tools.indexOf('function wireTokenDetect');
  assert.ok(start >= 0, 'wireTokenDetect exists');
  const slice = tools.slice(start, tools.indexOf('// ── bind all events ──'));
  assert.match(slice, /deriveTargetAddress\(opts\.keySel\)/,
    'holder = deriveTargetAddress (target key → address, else active wallet)');
  assert.match(slice, /const holder = derived\.address/, 'the holder feeds the balanceOf call');
  assert.match(slice, /balanceOf\(address\)'?\]\(holder\)|\['balanceOf\(address\)'\]\(holder\)/,
    'balanceOf is queried FOR the holder');
  assert.ok(!/sponsorAddressOf|sponsorSignerOf/.test(slice),
    'the probe never resolves the sponsor — live report said sponsor was shown');
  // deriveTargetAddress now takes the key field as a parameter (claim has its
  // own drainner input) with the rescue field as the default.
  assert.match(tools, /export function deriveTargetAddress\(keySel = '#rescueTargetKey'\)/,
    'key selector is parameterised, default unchanged');
});

test('T4: the probe distinguishes ERC-20 / ERC-721 / ERC-1155', () => {
  const start = tools.indexOf('function wireTokenDetect');
  const slice = tools.slice(start, tools.indexOf('// ── bind all events ──'));
  assert.match(slice, /ownerOf\(1n\)/, 'ERC-721 marker probe');
  assert.match(slice, /uri\(1n\)/, 'ERC-1155 marker probe');
  assert.match(slice, /ERC-721 NFT/, 'renders an NFT verdict');
  assert.match(slice, /ERC-1155/, 'renders a 1155 verdict');
  assert.match(slice, /ERC-20/, 'renders a token verdict');
  assert.match(slice, /balanceOf\(address,uint256\)/, '1155 balance needs the token id');
  assert.match(slice, /No ERC-20\/NFT metadata/, 'honest miss when nothing identifies');
});

test('T5: delegateAndExecute sends an EXPLICIT type-4 tx (auth list kept)', () => {
  const start = tools.indexOf('async function delegateAndExecute');
  assert.ok(start >= 0, 'delegateAndExecute exists');
  const slice = tools.slice(start, tools.indexOf('async function executeBatch') - 0 > start
    ? tools.indexOf('export async function contractExists') : start + 4000);
  assert.match(slice, /type: 4,\s*\n\s*to: targetAddress/,
    'type: 4 before authorizationList — same rule as eip7702.js and revoke');
  assert.match(slice, /authorizationList: \[authorization\]/, 'one authorization carried');
});

test('T6: sponsor picker options are readable in dark theme (white-on-white fix)', () => {
  assert.match(css, /select\.input, select\.select \{ color-scheme: light; \}/,
    'the widget stays in the light color scheme so Android paints dark text');
  assert.match(css, /select\.input option, select\.select option, \.input option \{\s*\n\s*background: #ffffff;\s*\n\s*color: #2D2A32;/,
    'option popup pinned to white sheet + dark ink (dark theme flips --ink to #e0e0e0)');
});
