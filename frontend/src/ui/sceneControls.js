/** Own Scene panel listeners and presentation through project reads and actions. */
import {
  sceneElements,
  renderSceneOptions,
  renderSceneShots,
  presentSceneSelection,
  presentSceneButtons,
  presentSceneProgress,
  presentSceneRuntime,
} from './scenePresentation.js';

export class SceneControls {
  constructor({ read, actions, subscribe, elements = sceneElements() }) {
    this.read = read;
    this.actions = actions;
    this.elements = elements;
    this.destroyed = false;
    this.actionGeneration = 0;
    // Tracks the inline scene-name field's visibility explicitly instead of
    // reading input.hidden (fixtures and older markup may leave it unset).
    this._nameFieldOpen = false;
    this.removers = [];
    this.rowRemovers = [];
    this.playbackKeyRemover = null;
    if (!elements.select) return;
    if (subscribe)
      this.unsubscribe = subscribe((notification) =>
        this.present(notification),
      );
    else {
      this.renderSceneSelect();
      this.renderShotList();
    }
    this.listen(elements.select, 'change', () =>
      this.run('selectScene', elements.select.value),
    );
    for (const [element, action] of Object.entries({
      capture: 'capture',
      update: 'update',
      next: 'next',
      export: 'export',
      download: 'download',
    })) {
      this.listen(elements[element], 'click', () => this.run(action));
    }
    this.listen(elements.new, 'click', () => this.createScene());
    // Inline, non-blocking scene naming (replaces window.prompt).
    if (elements.nameInput) {
      this.listen(elements.nameInput, 'keydown', (event) => {
        if (event.key === 'Enter') this.commitSceneName();
        else if (event.key === 'Escape') this.cancelSceneName();
      });
      this.listen(elements.nameInput, 'blur', () => this.cancelSceneName());
    }
    this.listen(elements.delete, 'click', () => this.deleteSelectedScene());
    this.listen(elements.start, 'click', () =>
      this.run('start', this.read().selectedSceneId),
    );
    this.listen(elements.stop, 'click', () => this.run('stop', 'Stopped'));
    this.listen(elements.import, 'click', () => elements.file?.click());
    this.listen(elements.file, 'change', async () => {
      const file = elements.file?.files?.[0];
      if (!file) return;
      await this.run(
        this.actions.reviewImport ? 'reviewImport' : 'import',
        file,
      );
      if (!this.destroyed) elements.file.value = '';
    });
    if (!subscribe) {
      this.updateStatus('Ready');
      this.setProgress(0);
      this.setButtons(false);
    }
  }

  /** Apply only the presentation affected by an action; selection keeps row identity. */
  present({ state, change, initial }) {
    if (this.destroyed) return;
    const type = change?.type;
    if (
      initial ||
      [
        'scene-options-changed',
        'scene-created',
        'scene-deleted',
        'project-imported',
      ].includes(type)
    )
      this.renderSceneSelect();
    if (
      initial ||
      [
        'shots-changed',
        'scene-created',
        'scene-deleted',
        'shot-captured',
        'shot-updated',
        'shot-renamed',
        'shot-deleted',
        'project-imported',
      ].includes(type)
    )
      this.renderShotList();
    if (type === 'selection-changed')
      presentSceneSelection(this.elements.shots, state.selectedShotId);
    if (initial || type === 'buttons-changed') this.setButtons(state.running);
    if (initial || type === 'progress-changed')
      this.setProgress(state.progress);
    if (initial || type === 'status-changed') this.updateStatus(state.status);
    if (initial || type === 'runtime-changed')
      this.updateRuntime(state.runtime);
    if (initial || type === 'playback-presentation')
      this.setPlaybackActive(state.playbackActive);
    if (initial || type === 'playback-keyboard')
      this.setPlaybackKeyboardEnabled(state.keyboardEnabled);
    if (type === 'project-exported') this.updateStatus(state.status);
    if (type === 'shot-loaded') this.updateStatus(state.status);
    if (type === 'run-event' && change.event === 'shot_start')
      this.setButtons(state.running);
  }

  listen(target, type, callback, removers = this.removers) {
    if (!target) return;
    const listener = (event) => {
      if (!this.destroyed) return callback(event);
    };
    target.addEventListener(type, listener);
    removers.push(() => target.removeEventListener(type, listener));
  }

