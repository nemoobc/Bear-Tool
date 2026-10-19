// Bear Tool — tests/dex-media.test.js
// M8: the token face's gate — the part that decides what can ride on-chain.
// The mime gate and the byte math are pure; the canvas shrink is a browser
// side and is exercised in the CI E2E suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imgMimeOk, uriBytes, IMG_MAX_BYTES } from '../js/dex/media.js';

test('mime gate: raster passes, svg and non-images are refused', () => {
  assert.equal(imgMimeOk('image/png'), true);
  assert.equal(imgMimeOk('image/jpeg'), true);
  assert.equal(imgMimeOk('image/webp'), true);
  assert.equal(imgMimeOk('image/gif'), true);
  assert.equal(imgMimeOk('image/svg+xml'), false, 'svg is a script wearing a picture');
  assert.equal(imgMimeOk('text/html'), false);
  assert.equal(imgMimeOk('heic'), false);
  assert.equal(imgMimeOk(''), false);
  assert.equal(imgMimeOk(null), false);
});

test('uriBytes: the math the gas bill actually sees', () => {
  const b64 = Buffer.from('bear').toString('base64'); // 4 bytes → 'YmVhcg==' (8 chars)
  const uri = `data:image/png;base64,${b64}`;
  assert.equal(uriBytes(uri), 4);
  assert.equal(uriBytes('data:image/png;base64,'), 0, 'an empty payload costs nothing');
  assert.equal(uriBytes('just text'), 0);
  assert.equal(uriBytes('data:image/png,raw%20payload'), 0, 'non-base64 payloads are not calculable — refuse, never guess');
  assert.equal(IMG_MAX_BYTES, 96 * 1024, 'the cap is THE cap — no silent raise');
});
