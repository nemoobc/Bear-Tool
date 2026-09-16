# DESIGN-AUDIT — Bear Tool (Full Cartoon Wallet)

STATUS    : SELESAI (audit + rekomendasi; belum implementasi)
KONTEKS   : Web wallet crypto self-custody, tema FULL CARTOON. User: "animasi muter² cuma buat loading aja, kurang lengkap kurang matang kurang maksimal."
SCOPE     : css/cartoon.css (594 baris), index.html (341 baris), js/theme.js, js/ui.js, js/app.js, assets/bear.svg, assets/logo.svg
TANGGAL   : 2026-09-16

---

## 1. AUDIT TEMA CARTOON

### 1.1 Yang SUDAH BAGUS (pertahankan)
- **Token dasar solid**: honey/orange/sky/berry/grape/mint/cream/ink + shadow 4px + border 3-4px + radius 18-24px = bahasa visual cartoon konsisten.
- **Dotted background** (radial-gradient honey 2px) — playful, tidak mengganggu, pointer-events none.
- **Shadow chunky** `4px 4px 0 ink` di card/button — signature cartoon 2D, bagus.
- **Scrollbar cartoon** (honey thumb + border ink) — detail kecil yang jarang dipikirkan orang.
- **Hover state** button (translateY -2px + shadow naik) — memberi "tombol bisa ditekan".
- **tx-confirm bear-nod** — mascot sudah mulai dipakai di konfirmasi transaksi.

### 1.2 Yang KURANG / JELEK (temuan per komponen)

| Komponen | Temuan | Severity |
|---|---|---|
| **Hardcoded color** | `#FFF3CD` (warn-box), `#FFE3E3` (danger-box), `rgba(78,205,196,0.3)` (focus), `rgba(45,42,50,0.6)` (overlay), `rgba(45,42,50,0.4)` (modal shadow) — melanggar aturan token. Dark mode nanti mustahil tanpa token. | P0 |
| **Border tidak konsisten** | Standar 3-4px, tapi `.asset-row`, `.tx-detail`, `.batch-item` pakai **2px**; `.nav-item` 2px transparent. Mata user melihat "tebalnya beda-beda". | P1 |
| **Font mono** | `.mono` & `.addr` pakai `Courier New` — keluar dari dunia cartoon. Harus font rounded (Fredoka sudah ada; fallback `ui-monospace` tetap jelek). | P1 |
| **Focus state (a11y)** | Input: ring `rgba(sky,0.3)` — kontras ring vs cream ≈ **1.3:1** (gagal WCAG 2.4.11 butuh 3:1). **Button/nav/pill/modal-close TIDAK punya focus-visible sama sekali** — user keyboard buta. | P0 |
| **Disabled** | `.btn:disabled` opacity 0.5 — ok, tapi tidak ada loading-in-button (spinner + disabled). | P0 |
| **Touch target** | `network-pill`/`account-pill` ≈ 36px, `intro-skip` ≈ 34px, `modal-close` ≈ 24px — semua < 44px (WCAG 2.5.5). | P0 |
| **Kontras teks sekunder** | Semua teks `opacity:0.7` (`.small`, `.asset-symbol`, `.usd`, `.tx-detail .k`, `.intro-skip` 0.6) ≈ **1.4:1** — GAGAL. `.balance-hero .sub` opacity 0.8 di sisi orange ≈ 1.2:1 — GAGAL. | P0 |
| **badge-mainnet** | Putih di atas berry `#FF6B6B` ≈ **2.78:1** — GAGAL untuk teks kecil 0.7rem. | P0 |
| **badge-grape** | Putih di atas grape `#9B5DE5` ≈ 4.1:1 — gagal untuk teks kecil (butuh 4.5). | P1 |
| **Empty state** | Ada teks ("No assets found", "No NFTs yet") tapi polos, tanpa mascot/ilustrasi/CTA. "Data tidak ditemukan" = empty state gagal. | P1 |
| **Error state input** | Tidak ada `.input-error` / pesan validasi per field. Error hanya lewat toast. | P1 |
| **Modal a11y** | Tidak ada focus trap, tidak ada Escape, tidak ada `aria-labelledby`, fokus tidak direstore, body scroll tidak dikunci. | P0 |
| **Toast** | Tanpa icon, tanpa tombol close, tanpa mascot; `aria-live="polite"` ada di wrapper (bagus) tapi error seharusnya `assertive`. | P1 |
| **Responsive** | Hanya 1 breakpoint 768px. Sidebar jadi scroll horizontal (ok), tapi tidak ada strategi tablet/desktop lebar, tidak ada container queries. | P2 |
| **Dark mode** | Tidak ada `prefers-color-scheme`. | P2 |
| **Reduced motion** | **TIDAK ADA** `prefers-reduced-motion` di seluruh CSS/JS — animasi wajib jalan untuk semua user. | P0 |
| **i18n** | Ada select Language di Settings tapi string hardcoded semua. (Di luar scope audit visual, dicatat.) | P2 |

