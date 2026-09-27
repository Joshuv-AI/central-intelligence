/* Boot ritual: black → glacier line sweep → wordmark stagger → caption →
   aurora shimmer → globe fades in. ~2s, calm. Honors prefers-reduced-motion. */

const WORD = 'CENTRAL INTELLIGENCE';
const MIN_MS = 2000;
const FADE_MS = 900;

export function buildBootWord() {
  const wrap = document.getElementById('boot-word');
  if (!wrap) return;
  wrap.textContent = '';
  let i = 0;
  for (const ch of WORD) {
    const s = document.createElement('span');
    s.textContent = ch === ' ' ? ' ' : ch;
    s.style.setProperty('--d', `${0.35 + i * 0.045}s`);
    wrap.appendChild(s);
    i += 1;
  }
}

export function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Resolve when the boot overlay has played and been removed. */
export function runBoot(readyPromise) {
  const boot = document.getElementById('boot');
  if (!boot) return Promise.resolve();

  if (reducedMotion()) {
    return readyPromise.then(() => {
      boot.classList.add('done');
      setTimeout(() => boot.remove(), 60);
    });
  }

  const minTime = new Promise((r) => setTimeout(r, MIN_MS));
  return Promise.all([readyPromise, minTime]).then(() => {
    boot.classList.add('done');
    return new Promise((resolve) => {
      setTimeout(() => {
        boot.remove();
        resolve();
      }, FADE_MS);
    });
  });
}
