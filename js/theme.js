// ═══════════════════════════════════════════════════════════════
// Bear Tool — theme.js
// Intro logo animation (1.5s, reduced-motion aware)
// + mascot helpers.
// Original implementation — no copying.
// ═══════════════════════════════════════════════════════════════

// Intro duration. 1.5s — fast enough to not annoy, slow enough to see logo.
export const INTRO_MS = 1500;

export function runIntro(onDone) {
  const intro = document.getElementById('intro');
  const title = document.getElementById('introTitle');

  let finished = false;
  const finish = (instant) => {
    if (finished) return;
    finished = true;
    if (!intro || !intro.parentNode) { if (onDone) onDone(); return; }
    if (instant) {
      intro.classList.add('hidden');
    } else {
      intro.classList.add('intro-fade');
      setTimeout(() => { if (intro.parentNode) intro.classList.add('hidden'); }, 400);
    }
    if (onDone) onDone();
  };

  // ABSOLUTE SAFETY: no matter what, call onDone within 2s
  const safetyTimer = setTimeout(() => finish(false), 2000);

  // reduced motion: skip everything immediately
  const prefersReduced = typeof matchMedia !== 'undefined' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced) { clearTimeout(safetyTimer); return finish(true); }

  // skip on click/touch/keyboard anywhere on intro
  if (intro) {
    intro.addEventListener('click', () => { clearTimeout(safetyTimer); finish(true); });
    intro.addEventListener('touchstart', () => { clearTimeout(safetyTimer); finish(true); }, { once: true });
    intro.setAttribute('tabindex', '0');
    intro.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { clearTimeout(safetyTimer); finish(true); }
    });
  }

  // letter-by-letter title
  const text = 'BEAR TOOL';
  if (title) {
    title.innerHTML = '';
    [...text].forEach((ch, i) => {
      const span = document.createElement('span');
      span.textContent = ch === ' ' ? '\u00A0' : ch;
      span.style.animationDelay = (0.8 + i * 0.06) + 's';
      title.appendChild(span);
    });
  }

  setTimeout(() => finish(false), INTRO_MS);
}

// mascot reaction helper: swap bear image expression
export function bearReaction(kind) {
  // kinds: happy, sad, thinking, warning — future: different SVG expressions
  return `<img src="assets/bear.svg" alt="Bear" style="width:64px;height:64px;display:block;margin:0 auto 8px;">`;
}

// ── DARK MODE ──
const THEME_KEY = 'bt-theme';

export function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || 'light';
  applyTheme(saved);
  // bind toggle buttons
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyTheme(btn.dataset.theme);
      localStorage.setItem(THEME_KEY, btn.dataset.theme);
    });
    if (btn.dataset.theme === saved) {
      btn.classList.add('active');
    }
  });
}

function applyTheme(mode) {
  const root = document.documentElement;
  root.classList.remove('theme-dark');
  if (mode === 'dark') {
    root.classList.add('theme-dark');
  } else if (mode === 'auto') {
    const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
    if (prefersDark) root.classList.add('theme-dark');
  }
}
