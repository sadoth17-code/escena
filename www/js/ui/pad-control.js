import { h } from '../util.js';
import { app } from '../app.js';
import { PAD_NOTES } from '../pad.js';
import { setText } from './kit.js';

export function createPadControl({ compact = false } = {}) {
  const toggle = h('button', { type: 'button', class: 'btn', 'aria-pressed': 'false', onClick: () => app.togglePad() });
  if (compact) {
    const sync = () => { setText(toggle, app.pad?.active ? 'Detener pad' : 'Iniciar pad'); toggle.setAttribute('aria-pressed', String(Boolean(app.pad?.active))); };
    app.on('pad', sync); sync();
    return toggle;
  }
  const note = h('select', { class: 'select pad-note', 'aria-label': 'Nota del pad', onChange: () => app.setPad({ note: Number(note.value) }) },
    PAD_NOTES.map((name, index) => h('option', { value: index, text: name })));
  const style = h('select', { class: 'select pad-style', 'aria-label': 'Sonido del pad', onChange: () => app.setPad({ style: style.value }) },
    h('option', { value: 'soft', text: 'Suave' }), h('option', { value: 'warm', text: 'Cálido' }));
  const follow = h('input', { type: 'checkbox', class: 'check', onChange: () => app.setPad({ followSong: follow.checked }) });
  const volume = h('input', { type: 'range', class: 'range', min: 0, max: 100, step: 1, 'aria-label': 'Volumen del pad', onInput: () => app.setPad({ volume: Number(volume.value) / 100 }) });
  const volumeText = h('span', { class: 'range-value' });
  const state = h('span', { class: 'pad-state', role: 'status', 'aria-live': 'polite' });
  const el = h('section', { class: 'pad-panel', 'aria-label': 'Pad de acompañamiento' },
    h('div', { class: 'pitch-heading' }, h('b', { text: 'Pad de acompañamiento' }), state),
    h('div', { class: 'pad-controls' }, toggle, note, style),
    h('label', { class: 'pitch-track' }, follow, h('span', { text: 'Seguir la tonalidad de la canción' })),
    h('div', { class: 'range-wrap' }, h('span', { class: 'field-label', text: 'Volumen' }), volume, volumeText),
    h('p', { class: 'pitch-hint', text: 'Pad independiente con entrada y salida suave. Sale por Sala y puede continuar entre canciones.' }));
  const sync = () => {
    const settings = app.settings.pad;
    const active = Boolean(app.pad?.active);
    note.value = String(app.pad?.note ?? settings.note);
    note.disabled = settings.followSong;
    follow.checked = settings.followSong;
    style.value = settings.style;
    volume.value = String(Math.round(settings.volume * 100));
    setText(volumeText, `${volume.value} %`);
    setText(toggle, active ? 'Detener pad' : 'Iniciar pad');
    toggle.setAttribute('aria-pressed', String(active));
    toggle.classList.toggle('primary', active);
    setText(state, active ? `Sonando · ${PAD_NOTES[app.pad.note]}` : 'Apagado');
  };
  app.on('pad', sync); sync();
  return el;
}
