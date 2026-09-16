// ═══════════════════════════════════════════════════════════════
// Bear Tool — theme.js
// Intro logo animation (exactly 5s, skippable) + mascot helpers.
// Original implementation — no copying.
// ═══════════════════════════════════════════════════════════════

export function runIntro(onDone) {
  const intro = document.getElementById('intro');
  const title = document.getElementById('introTitle');
  const skip = document.getElementById('introSkip');
  const logo = document.getElementById('introLogo');

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    intro.classList.add('hidden');
    if (onDone) onDone();
  };

  // skip on click anywhere on intro
  intro.addEventListener('click', finish);
  skip.addEventListener('click', (e) => { e.stopPropagation(); finish(); });

  // letter-by-letter title (phase 3: 2-3s)
  const text = 'BEAR TOOL';
  title.innerHTML = '';
  [...text].forEach((ch, i) => {
    const span = document.createElement('span');
    span.textContent = ch === ' ' ? '\u00A0' : ch;
    span.style.animationDelay = (2 + i * 0.08) + 's';
    title.appendChild(span);
  });

  // eye blink handled by CSS (intro-blink on .eye — logo has no .eye class,
  // so we add a subtle scale pulse to the whole logo at 1-2s via CSS class)
  logo.classList.add('eye');

  // exact 5s timer
  setTimeout(finish, 5000);
}

// mascot reaction helper: swap bear image expression
export function bearReaction(kind) {
  // kinds: happy, sad, thinking, warning — future: different SVG expressions
  return `<img src="assets/bear.svg" alt="Bear" style="width:64px;height:64px;display:block;margin:0 auto 8px;">`;
}