---

## 2. AUDIT ANIMASI

### 2.1 Intro "5 detik" — benar 5 detik, tapi MONOTON & ADA BUG

Timeline aktual (theme.js:40 `setTimeout(finish, 5000)` → **tepat 5s**):

| Waktu | Yang terjadi | Verdict |
|---|---|---|
| 0-1s | Logo bounce-in (scale 0→1.15→1, rotate -20°→0) | ✅ bagus |
| 1-3s | **Eye blink — TIDAK PERNAH JALAN (BUG)**. CSS `.intro-logo .eye` = selektor *descendant* (butuh elemen `.eye` DI DALAM `.intro-logo`), tapi theme.js:37 menambah class `eye` ke **elemen yang sama** dengan `.intro-logo`. Selain itu bear.svg tidak punya elemen `.eye` yang bisa di-target CSS. Kode mati. | ❌ BUG |
| 2-3s | Title letter-by-letter (delay 2.0→2.64s, selesai 2.94s) | ✅ |
| 0-5s | Orbit ring spin 1.2s linear infinite | ✅ tapi sendirian |
| 3-5s | **TIDAK ADA APA-APA** — orbit muter sendirian 2 detik penuh. Monoton. | ❌ |
| 5s | `finish()` → `display:none` — **TANPA fade-out**. Layar hilang mendadak. | ❌ |
| — | **Tidak ada progress bar, tidak ada countdown, tidak ada skip yang jelas** (skip kecil, opacity 0.6, touch target 34px). | ❌ |
| — | Intro `role="presentation"` + `aria-label` — kontradiktif; seharusnya `role="img"` atau `aria-hidden` sampai selesai. | P1 |
| — | Klik di mana saja = skip (bagus), tapi tidak ada dukungan keyboard/`prefers-reduced-motion`. | P0 |

**Kesimpulan intro**: "5 detik" benar secara timer, tapi 2 detik terakhir kosong, blink rusak, keluar mendadak. Itu sebabnya terasa "kurang matang".

### 2.2 Spinner "muter²" — DEFINISI ADA, PEMAKAIAN TIDAK KONSISTEN

Definisi di CSS (3 varian):
- `spinner-bear` — gambar bear diputar 360° (CSS:138-142)
- `spinner-dots` — 3 titik bouncing (CSS:144-153)
- `spinner-honey` — ring honey + emoji 🍯 counter-rotate (CSS:155-172) — **TIDAK PERNAH DIPAKAI (kode mati)**

Peta pemakaian aktual di app.js:

