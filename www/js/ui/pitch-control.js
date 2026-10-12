import { h } from '../util.js';
import { app } from '../app.js';
import { MIN_PITCH, MAX_PITCH, normalizePitch, pitchLabel, transposeKey, defaultPitchEnabled } from '../pitch-utils.js';
import { setText } from './kit.js';

export function createPitchControl() {
  let entry = null;
  let draft = 0;
  let progress = null;
  let selected = {};
  let checkboxes = [];
  const value = h('output', { class: 'pitch-value', 'aria-live': 'polite', 'aria-label': 'Cambio de tonalidad seleccionado' });
  const current = h('span', { class: 'pitch-current' });
  const hint = h('p', { class: 'pitch-hint', role: 'status', 'aria-live': 'polite' });
  const updateDraft = delta => { draft = normalizePitch(draft + delta); frame(); };
  const down = h('button', { type: 'button', class: 'btn pitch-step', 'aria-label': 'Bajar un semitono', title: 'Bajar un semitono', onClick: () => updateDraft(-1) }, '−');
  const up = h('button', { type: 'button', class: 'btn pitch-step', 'aria-label': 'Subir un semitono', title: 'Subir un semitono', onClick: () => updateDraft(1) }, '+');
  const apply = h('button', { type: 'button', class: 'btn primary', onClick: () => app.setPitch(draft, selected) }, 'Aplicar');
  const reset = h('button', { type: 'button', class: 'btn', onClick: async () => {
    if (await app.setPitch(0, selected)) { draft = 0; frame(); }
  } }, 'Original');
  const cancel = h('button', { type: 'button', class: 'btn small', hidden: true, onClick: () => entry?.player.cancelPitch() }, 'Cancelar');
  const bar = h('progress', { class: 'pitch-progress', max: 1, value: 0, hidden: true, 'aria-label': 'Preparando tonalidad' });
  const list = h('div', { class: 'pitch-tracks' });
  const summary = h('summary');
  const details = h('details', { class: 'pitch-details' }, summary,
    h('p', { class: 'pitch-hint', text: 'Marca las pistas musicales. Deja sin marcar click, guías y percusión para conservar su sonido.' }), list);
  const el = h('section', { class: 'pitch-panel', 'aria-label': 'Tonalidad de la canción' },
    h('div', { class: 'pitch-heading' }, h('b', { text: 'Tonalidad' }), current),
    h('div', { class: 'pitch-controls' }, h('div', { class: 'pitch-stepper' }, down, value, up), apply, reset, cancel),
    hint, bar, details);

  const frame = () => {
    const player = entry?.player;
    const busy = Boolean(player?.pitchBusy);
    const playing = player?.state === 'playing';
    const blocked = !entry || busy || playing;
    const applied = player?.pitchSemitones || 0;
    const dirty = draft !== applied || checkboxes.some(({ def }) => selected[def.id] !== (def.pitchEnabled ?? defaultPitchEnabled(def)));
    down.disabled = blocked || draft <= MIN_PITCH;
    up.disabled = blocked || draft >= MAX_PITCH;
    apply.disabled = blocked || !dirty;
    reset.disabled = blocked || (applied === 0 && draft === 0);
    cancel.hidden = !busy;
    bar.hidden = !busy;
    for (const { input } of checkboxes) input.disabled = blocked;
    el.setAttribute('aria-busy', String(busy));
    setText(value, pitchLabel(draft));
    const song = entry?.song;
    const originalKey = song?.key || 'sin indicar';
    const targetKey = transposeKey(song?.key, draft);
    setText(current, song?.key ? `Original: ${originalKey} · Selección: ${targetKey}` : `Aplicado: ${pitchLabel(applied)}`);
    setText(summary, `Pistas que cambian de tono (${Object.values(selected).filter(Boolean).length}/${checkboxes.length})`);
    if (busy) {
      const fraction = progress?.total ? progress.done / progress.total : 0;
      bar.value = fraction;
      setText(hint, `Preparando ${Math.round(fraction * 100)} %${progress?.label ? ` · ${progress.label}` : ''}`);
    } else {
      setText(hint, playing ? 'Pausa la canción para cambiar la tonalidad.' : '1 paso = 1 semitono · El tempo se mantiene · El ajuste se guarda por canción.');
    }
  };

  const setEntry = next => {
    entry = next;
    draft = normalizePitch(next?.player.pitchSemitones);
    selected = {};
    checkboxes = [];
    progress = null;
    list.replaceChildren();
    for (const track of next?.player.fileTracks || []) {
      const def = track.def;
      selected[def.id] = def.pitchEnabled ?? defaultPitchEnabled(def);
      const input = h('input', { type: 'checkbox', class: 'check', checked: selected[def.id], onChange: () => { selected[def.id] = input.checked; frame(); } });
      checkboxes.push({ def, input });
      list.append(h('label', { class: 'pitch-track' }, input, h('span', { text: def.name })));
    }
    frame();
  };

  app.on('pitch:progress', state => {
    if (state.entry !== entry) return;
    progress = state.total ? state : null;
    frame();
  });
  return { el, setEntry, frame };
}
