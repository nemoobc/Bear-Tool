// Bear Tool — js/dex/media.js
// M8: the token's FACE, chosen by the user's own file — never a URL.
//
// Why not a URL input: the token's image is stored ON-CHAIN in its Meta
// struct. A URL disappears when the server does; a data URI cannot. (The
// old field's biggest honest failure mode is also the smallest: someone
// pastes a preview URL of a preview URL.) So the wizard takes FILE input
// only, here:
//   1. mime gate — real raster images only; svg is refused (it is a
//      script, not a picture),
//   2. one downscale to ≤512px on the longest edge, aspect kept,
//   3. quality stepped down until the URI fits the cap in this file —
//      the cap is a GAS contract with the factory: a bigger image costs
//      the launcher real money for every byte,
//   4. the caller stores the result and previews it.
// The browser half is wrapped so every testable decision (mime, cap,
// byte-math) is a pure function tested without a canvas.

// The on-chain cap the wizard enforces. 96 KiB of image is a lot of
// pixels for a token face and a small receipt.
export const IMG_MAX_BYTES = 96 * 1024;
export const IMG_MAX_DIM = 512;

/** The mime gate: real raster formats pass; svg and everything weird must not. */
export function imgMimeOk(type) {
  const t = String(type || '').toLowerCase();
  if (!t.startsWith('image/')) return false;
  if (t === 'image/svg+xml') return false; // never: scriptable
  return true;
}

/** Bytes a data URI will cost on-chain: header + fully-decoded base64.
 *  Non-base64 payloads are counted 0 — the wizard only ships base64, so a
 *  non-base64 input is a caller bug, not a number we should guess. */
export function uriBytes(uri) {
  const u = String(uri || '');
  const i = u.indexOf(',');
  if (!u.startsWith('data:') || i < 0) return 0;
  if (!u.slice(0, i).includes(';base64')) return 0;
  const payload = u.slice(i + 1);
  return Math.floor((payload.length * 3) / 4) - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
}

/** Browser: File → token face. Throws { reason: 'mime' | 'big' | 'broken' } on
 *  refusal. Resolves { uri, bytes, mime }. */
export async function fileToTokenImage(file, doc = globalThis.document) {
  if (!imgMimeOk(file?.type)) {
    const e = new Error('dex/media: mime'); e.reason = 'mime'; throw e;
  }
  const rawUri = await new Promise((res, rej) => {
    const fr = new doc.defaultView.FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => rej({ reason: 'read' });
    fr.readAsDataURL(file);
  });

  // The Image needs the document/canvas; everything numeric below it can be
  // unit-tested by hand, so the pixel math stays small and local.
  const img = await new Promise((res, rej) => {
    const el = doc.createElement('img');
    el.onload = () => res(el);
    el.onerror = () => rej({ reason: 'broken' });
    el.src = rawUri;
  });

  const maxDim = Math.max(16, IMG_MAX_DIM);
  const ratio = Math.min(1, maxDim / Math.max(img.naturalWidth || maxDim, img.naturalHeight || maxDim));
  const w = Math.max(1, Math.round((img.naturalWidth || maxDim) * ratio));
  const h = Math.max(1, Math.round((img.naturalHeight || maxDim) * ratio));
  const canvas = doc.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);

  const mimeOut = file.type === 'image/webp' ? 'image/webp' : 'image/png';
  let quality = 0.92;
  let uri = canvas.toDataURL(mimeOut, quality);
  while (uriBytes(uri) > IMG_MAX_BYTES) {
    quality -= 0.08;
    if (quality < 0.3) break;
    uri = canvas.toDataURL('image/webp', quality); // webp wins bytes at quality steps
  }
  if (uriBytes(uri) > IMG_MAX_BYTES) {
    const e = new Error('dex/media: big at min quality'); e.reason = 'big'; throw e;
  }
  return { uri, bytes: uriBytes(uri), mime: mimeOut, width: w, height: h };
}