| Tempat | Spinner? | Status |
|---|---|---|
| Dashboard asset list (app.js:392) | ✅ spinner-bear | ada |
| Swap quote (app.js:594) | ✅ spinner-dots | ada |
| Bridge route (app.js:659) | ✅ spinner-dots | ada |
| Approval scan (app.js:815) | ✅ spinner-bear | ada |
| **Send** (doSend) | ❌ TIDAK ADA | tombol diam selama tx |
| **Deploy** (doDeploy) | ❌ TIDAK ADA | tombol diam |
| **Delegate/Revoke** (doEip7702) | ❌ TIDAK ADA | tombol diam |
| **Batch execute** | ❌ TIDAK ADA | tombol diam |
| **Rescue / Claim** | ❌ TIDAK ADA | tombol diam |
| **NFT load** (loadNfts) | ❌ TIDAK ADA | area kosong diam |
| **Activity load** | ❌ TIDAK ADA | area kosong diam |
| **Unlock/decrypt wallet** | ❌ TIDAK ADA | tombol diam |
| **Switch network** | ❌ TIDAK ADA | pill diam |
| **Save settings / clear data** | ❌ TIDAK ADA | tombol diam |

**Masalah desain spinner-bear**: memutar gambar wajah bear 360° = bear jadi terbalik/nyungsep. Secara cartoon itu aneh — wajah tidak boleh diputar. Yang benar: bear diam (idle bounce) + ring honey yang muter di sekelilingnya.

**Kesimpulan spinner**: 3 varian didefinisikan, 1 mati, 2 dipakai di 4 tempat saja. Semua aksi transaksi (send/deploy/delegate/dll) tidak punya feedback loading sama sekali — user klik, tombol diam, lalu toast muncul. Itu yang bikin "muter² cuma buat loading aja" — karena memang cuma 4 tempat.

---

## 3. REKOMENDASI (detail & actionable)

### 3a. INTRO 5 DETIK YANG KAYA

Spesifikasi per fase (total 5.0s, timer JS tetap `setTimeout(finish, 5000)`):

| Fase | Waktu | Animasi | CSS |
|---|---|---|---|
| **F1 — Masuk** | 0-1s | Logo bounce-in (scale 0→1.15→1, rotate -20°→5°→0, opacity 0→1, spring `cubic-bezier(.34,1.56,.64,1)`). Orbit ring fade-in + scale 0.8→1. 4 dot pop-in staggered (0.1s, scale 0→1 spring). | `intro-bounce` 1s (sudah ada, pertahankan) + `intro-orbit-in` 0.6s + `intro-dot-pop` 0.4s delay 0.3/0.4/0.5/0.6s |
| **F2 — Hidup** | 1-2s | Logo idle float (translateY ±6px, 1.6s ease-in-out infinite). **Blink diperbaiki**: 2 kedip (scaleY 1→0.1→1, 0.15s, di 1.0s & 1.5s). Orbit ring akselerasi ke full spin. | `.intro-logo { animation: intro-bounce 1s both, intro-float 1.6s ease-in-out 1s infinite; }` Blink: pakai wrapper `<span class="intro-blink">` ATAU tambah class `.eye` di SVG bear (bukan selektor descendant yang salah). |
| **F3 — Judul** | 2-3s | Title letter-by-letter (translateY -20px→0 + overshoot, stagger 0.08s — sudah ada, pertahankan). Honey pot badge di logo pulse 1x (scale 1→1.15→1). | `intro-letter` (ada) + `intro-badge-pulse` 0.5s delay 2.2s |
| **F4 — Klimaks** | 3-4s | Logo happy wiggle (rotate ±4°, 0.4s ×2). 2 sparkle/star burst muncul di sekitar logo (scale 0→1→0, opacity). Progress bar mencapai ~60-80%. | `intro-wiggle` 0.8s delay 3s + `intro-sparkle` 0.6s delay 3.2s/3.5s |
| **F5 — Keluar** | 4-5s | Progress bar selesai 100%. **Fade-out seluruh intro** (opacity 1→0, 0.4s ease) — baru `display:none` di 5.0s. | `.intro-fade { opacity:0; transition: opacity .4s ease; }` — JS tambah class di 4.6s, `finish()` di 5.0s. |

