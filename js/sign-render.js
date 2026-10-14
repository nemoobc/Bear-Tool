// ═══════════════════════════════════════════════════════════════
// Bear Tool — js/sign-render.js
// How a signing payload is SHOWN.
//
// One implementation, used by every approval sheet. Two copies of this drifted
// in the past and the drift was a security bug: one sheet rendered a hex
// payload as a decimal byte array ("104,101,108,108,111"), so the user approved
// a signature over text they could not read. A second copy is how that happens
// again, so this file exists instead of the function being written twice.
//
// Three rules, all about the same thing: the thing the user approves must be
// the thing the user is shown.
//   1. Hex that decodes as text is shown AS TEXT, not as bytes.
//   2. Binary is labelled binary. Numbers are not a substitute for meaning.
//   3. Invisible and bidirectional characters are stripped. U+202E renders text
//      in a different order from its bytes, so a message can display as one
//      thing and be signed as another.
// ═══════════════════════════════════════════════════════════════

// A sign payload is a hex string per spec. Rendered as a decimal byte array it
// reads as "104,101,108,108,111" — a user asked to approve that has no idea
// they are approving "hello".
export function renderSignMessage(message) {
  const raw = typeof message === 'string' ? message : String(message ?? '');
  if (!raw) return '(binary)';
  if (!/^0x[0-9a-fA-F]*$/.test(raw) || raw.length < 4) return stripInvisible(raw).slice(0, 160);
  const bytes = hexBytes(raw);
  if (!bytes) return `(binary, ${Math.max(0, (raw.length - 2) / 2)} bytes)`;
  const text = decodeUtf8(bytes);
  // Hex that decodes to text is shown AS TEXT. Anything else is binary and is
  // labelled binary — numbers are not a substitute for meaning.
  //
  // Control characters are stripped rather than treated as binary: they are
  // invisible in the dialog anyway, so showing "Hello" with a NUL removed says
  // exactly what is being signed. A U+FFFD is the opposite — it means the bytes
  // were NOT text, and rendering the string around it would be showing something
  // the user never receives.
  const cleaned = stripInvisible(text).replace(/[\u0000-\u0008\u000e-\u001f\u007f]/g, '');
  if (cleaned && !cleaned.includes('\ufffd')) return cleaned.slice(0, 160);
  return `(binary, ${bytes.length} bytes)`;
}

// Hex → bytes, here rather than via the ethers global. This is the code the
// user READS before approving a signature; it must not depend on whatever a
// library happens to have attached to globalThis in the page it is rendered in.
function hexBytes(hex) {
  const body = hex.slice(2);
  if (body.length % 2 !== 0) return null;
  const out = new Uint8Array(body.length >> 1);
  for (let i = 0; i < out.length; i++) {
    const pair = body.slice(i * 2, i * 2 + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(pair)) return null;
    out[i] = parseInt(pair, 16);
  }
  return out;
}

// TextDecoder where available; a byte-per-char fallback where it is not, so the
// caller gets a decision either way rather than an exception on a signing path.
function decodeUtf8(bytes) {
  try {
    if (typeof TextDecoder === 'function') return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch { /* fall through */ }
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

export function stripInvisible(s) {
  return String(s)
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/[\u00ad]/g, '');
}

export function safeJson(v) {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s ? s.slice(0, 160) + (s.length > 160 ? '…' : '') : '(empty)';
  } catch {
    // A cyclic object from the page must not take the dialog down with it.
    return '(could not be displayed)';
  }
}
