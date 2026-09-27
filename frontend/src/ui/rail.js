/* Left icon rail — one button per panel, single active state. */
import { emit, on } from '../data/store.js';

const buttons = new Map();

export function initRail() {
  const rail = document.getElementById('rail');
  if (!rail) return;
  rail.querySelectorAll('.rail-btn').forEach((btn) => {
    const name = btn.dataset.panel;
    buttons.set(name, btn);
    btn.addEventListener('click', () => {
      emit('toggle-panel', { name });
    });
  });

  on('panel-changed', (name) => setActive(name));
  on('close-panels', () => setActive(null));
}

export function setActive(name) {
  for (const [key, btn] of buttons) {
    btn.classList.toggle('active', key === name);
  }
}