**Progress bar** (komponen baru, wajib):
```css
.intro-progress {
  position: fixed; bottom: 0; left: 0; right: 0; height: 8px;
  background: var(--white); border-top: var(--border);
  z-index: 10000;
}
.intro-progress .fill {
  height: 100%; width: 0;
  background: linear-gradient(90deg, var(--honey), var(--orange));
  animation: intro-fill 5s linear forwards;
}
@keyframes intro-fill { to { width: 100%; } }
```

**Skip button** (perbaiki): touch target ≥ 44px (`padding: 12px 24px`), `opacity:1`, `:focus-visible` ring cartoon, `aria-label="Skip intro"`, tetap `e.stopPropagation()`.

**Reduced motion** (wajib):
```css
@media (prefers-reduced-motion: reduce) {
  #intro { display: none; } /* skip intro total */
}
```
JS: `matchMedia('(prefers-reduced-motion: reduce)').matches` → langsung `finish()`.

**A11y intro**: ganti `role="presentation"` → `role="img"` + `aria-label="Bear Tool"`, atau `aria-hidden="true"` sampai selesai. Fokus skip button saat intro muncul.

### 3b. SPINNER MUTER² KONSISTEN DI SEMUA LOADING STATE

**Perbaiki spinner-bear** (jangan putar wajah):
```css
.spinner-bear { width: 44px; height: 44px; animation: bear-idle 1s ease-in-out infinite; }
@keyframes bear-idle { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
/* ring honey muter DI SEKELILING bear, bukan bear-nya yang muter */
.spinner-bear-wrap { position: relative; width: 64px; height: 64px; }
.spinner-bear-wrap .ring {
  position: absolute; inset: 0; border-radius: 50%;
  border: 3px dashed var(--honey);
  animation: spin 1.2s linear infinite;
}
```

**Tambah button loading state** (komponen baru — ini yang paling kurang):
```css
.btn.is-loading { pointer-events: none; opacity: 0.85; }
.btn.is-loading .btn-spinner {
  width: 16px; height: 16px; border-radius: 50%;
  border: 3px solid rgba(45,42,50,.25); border-top-color: var(--ink);
  animation: spin .7s linear infinite;
}
```
JS helper di ui.js:
```js
export function setBtnLoading(btn, loading, label = 'Loading...') {
  if (loading) {
    btn.dataset.orig = btn.innerHTML;
    btn.classList.add('is-loading');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.innerHTML = `<span class="btn-spinner"></span> ${label}`;
  } else {
    btn.classList.remove('is-loading');
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    btn.innerHTML = btn.dataset.orig;
  }
}
```

**Peta pemakaian wajib** (isi semua loading state):

| Aksi | Feedback |
|---|---|
| Dashboard assets | Skeleton rows (3-4 baris) — lebih baik dari spinner |
| NFT grid | Skeleton cards (6 kotak) |
| Activity list | Skeleton rows |
| Swap quote / Bridge route | spinner-dots (sudah ada — pertahankan) |
| Approval scan | spinner-bear + teks "Scanning approvals..." |
| **Send / Deploy / Delegate / Revoke / Batch / Rescue / Claim** | `setBtnLoading(btn, true)` + setelah tx broadcast → modal "Processing" dengan **spinner-honey** + tx hash + link explorer |
| Unlock/decrypt wallet | button loading |
| Switch network | pill loading (spinner-dots kecil di dalam pill) |
| Save settings / Clear data | button loading |

**spinner-honey** (yang mati) → jadikan spinner utama untuk "transaction processing" (modal pending tx). Ini yang paling cartoon & paling "muter²".

### 3c. POLISH UI

