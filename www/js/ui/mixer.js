import { h, fmtPan, fmtTime } from '../util.js';
import { app } from '../app.js';
import { isClickName, isGuideName } from '../library.js';
import { createFader, createPan, createMeterBar, icon, dbLabel, setText, setClass } from './kit.js';

const AMBER = '#ffb020';
const PAN_HINT = 'El paneo funciona en el modo Estéreo y en Salidas múltiples. Cámbialo en Ajustes → Salida';
const PAN_HINT_CUE = 'En Salidas múltiples el paneo mueve solo las pistas de Sala; el click y las guías salen en mono';

function canPan(mode, dest) {
  return mode === 'stereo' || (mode === 'multi' && dest !== 'cue');
}

function destLabel(dest) {
  return dest === 'cue' ? 'CUE' : 'SALA';
}

function buildStrip(node, kind, label) {
  const def = node.def;
  const shown = label || def.name;
  const color = kind === 'file' ? def.color || '#35c9ff' : AMBER;
  const dest = h('button', {
    type: 'button',
    class: 'dest',
    onClick: () => app.setTrackDest(node, def.dest === 'cue' ? 'main' : 'cue'),
  });
  const name = h('div', { class: 'strip-name', title: shown, text: shown });
  const panValue = h('span', { class: 'pan-val' });
  const pan = createPan({
    value: def.pan,
    label: `Paneo de ${shown}`,
    onInput: (value) => {
      app.setTrackPan(node, value);
      setText(panValue, fmtPan(value));
    },
  });
  const panBox = h('div', { class: 'pan-box', onClick: () => strip.classList.contains('nopan') && app.toast(def.dest === 'cue' && app.engine.effectiveMode === 'multi' ? PAN_HINT_CUE : PAN_HINT) }, pan.el, panValue);
  const mute = h('button', { type: 'button', class: 'ms m', 'aria-label': `Silenciar ${shown}`, title: 'Silenciar', onClick: () => app.toggleTrackFlag(node, 'mute') }, 'M');
  const solo = h('button', { type: 'button', class: 'ms s', 'aria-label': `Solo ${shown}`, title: 'Solo', onClick: () => app.toggleTrackFlag(node, 'solo') }, 'S');
  const meter = createMeterBar();
  const db = h('div', { class: 'strip-db' });
  const fader = createFader({
    value: def.vol,
    label: `Volumen de ${shown}`,
    onInput: (value) => {
      app.setTrackLevel(node, value);
      setText(db, dbLabel(value));
    },
  });
  const strip = h(
    'div',
    { class: `strip ${kind}`, style: { '--c': color } },
    h('div', { class: 'strip-head' }, dest, name),
    panBox,
    h('div', { class: 'ms-row' }, mute, solo),
    h('div', { class: 'strip-fader' }, meter.el, fader.el),
    db
  );
  const frame = (now, nopan) => {
    setText(dest, destLabel(def.dest));
    setClass(dest, 'cue', def.dest === 'cue');
    setClass(strip, 'nopan', nopan);
    setClass(mute, 'on', Boolean(def.mute));
    setClass(solo, 'on', Boolean(def.solo));
    setClass(strip, 'is-muted', Boolean(def.mute));
    setClass(strip, 'is-silenced', node.silenced && !def.mute);
    if (fader.value !== def.vol) fader.set(def.vol);
    if (pan.value !== def.pan) pan.set(def.pan);
    setText(db, dbLabel(def.vol));
    setText(panValue, fmtPan(def.pan));
    meter.set(node.peak(), now);
  };
  return { el: strip, frame, node };
}

