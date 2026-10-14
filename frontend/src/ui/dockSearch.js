/**
 * Bottom-dock search takeover (Rulings 2026-10-13 §2, Lane H).
 *
 * The search control lives in the bottom dock. Clicking it swaps the WHOLE
 * dock for the search bar; clicking anywhere outside the dock — or pressing
 * Escape — returns the dock to its regular state. Submitting runs the app's
 * existing location search (coordinates → bundled places → Photon →
 * /api/geocode via the adapter, per ARCH §4.3) by driving the legacy
 * #location-search input, so there is exactly one search pipeline.
 *
 * Suggestions are local and honest: preset places (the dock's own city
 * pills) and layer names (the catalog rows already in the DOM). Picking a
 * layer suggestion clicks that row's own toggle — no parallel layer API.
 */
export class DockSearchTakeover {
  constructor({ doc = document } = {}) {
    this.doc = doc;
    this.dock = doc.getElementById('command-dock');
    this.takeover = doc.getElementById('dock-search-takeover');
    this.input = doc.getElementById('dock-search-input');
    this.results = doc.getElementById('dock-search-results');
    this.openBtn = doc.getElementById('dock-search-btn');
    this.closeBtn = doc.getElementById('dock-search-close');
    this.legacyInput = doc.getElementById('location-search');
    this.legacyToggle = doc.getElementById('search-toggle');
    this.open = false;
    this.destroyed = false;
    this._removers = [];
    if (!this.dock || !this.takeover || !this.input) return;
    this._bind(this.openBtn, 'click', () => this.openTakeover());
    this._bind(this.legacyToggle, 'click', (event) => {
      // The legacy in-tray toggle now opens the takeover instead of the
      // cramped expanding input (one search grammar, per §F).
      event.preventDefault();
      event.stopPropagation();
      this.openTakeover();
    });
    this._bind(this.closeBtn, 'click', () => this.closeTakeover());
    this._bind(this.input, 'input', () => this._renderSuggestions());
    this._bind(this.input, 'keydown', (event) => this._onKeydown(event));
    // Outside-click dismissal: any pointer press that lands outside the
    // dock restores the regular dock (the ruling, verbatim behaviour).
    this._bind(this.doc, 'pointerdown', (event) => {
      if (!this.open) return;
      if (this.dock.contains(event.target)) return;
      this.closeTakeover({ restoreFocus: false });
    }, true);
  }

  _bind(target, type, handler, capture = false) {
    if (!target) return;
    target.addEventListener(type, handler, capture);
    this._removers.push(() => target.removeEventListener(type, handler, capture));
  }

  openTakeover() {
    if (this.destroyed || this.open) return;
    this.open = true;
    this.dock.classList.add('search-takeover');
    this.takeover.hidden = false;
    this.openBtn?.setAttribute('aria-expanded', 'true');
    this.input.value = this.legacyInput?.value || this.input.value || '';
    this._renderSuggestions();
    this.input.focus({ preventScroll: true });
    this.input.select?.();
  }

  closeTakeover({ restoreFocus = true } = {}) {
    if (!this.open) return;
    this.open = false;
    this.dock.classList.remove('search-takeover');
    this.takeover.hidden = true;
    this.openBtn?.setAttribute('aria-expanded', 'false');
    this.input.setAttribute('aria-expanded', 'false');
    this.results?.replaceChildren();
    if (restoreFocus) this.openBtn?.focus({ preventScroll: true });
  }

  _onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.closeTakeover();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const active = this.results?.querySelector('[data-active="true"]');
      if (active) { active.click(); return; }
      this._submit(this.input.value);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this._moveActive(event.key === 'ArrowDown' ? 1 : -1);
    }
  }

  _moveActive(delta) {
    const items = [...(this.results?.querySelectorAll('[role="option"]') || [])];
    if (!items.length) return;
    let index = items.findIndex((el) => el.dataset.active === 'true');
    index = (index + delta + items.length) % items.length;
    items.forEach((el, i) => el.dataset.active = String(i === index));
    items[index]?.scrollIntoView?.({ block: 'nearest' });
  }

  /** Local suggestions: preset places + catalog layer rows. No network. */
  _suggestions(query) {
    const q = String(query || '').trim().toLowerCase();
    const out = [];
    for (const pill of this.doc.querySelectorAll('.location-pill')) {
      const name = pill.textContent?.trim();
      if (name && (!q || name.toLowerCase().includes(q)))
        out.push({ kind: 'place', label: name, el: pill });
    }
    for (const row of this.doc.querySelectorAll('[data-layer-id]')) {
      const name = row.querySelector('.data-name, .data-toggle-name, .layer-name')?.textContent?.trim()
        || row.getAttribute('data-layer-id');
      if (name && (!q || name.toLowerCase().includes(q)))
        out.push({ kind: 'layer', label: name, el: row });
    }
    return out.slice(0, 8);
  }

  _renderSuggestions() {
    if (!this.results) return;
    const items = this._suggestions(this.input.value);
    this.results.replaceChildren();
    this.input.setAttribute('aria-expanded', String(items.length > 0));
    for (const item of items) {
      const btn = this.doc.createElement('button');
      btn.type = 'button';
      btn.className = 'dock-search-result';
      btn.setAttribute('role', 'option');
      btn.dataset.kind = item.kind;
      btn.textContent = `${item.kind === 'layer' ? 'Layer' : 'Place'} · ${item.label}`;
      btn.addEventListener('click', () => {
        if (item.kind === 'place') {
          this._submit(item.label);
        } else {
          const toggle = item.el.querySelector('button.data-toggle-btn, button[aria-label]');
          toggle?.click();
          this.closeTakeover();
        }
      });
      this.results.appendChild(btn);
    }
  }

  /** Run the one search pipeline: drive the legacy input's Enter handler. */
  _submit(query) {
    const q = String(query || '').trim();
    if (!q || !this.legacyInput) return;
    this.legacyInput.value = q;
    this.legacyInput.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    }));
    this.closeTakeover({ restoreFocus: false });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const remove of this._removers.splice(0)) remove();
  }
}