**Tokens baru** (hilangkan semua hardcoded):
```css
:root {
  --warn-bg: #FFF3CD; --danger-bg: #FFE3E3;
  --overlay: rgba(45,42,50,.6); --shadow-modal: rgba(45,42,50,.4);
  --focus-ring: var(--sky); --border-thin: 2px solid var(--ink);
  --font-mono: 'Fredoka', 'Baloo 2', monospace; /* rounded mono fallback */
}
```

**Focus-visible cartoon** (semua elemen interaktif):
```css
.btn:focus-visible, .nav-item:focus-visible, .network-pill:focus-visible,
.account-pill:focus-visible, .asset-row:focus-visible, .modal-close:focus-visible,
.intro-skip:focus-visible, .badge:focus-visible {
  outline: 3px solid var(--ink);
  outline-offset: 3px;
  box-shadow: 0 0 0 6px var(--focus-ring);
}
.input:focus, .select:focus, .textarea:focus {
  outline: 3px solid var(--ink);
  outline-offset: 2px;
  box-shadow: 0 0 0 5px var(--focus-ring); /* ganti rgba lemah */
}
```

**Kontras** (fix wajib):
- `badge-mainnet`: ganti teks putih → `var(--ink)` (berry vs ink ≈ 5.9:1 PASS).
- Semua teks `opacity:0.7` → ganti dengan warna token eksplisit `--ink-soft: #6B6478` (≈ 5.5:1 vs white, ≈ 4.6:1 vs cream — PASS).
- `.balance-hero .sub` → `color: rgba(45,42,50,.85)` di sisi honey saja, atau naikkan jadi solid ink.
- `badge-grape`: teks putih → ink.

**Touch target ≥ 44px**: `network-pill`, `account-pill` padding 12px 16px; `intro-skip` 12px 24px; `modal-close` pakai wrapper 44×44px (bukan font 1.5rem telanjang).

**Empty state yang helpful** (bukan "Data tidak ditemukan"):
```html
<div class="empty-state">
  <img src="assets/bear.svg" alt="" class="empty-bear">
  <h3>Belum ada aset</h3>
  <p>Hubungkan wallet atau buat wallet baru untuk mulai.</p>
  <button class="btn btn-primary">Connect Wallet</button>
</div>
```
Terapkan di: dashboard (connect), assetList (no assets), NFT grid, activity, approval (sudah ada "Clean! 🐻" — beri mascot + CTA).

**Error state input**:
```css
.input-error { border-color: var(--berry); box-shadow: 0 0 0 4px rgba(255,107,107,.25); }
.field .error-msg { color: var(--berry); font-size: .8rem; font-weight: 600; margin-top: 4px; }
```

**Modal a11y** (P0): focus trap (Tab cycle), Escape close, `aria-labelledby` ke judul modal, restore focus ke elemen pemicu, `body { overflow: hidden }` saat open.

**Toast upgrade**: icon per tipe (✅/❌/ℹ️ + mascot kecil), tombol close, `aria-live="assertive"` untuk error. Mascot: pakai bearReaction() yang sudah ada (lihat 3d).

**Responsive**: tambah breakpoint 1024px (layout 200px sidebar + konten lebih lega), pastikan grid NFT `minmax(140px,1fr)` aman di layar 320px. Touch target dicek ulang di mobile.

**Dark mode (opsional, P2)**:
```css
@media (prefers-color-scheme: dark) {
  :root {
    --cream: #1E1B24; --white: #2A2631; --ink: #F5EEDC;
    --shadow: 4px 4px 0 rgba(0,0,0,.6);
    /* dst — semua komponen otomatis ikut karena token */
  }
}
```

### 3d. KOMPONEN BARU

