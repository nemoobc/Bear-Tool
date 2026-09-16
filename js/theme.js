// ═══════════════════════════════════════════════════════════════
// Bear Tool — theme.js
// Intro logo animation (exactly 5s, skippable, reduced-motion aware)
// + mascot helpers.
// Original implementation — no copying.
// ═══════════════════════════════════════════════════════════════

export function runIntro(onDone) {
  const intro = document.getElementById('intro');
  const title = document.getElementById('introTitle');
  const skip = document.getElementById('introSkip');
  const counter = document.getElementById('introCounter');

  let finished = false;
  const finish = (instant) => {
    if (finished) return;
    finished = true;
    if (instant) {
      intro.classList.add('hidden');
    } else {
      intro.classList.add('intro-fade'); // 0.4s fade (CSS transition)
      setTimeout(() => intro.classList.add('hidden'), 400);
    }
    if (onDone) onDone();
  };

  // reduced motion: skip the whole animation, still call onDone
  const prefersReduced = typeof matchMedia !== 'undefined' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced) return finish(true);

  // skip on click anywhere on intro
  intro.addEventListener('click', () => finish(true));
  skip.addEventListener('click', (e) => { e.stopPropagation(); finish(true); });

  // letter-by-letter title (phase 3: 2-3s)
  const text = 'BEAR TOOL';
  title.innerHTML = '';
  [...text].forEach((ch, i) => {
    const span = document.createElement('span');
    span.textContent = ch === ' ' ? '\u00A0' : ch;
    span.style.animationDelay = (2 + i * 0.08) + 's';
    title.appendChild(span);
  });

  // countdown 3 → 2 → 1 (phase 4: 3-4.6s)
  const counts = [['3', 3000], ['2', 4000], ['1', 4600]];
  counts.forEach(([val, ms]) => {
    setTimeout(() => { if (!finished && counter) counter.textContent = val; }, ms);
  });

  // exact 5s timer → fade out
  setTimeout(() => finish(false), 5000);
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