function buildOutput({ name, detail, key, color }) {
  const db = h('div', { class: 'strip-db' });
  const fader = createFader({
    value: app.settings.output[key],
    label: `Nivel ${name}`,
    onInput: (value) => app.setOutput({ [key]: value }),
  });
  const meters = key === 'master' ? [createMeterBar(), createMeterBar()] : [];
  const strip = h(
    'div',
    { class: 'strip out', style: { '--c': color } },
    h('div', { class: 'strip-head' }, h('span', { class: 'dest out-tag', text: key === 'master' ? 'MASTER' : 'NIVEL' }), h('div', { class: 'strip-name', title: detail, text: name })),
    h('div', { class: 'strip-fader' }, ...meters.map((meter) => meter.el), fader.el),
    db
  );
  const frame = (now, levels) => {
    const value = app.settings.output[key];
    if (fader.value !== value) fader.set(value);
    setText(db, dbLabel(value));
    meters.forEach((meter, index) => meter.set(levels[index], now));
  };
  return { el: strip, frame };
}

export function createMixer({ onEdit }) {
  const strips = h('div', { class: 'strips' });
  const scroller = h('div', { class: 'mixer', tabindex: '-1' }, strips);
  const miniPlay = h('button', { type: 'button', class: 'mini-play', 'aria-label': 'Reproducir', onClick: () => app.togglePlay() }, icon('play', 22));
  const miniTitle = h('b', { class: 'mini-title' });
  const miniInfo = h('span', { class: 'mini-info' });
  const mini = h(
    'div',
    { class: 'mixer-head' },
    miniPlay,
    h('div', { class: 'mini-text' }, miniTitle, miniInfo),
    h('div', { class: 'legend' }, h('span', { class: 'dest', text: 'SALA' }), h('span', { class: 'dest cue', text: 'CUE' })),
    h('button', { type: 'button', class: 'btn small', 'aria-label': 'Editar pistas', onClick: () => onEdit('tracks') }, icon('edit', 16), h('span', { class: 'btn-text', text: 'Pistas' }))
  );
  const empty = h('div', { class: 'mixer-empty', text: 'La mezcla aparece al cargar una canción' });
  const el = h('div', { class: 'mixer-wrap' }, mini, scroller, empty);
  let items = [];
  let outputs = [];
  let entry = null;
  let playingShown = null;

  const setEntry = (next) => {
    entry = next;
    strips.replaceChildren();
    items = [];
    outputs = [];
    empty.hidden = Boolean(next);
    scroller.hidden = !next;
    if (!next) return;
    const player = next.player;
    for (const node of player.fileTracks) items.push(buildStrip(node, 'file'));
    const names = next.song.tracks.map((track) => track.name);
    items.push(buildStrip(player.click, 'click', names.some(isClickName) ? 'Click auto' : null));
    items.push(buildStrip(player.guide, 'guide', names.some(isGuideName) ? 'Guía auto' : null));
    for (const item of items) strips.append(item.el);
    strips.append(h('div', { class: 'strip-gap' }));
    outputs = [
      buildOutput({ name: 'Sala', detail: 'Nivel general de las pistas que van a la sala', key: 'mainLevel', color: '#35c9ff' }),
      buildOutput({ name: 'Cue', detail: 'Nivel general de click y guías', key: 'cueLevel', color: AMBER }),
      buildOutput({ name: 'Master', detail: 'Nivel de salida total', key: 'master', color: '#e8edf2' }),
    ];
    const group = h('div', { class: 'out-group' }, outputs.map((out) => out.el));
    strips.append(group);
    miniTitle.textContent = next.song.title;
  };

  const frame = (snap, now) => {
    if (!entry || !snap) return;
    const mode = app.engine.effectiveMode;
    for (const item of items) item.frame(now, !canPan(mode, item.node.def.dest));
    const levels = app.engine.readLevels();
    for (const out of outputs) out.frame(now, levels);
    const playing = snap.state === 'playing';
    if (playingShown !== playing) {
      playingShown = playing;
      miniPlay.replaceChildren(icon(playing ? 'pause' : 'play', 22));
      miniPlay.setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
    }
    setText(miniInfo, `${fmtTime(snap.time)} · c.${snap.bar}${snap.section && !snap.section.implicit ? ` · ${snap.section.name}` : ''}`);
  };

  setEntry(null);
  return { el, setEntry, frame };
}
