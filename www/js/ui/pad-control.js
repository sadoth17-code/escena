import { h } from '../util.js';
import { app } from '../app.js';
import { PAD_NOTES, PAD_STYLES } from '../pad.js';
import { icon, openModal, setText } from './kit.js';

let padModal = null;

export function openPadModal() {
  if (padModal) { padModal.el.focus({ preventScroll: true }); return padModal; }
  const title = h('strong', { class: 'pad-bank-title' });
  const detail = h('span', { class: 'pad-bank-detail' });
  const link = h('button', { type: 'button', class: 'btn pad-link', 'aria-label': 'Vincular pad a la tonalidad de la canción', onClick: () => app.setPad({ followSong: !app.settings.pad.followSong }) }, icon('swap', 18), 'LINK');
  const style = h('select', { class: 'select pad-style', 'aria-label': 'Sonido del pad', onChange: () => app.setPad({ style: style.value }) },
    PAD_STYLES.map(item => h('option', { value: item.id, text: item.name })));
  const fade = h('select', { class: 'select pad-fade', 'aria-label': 'Duración de transición del pad', onChange: () => app.setPad({ fade: Number(fade.value) }) },
    [1, 2, 4].map(value => h('option', { value, text: `${value} s` })));
  const volume = h('input', { type: 'range', class: 'range', min: 0, max: 100, step: 1, 'aria-label': 'Volumen del pad', onInput: () => app.setPad({ volume: Number(volume.value) / 100 }) });
  const volumeText = h('output', { class: 'range-value' });
  const status = h('span', { class: 'pad-status', role: 'status', 'aria-live': 'polite' });
  const start = h('button', { type: 'button', class: 'btn primary pad-start', onClick: () => app.togglePad() });
  const stop = h('button', { type: 'button', class: 'btn pad-stop', 'aria-label': 'Detener pad', onClick: () => app.pad?.stop() }, icon('stop', 18), 'Detener');
  const notes = new Map();
  const grid = h('div', { class: 'pad-note-grid', 'aria-label': 'Tonalidades del pad' });
  // Two rows follow the supplied screenshot; flats are equivalent to sharps.
  for (const note of [1, 3, 6, 8, 10, 11, 0, 2, 4, 5, 7, 9]) {
    const name = PAD_NOTES[note];
    const button = h('button', { type: 'button', class: 'pad-key', 'aria-label': `Pad ${name}`, 'aria-pressed': 'false', onClick: () => {
      app.setPad({ followSong: false, note });
      if (!app.pad?.active) app.togglePad();
    } }, name);
    notes.set(note, button);
    grid.append(button);
  }
  const body = h('section', { class: 'pad-console' },
    h('div', { class: 'pad-bank-row' }, h('div', { class: 'pad-artwork', 'aria-hidden': 'true' }, icon('wave', 30)), h('div', { class: 'pad-bank-name' }, title, detail), link),
    h('div', { class: 'pad-options' }, h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Sonido' }), style), h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Transición' }), fade)),
    grid,
    h('div', { class: 'pad-footer' }, h('div', { class: 'pad-transport' }, start, stop), status),
    h('label', { class: 'pad-volume field' }, h('span', { class: 'field-label', text: 'Volumen del pad' }), h('div', { class: 'range-wrap' }, volume, volumeText)),
    h('p', { class: 'pad-hint field-hint', text: 'Pulsa una nota para tocarla. LINK sigue el tono y la transposición de la canción. El pad continúa al cerrar esta ventana y entre canciones.' }));
  const sync = () => {
    const settings = app.settings.pad;
    const pad = app.pad;
    const active = Boolean(pad?.active);
    const loading = Boolean(pad?.loading || app.padStarting);
    const sound = PAD_STYLES.find(item => item.id === settings.style) || PAD_STYLES[0];
    setText(title, `${sound.name} Pad`);
    setText(detail, sound.detail);
    style.value = settings.style;
    fade.value = String(settings.fade || 2);
    link.classList.toggle('primary', settings.followSong);
    link.setAttribute('aria-pressed', String(settings.followSong));
    link.title = settings.followSong ? 'Sigue la tonalidad de la canción' : 'Tonalidad manual';
    volume.value = String(Math.round(settings.volume * 100));
    volume.style.setProperty('--fill', `${volume.value}%`);
    setText(volumeText, `${volume.value} %`);
    for (const [note, button] of notes) {
      const selected = note === (pad?.note ?? settings.note);
      const playing = active && note === pad?.currentVoice?.note;
      button.classList.toggle('is-selected', selected);
      button.classList.toggle('is-active', playing);
      button.setAttribute('aria-pressed', String(playing));
    }
    start.disabled = active || loading;
    stop.disabled = !active && !loading;
    setText(start, loading ? 'Preparando…' : active ? 'Sonando' : 'Iniciar pad');
    const audible = pad?.currentVoice;
    setText(status, pad?.error || (loading ? 'Preparando sonido local…' : active ? `${PAD_NOTES[audible?.note ?? pad.note]} · ${settings.followSong ? 'LINK' : 'Manual'}` : 'Pad detenido'));
    body.setAttribute('aria-busy', String(loading));
  };
  const off = app.on('pad', sync);
  padModal = openModal({ title: 'Pad de acompañamiento', body, size: 'lg', className: 'pad-modal', onClose: () => { off(); padModal = null; } });
  sync();
  return padModal;
}

export function createPadControl({ compact = false } = {}) {
  const state = h('span', { class: 'pad-launcher-state' });
  const button = h('button', { type: 'button', class: `btn pad-launcher${compact ? ' small' : ''}`, 'aria-label': 'Abrir pad de acompañamiento', 'aria-haspopup': 'dialog', onClick: openPadModal }, icon('wave', 18), h('span', { text: 'Pad' }), state);
  const sync = () => {
    const active = Boolean(app.pad?.active);
    button.classList.toggle('active', active);
    setText(state, app.pad?.loading ? '…' : active ? PAD_NOTES[app.pad.currentVoice?.note ?? app.pad.note] : '');
    button.title = active ? `Pad sonando en ${PAD_NOTES[app.pad.note]} · Abrir controles` : 'Abrir pad de acompañamiento';
  };
  app.on('pad', sync);
  sync();
  return button;
}