**1. Skeleton loading** (dashboard/NFT/activity):
```css
.skeleton {
  border-radius: 12px;
  background: linear-gradient(90deg, #F0E8D8 25%, #FFF8E7 50%, #F0E8D8 75%);
  background-size: 200% 100%;
  animation: shimmer 1.2s ease infinite;
}
@keyframes shimmer { to { background-position: -200% 0; } }
.skeleton-row { height: 56px; margin-bottom: 8px; }
.skeleton-card { aspect-ratio: 1; }
```
JS: `renderSkeletonRows(n)` / `renderSkeletonCards(n)` di ui.js, dipakai di loadDashboard/loadNfts/loadActivity.

**2. Animated number counter** (balance hero):
```js
export function animateNumber(el, target, { duration = 800, formatter = v => v } = {}) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) { el.textContent = formatter(target); return; }
  const start = performance.now(), from = 0;
  const tick = (now) => {
    const p = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
    el.textContent = formatter(from + (target - from) * eased);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
```
Dipakai di `renderAssets` → `$('#totalBalance')` count-up dari 0 ke total.

**3. Bear mascot reactions** (bearReaction di theme.js sekarang cuma return img yang sama — parameter `kind` mati):
- Buat 3 varian SVG: `bear-happy.svg` (mata ^ ^, senyum lebar), `bear-sad.svg` (mata turun, mulut cemberut), `bear-warn.svg` (alis turun, mulut datar). Atau 1 SVG dengan `<g id="expr-happy">` dst yang di-toggle via class.
- API: `bearReaction('happy' | 'sad' | 'warning' | 'thinking')` → return img dengan class `bear-react bear-{kind}`.
- Pemakaian: toast success → happy; toast error → sad; confirmTx danger → warning; empty state → thinking; tx pending → thinking + spinner.

---

## 4. PRIORITAS

### P0 (harus, blokir "matang")
1. Fix bug blink intro (selektor `.intro-logo .eye` → wrapper/class di SVG).
2. Intro: fade-out 0.4s + progress bar 5s + skip button 44px + `prefers-reduced-motion` skip total.
3. `prefers-reduced-motion` global di CSS (semua animasi).
4. Button loading state (`setBtnLoading`) di SEMUA aksi tx: send, deploy, delegate, revoke, batch, rescue, claim, unlock, network switch, save settings.
5. spinner-honey dipakai sebagai modal "Processing tx" (kode mati dihidupkan).
6. Focus-visible cartoon di semua elemen interaktif + perbaiki ring input (kontras 3:1).
7. Fix kontras: badge-mainnet (putih→ink), semua teks opacity 0.7 → `--ink-soft`, `.balance-hero .sub`.
8. Touch target ≥ 44px: network-pill, account-pill, intro-skip, modal-close.
9. Modal a11y: focus trap, Escape, aria-labelledby, restore focus, scroll lock.
10. Token untuk semua warna hardcoded.

### P1 (segera)
1. Intro fase 4-5 kaya: wiggle + sparkle + progress selesai (spesifikasi 3a).
2. Skeleton loading: dashboard, NFT, activity.
3. Animated number counter untuk balance.
4. Bear mascot reactions (3 varian SVG) di toast/confirm/empty.
5. Empty state upgrade: mascot + judul + hint + CTA.
6. Input error state + pesan validasi per field.
7. Konsistensi border: 2px → 3px di asset-row/tx-detail/batch-item.
8. Font mono rounded (Fredoka fallback) untuk `.mono`/`.addr`.
9. Toast: icon + close + aria-live assertive untuk error.
10. badge-grape teks → ink.

### P2 (nanti)
1. Dark mode via `prefers-color-scheme` (token sudah siap dari P0-10).
2. Breakpoint 1024px + polish responsive 320px.
3. i18n string (settings sudah ada select-nya).
4. Micro-interaction tambahan: asset-row active state, nav-item active press.

---

## 5. A11Y CHECKLIST (WCAG 2.1 AA)