  run(action, ...args) {
    if (this.destroyed) return;
    const generation = ++this.actionGeneration;
    const failed = () => {
      if (!this.destroyed && generation === this.actionGeneration)
        this.updateStatus('Scene action failed');
    };
    try {
      const result = this.actions[action](...args);
      return result?.then ? Promise.resolve(result).catch(failed) : result;
    } catch {
      failed();
    }
  }

  renderSceneSelect() {
    if (!this.destroyed) renderSceneOptions(this.elements.select, this.read());
  }

  createScene() {
    if (this.destroyed) return;
    const input = this.elements.nameInput;
    if (!input) {
      // Fallback for markup without the inline field (older templates):
      const fallback =
        typeof window !== 'undefined' && typeof window.prompt === 'function'
          ? window.prompt('New scene name', `Scene ${this.read().scenes.length + 1}`)
          : null;
      if (fallback) this.run('create', fallback);
      return;
    }
    if (this._nameFieldOpen) {
      input.focus();
      return;
    }
    this._nameFieldOpen = true;
    input.hidden = false;
    input.value = `Scene ${this.read().scenes.length + 1}`;
    input.focus();
    if (typeof input.select === 'function') input.select();
  }

  commitSceneName() {
    if (this.destroyed) return;
    const input = this.elements.nameInput;
    if (!input || !this._nameFieldOpen) return;
    const name = String(input.value || '').trim();
    this._nameFieldOpen = false;
    input.hidden = true;
    if (name) this.run('create', name);
  }

  cancelSceneName() {
    this._nameFieldOpen = false;
    const input = this.elements.nameInput;
    if (input) input.hidden = true;
  }

  deleteSelectedScene() {
    if (this.destroyed) return;
    const state = this.read();
    const scene = state.scenes.find(
      (item) => item.id === state.selectedSceneId,
    );
    if (scene && window.confirm(`Delete scene "${scene.title}" and all shots?`))
      this.run('deleteScene');
  }

  deleteShot(sceneId, shotId) {
    if (this.destroyed) return;
    const scene = this.read().scenes.find((item) => item.id === sceneId);
    const shot = scene?.shots.find((item) => item.id === shotId);
    if (shot && window.confirm(`Delete shot "${shot.title}"?`))
      this.run('deleteShot', sceneId, shotId);
  }

  renderShotList() {
    if (this.destroyed) return;
    for (const remove of this.rowRemovers.splice(0)) remove();
    renderSceneShots(this.elements.shots, this.read(), {
      listen: (element, type, callback) =>
        this.listen(element, type, callback, this.rowRemovers),
      select: (id) => {
        this.run('selectShot', id);
        if (!this.destroyed)
          presentSceneSelection(
            this.elements.shots,
            this.read().selectedShotId,
          );
      },
      rename: (sceneId, shotId, title) =>
        this.run('renameShot', sceneId, shotId, title),
      load: (sceneId, shotId) => this.run('load', sceneId, shotId),
      remove: (sceneId, shotId) => this.deleteShot(sceneId, shotId),
    });
  }

  setButtons(running) {
    if (!this.destroyed)
      presentSceneButtons(this.elements, running, this.read().hasRun);
  }

  setProgress(progress) {
    if (!this.destroyed) presentSceneProgress(this.elements.progress, progress);
  }

  updateStatus(text) {
    if (!this.destroyed && this.elements.status)
      this.elements.status.textContent = text;
  }

  updateRuntime(text) {
    if (!this.destroyed) presentSceneRuntime(this.elements.runtime, text);
  }

  setPlaybackActive(active) {
    if (this.destroyed && active) return;
    document.body.classList.toggle('scene-playback-mode', active);
  }

  setPlaybackKeyboardEnabled(enabled) {
    if (!enabled) {
      this.playbackKeyRemover?.();
      this.playbackKeyRemover = null;
    } else if (!this.destroyed && !this.playbackKeyRemover) {
      const onKeyDown = (event) => {
        if (!this.destroyed && event.key === 'Escape' && this.read().running)
          this.run('stop', 'Stopped (Esc)');
      };
      document.addEventListener('keydown', onKeyDown);
      this.playbackKeyRemover = () =>
        document.removeEventListener('keydown', onKeyDown);
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.actionGeneration++;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.setPlaybackKeyboardEnabled(false);
    for (const remove of [
      ...this.removers.splice(0),
      ...this.rowRemovers.splice(0),
    ])
      remove();
    if (this.elements.shots) this.elements.shots.textContent = '';
    presentSceneRuntime(this.elements.runtime, '');
    this.setPlaybackActive(false);
  }
}