| Item | Status Sekarang | Target |
|---|---|---|
| 1.4.3 Contrast (normal text) | FAIL — opacity 0.7, badge-mainnet 2.78:1 | PASS ≥ 4.5:1 |
| 1.4.11 Non-text contrast (focus ring) | FAIL — rgba sky 0.3 ≈ 1.3:1 | PASS ≥ 3:1 |
| 2.1.1 Keyboard | PARTIAL — button native ok; modal tanpa trap/Escape | PASS |
| 2.4.7 Focus visible | FAIL — button/nav/pill tanpa focus-visible | PASS |
| 2.5.5 Target size | FAIL — pill 36px, skip 34px, close 24px | PASS ≥ 44px |
| 2.3.3 Animation from interaction | FAIL — tidak ada prefers-reduced-motion | PASS |
| 4.1.2 Name/Role/Value | PARTIAL — modal tanpa aria-labelledby; intro role salah | PASS |
| 4.1.3 Status messages | PARTIAL — toast wrap polite ada; error perlu assertive | PASS |

---

## 6. TOKENS (baru/diubah)

| Token | Nilai | Usage |
|---|---|---|
| `--ink-soft` | `#6B6478` | pengganti semua teks opacity 0.7 (PASS kontras) |
| `--warn-bg` | `#FFF3CD` | warn-box |
| `--danger-bg` | `#FFE3E3` | danger-box |
| `--overlay` | `rgba(45,42,50,.6)` | modal overlay |
| `--shadow-modal` | `rgba(45,42,50,.4)` | modal shadow |
| `--focus-ring` | `var(--sky)` | focus-visible ring |
| `--border-thin` | `2px solid var(--ink)` | divider internal saja |
| `--font-mono` | `'Fredoka', 'Baloo 2', monospace` | `.mono`/`.addr` |

---

## 7. MOTION

- **Durasi**: micro-interaction 120-200ms (button, hover); intro 5s total; spinner 0.7-1.2s loop.
- **Easing**: masuk pakai spring `cubic-bezier(.34,1.56,.64,1)`; keluar `ease`; progress `linear` (karena 5s fixed).
- **Reduced-motion fallback**: skip intro total; counter langsung ke nilai akhir; skeleton → static block; spinner → static icon + teks "Loading...".
- **Prinsip**: animasi memberi tahu "ada yang terjadi" (loading) atau "selesai" (success) — bukan dekorasi. Bear tidak boleh terbalik (fix spinner-bear).

---

## 8. BRAND

- Konsistensi warna/token: **PASS** (palet cartoon konsisten).
- Konsistensi border/shadow: **NOTES** — 2px vs 3px tidak konsisten (P1).
- Mascot: **NOTES** — bearReaction() mati, ekspresi belum ada (P1).
- Font: **NOTES** — mono keluar dari tema (P1).

---

## 9. PERFORMA (above-the-fold)

- Intro 5s = 5 detik user tidak bisa pakai app. Setelah P0-2 (skip + reduced-motion), mayoritas user bisa lewati.
- Font Google: `preconnect` sudah ada ✓. Pertimbangkan `font-display: swap` (default Google Fonts sudah swap).
- SVG logo/bear inline-able (2 file kecil) — bisa di-inline ke HTML untuk hemat request.
- Skeleton mencegah layout shift saat data async (CLS).

---

## 10. CATATAN

- **Keputusan desain**: spinner-bear TIDAK diputar (wajah terbalik = jelek); diganti idle bounce + ring orbit. Ini keputusan paling penting di bagian animasi.
- **Trade-off**: intro 5s tetap dipertahankan (user minta 5 detik) tapi diisi penuh per fase + skip + progress. Reduced-motion user tidak melihat intro sama sekali — trade-off aksesibilitas vs keinginan user, aksesibilitas menang.
- **Urutan kerja yang disarankan**: P0-1 s/d P0-3 (intro) → P0-4 s/d P0-5 (spinner konsisten) → P0-6 s/d P0-9 (a11y) → P0-10 (token) → P1. Setiap langkah = test visual manual di browser + audit ulang.