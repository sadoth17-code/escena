import { h, fmtTime, fmtBytes } from '../util.js';
import { accentLevel } from '../tempo.js';
import { app } from '../app.js';
import { icon, iconButton, setText, setClass } from './kit.js';
import { createTimeline } from './timeline.js';

const JUMP_MODES = [
  { id: 'bar', label: 'Salto en compás' },
  { id: 'beat', label: 'Salto en tiempo' },
  { id: 'now', label: 'Salto inmediato' },
];

export function outputLabels(output) {
  if (output.mode === 'split') return output.swap ? ['Pistas', 'Click y guía'] : ['Click y guía', 'Pistas'];
  if (output.mode === 'monitor') return output.swap ? ['Sala', 'Monitor'] : ['Monitor', 'Sala'];
  if (output.mode === 'multi') return ['Click y guía', 'Pistas'];
  return ['Izquierdo', 'Derecho'];
}

export function barsText(count) {
  if (count <= 0) return 'ahora';
  return count === 1 ? 'en 1 compás' : `en ${count} compases`;
}

function hbar() {
  const fill = h('i', { class: 'hbar-fill' });
  const peak = h('i', { class: 'hbar-peak' });
  const el = h('div', { class: 'hbar' }, fill, peak);
  let held = 0;
  let heldAt = 0;
  let shown = -1;
  return {
    el,
    set(level, now) {
      const position = level > 0.00099 ? Math.min(1, Math.max(0, (20 * Math.log10(level) + 60) / 60)) : 0;
      if (position >= held || now - heldAt > 900) {
        held = position;
        heldAt = now;
      }
      const key = Math.round(position * 200) * 1000 + Math.round(held * 200);
      if (key === shown) return;
      shown = key;
      fill.style.clipPath = `inset(0 ${((1 - position) * 100).toFixed(1)}% 0 0)`;
      peak.style.left = `${held * 100}%`;
      peak.style.opacity = held > 0.01 ? '1' : '0';
    },
  };
}

export function createPlayerView({ onEdit, onImport, onDemo }) {
  const timeline = createTimeline();
  const title = h('h2', { class: 'pv-title' });
  const subtitle = h('p', { class: 'pv-sub' });
  const bpmValue = h('b');
  const sigValue = h('b');
  const memValue = h('span');
  const pills = h(
    'div',
    { class: 'pv-pills' },
    h('span', { class: 'pill' }, bpmValue, ' BPM'),
    h('span', { class: 'pill' }, 'Compás ', sigValue),
    h('span', { class: 'pill dim', title: 'Memoria usada por esta canción' }, 'RAM ', memValue)
  );
  const head = h(
    'div',
    { class: 'pv-head' },
    h('div', { class: 'pv-titles' }, title, subtitle),
    pills,
    h('div', { class: 'pv-head-actions' }, iconButton({ name: 'edit', label: 'Editar canción', onClick: () => onEdit('general') }))
  );

  const barLabel = h('span', { class: 'ro-label' });
  const barValue = h('b', { class: 'ro-big' });
  const leds = h('div', { class: 'leds', 'aria-hidden': 'true' });
  const timeValue = h('b', { class: 'ro-time' });
  const durationValue = h('span', { class: 'ro-dur' });

  const nextName = h('b');
  const nextWhen = h('span');
  const nextBanner = h('div', { class: 'pv-next' }, h('span', { class: 'next-label', text: 'Siguiente' }), nextName, nextWhen);
  const readout = h(
    'div',
    { class: 'pv-status' },
    h('div', { class: 'ro-cell ro-bar' }, barLabel, barValue),
    h('div', { class: 'ro-cell ro-mid' }, leds, nextBanner),
    h('div', { class: 'ro-cell ro-clock' }, timeValue, durationValue)
  );

  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Secciones' });
  const noSections = h(
    'button',
    { type: 'button', class: 'chips-hint', onClick: () => onEdit('sections') },
    icon('plus', 16),
    'Añade secciones (Intro, Verso, Coro…) para saltar entre ellas y tener guía de voz'
  );

  const meterLeft = hbar();
  const meterRight = hbar();
  const meterLabelLeft = h('span', { class: 'hm-label' });
  const meterLabelRight = h('span', { class: 'hm-label' });
  const meters = h(
    'div',
    { class: 'hmeters', 'aria-hidden': 'true' },
    h('div', { class: 'hm-row' }, h('span', { class: 'hm-side', text: 'L' }), meterLeft.el, meterLabelLeft),
    h('div', { class: 'hm-row' }, h('span', { class: 'hm-side', text: 'R' }), meterRight.el, meterLabelRight)
  );

  const playIcon = h('span', { class: 'play-icon' }, icon('play', 34));
  const buttons = {
    prevSong: h('button', { type: 'button', class: 't-btn', 'aria-label': 'Canción anterior', title: 'Canción anterior', onClick: () => app.previousSong() }, icon('skipPrev', 22)),
    prevSection: h('button', { type: 'button', class: 't-btn', 'aria-label': 'Sección anterior', title: 'Sección anterior', onClick: () => app.previousSection() }, icon('sectionPrev', 22)),
    stop: h('button', { type: 'button', class: 't-btn', 'aria-label': 'Detener', title: 'Detener', onClick: () => app.stop() }, icon('stop', 22)),
    play: h('button', { type: 'button', class: 't-btn play', 'aria-label': 'Reproducir', title: 'Reproducir o pausar', onClick: () => app.togglePlay() }, playIcon),
    nextSection: h('button', { type: 'button', class: 't-btn', 'aria-label': 'Sección siguiente', title: 'Sección siguiente', onClick: () => app.nextSection() }, icon('sectionNext', 22)),
    nextSong: h('button', { type: 'button', class: 't-btn', 'aria-label': 'Canción siguiente', title: 'Canción siguiente', onClick: () => app.nextSong() }, icon('skipNext', 22)),
  };
  const transport = h('div', { class: 'transport' }, Object.values(buttons));

  const toggle = (name, iconName, label, onClick, text) =>
    h('button', { type: 'button', class: 'tog', 'aria-pressed': 'false', 'aria-label': label, title: label, onClick }, iconName ? icon(iconName, 18) : h('b', { class: 'tog-glyph', text }), h('span', { class: 'tog-text', text: name }));
  const toggles = {
    click: toggle('Click', 'click', 'Click durante la canción', () => app.toggleClick()),
    guide: toggle('Guía', 'guide', 'Guía de voz durante la canción', () => app.toggleGuide()),
    loop: toggle('Repetir', 'loop', 'Repetir la sección actual', () => app.toggleLoop()),
    count: toggle('Pre-conteo', null, 'Pre-conteo antes de empezar', () => app.setSetting('autoCountIn', !app.settings.autoCountIn), '1·2·3'),
    jump: h('button', { type: 'button', class: 'tog wide', title: 'Cuándo se ejecutan los saltos de sección', onClick: () => {
      const index = JUMP_MODES.findIndex((mode) => mode.id === app.settings.jumpMode);
      app.setSetting('jumpMode', JUMP_MODES[(index + 1) % JUMP_MODES.length].id);
    } }, icon('target', 18), h('span', { class: 'tog-text' })),
  };
  const toggleBar = h('div', { class: 'toggles' }, Object.values(toggles));

  const loadingText = h('span');
  const loadingBar = h('i');
  const loading = h('div', { class: 'pv-loading', hidden: true, role: 'status' }, h('div', { class: 'loading-card' }, h('b', { class: 'loading-title' }), loadingText, h('div', { class: 'progress' }, loadingBar)));
  const loadingTitle = loading.querySelector('.loading-title');

  const importButton = h('button', { type: 'button', class: 'btn primary big', onClick: onImport }, icon('upload', 20), 'Importar canción');
  const demoButton = h('button', { type: 'button', class: 'btn big', onClick: onDemo }, icon('music', 20), 'Crear canción de prueba');
  const emptyTitle = h('h3');
  const emptyText = h('p');
  const emptyActions = h('div', { class: 'empty-actions' }, importButton, demoButton);
  const empty = h('div', { class: 'pv-empty' }, h('div', { class: 'empty-art' }, icon('wave', 44)), emptyTitle, emptyText, emptyActions);

  const live = h('div', { class: 'pv-live' }, head, readout, timeline.el, chips, noSections, transport, toggleBar, meters);
  const el = h('div', { class: 'pv' }, live, empty, loading);

  let entry = null;
  let ledKey = '';
  let ledEls = [];
  let chipKey = '';
  let chipEls = [];
  let lastLoading = null;

  const renderEmpty = () => {
    const has = app.songs.size > 0;
    emptyTitle.textContent = has ? 'Elige una canción' : 'Empieza con tu primera canción';
    emptyText.textContent = has
      ? 'Toca una canción del setlist o de la biblioteca para cargarla.'
      : 'Importa las pistas de una canción (WAV, MP3, FLAC…, una carpeta o un ZIP). Click y guías se crean solos a partir del tempo.';
    emptyActions.hidden = has;
    updateVisibility();
  };

  const renderLoading = (state) => {
    lastLoading = state;
    loading.hidden = !state;
    if (!state) return;
    loadingTitle.textContent = `Cargando «${state.song.title}»`;
    loadingText.textContent = state.label ? `${state.done} de ${state.total} · ${state.label}` : 'Preparando…';
    loadingBar.style.width = `${state.total ? (state.done / state.total) * 100 : 5}%`;
    updateVisibility();
  };

  const updateVisibility = () => {
    live.hidden = !entry;
    empty.hidden = Boolean(entry) || Boolean(lastLoading);
  };

  const buildLeds = (segment) => {
    const key = `${segment.num}/${segment.den}`;
    if (key === ledKey) return;
    ledKey = key;
    leds.replaceChildren();
    ledEls = [];
    for (let beat = 1; beat <= segment.num; beat++) {
      const level = accentLevel(segment, beat);
      const led = h('i', { class: `led l${level}` });
      ledEls.push(led);
      leds.append(led);
    }
  };

  const buildChips = (player) => {
    const sections = player.sections();
    const key = sections.map((section) => `${section.name}|${section.bar}|${section.color}`).join(';');
    if (key === chipKey) return;
    chipKey = key;
    chips.replaceChildren();
    chipEls = [];
    const real = sections.filter((section) => !section.implicit);
    chips.hidden = real.length === 0;
    noSections.hidden = real.length > 0;
    for (const section of sections) {
      const chip = h(
        'button',
        { type: 'button', class: 'chip', style: { '--c': section.color }, onClick: () => app.jumpToSection(section.index) },
        h('span', { class: 'chip-name', text: section.name }),
        h('span', { class: 'chip-bar', text: `c.${section.bar}` })
      );
      chipEls.push(chip);
      chips.append(chip);
    }
  };

  const setEntry = (next) => {
    entry = next;
    ledKey = '';
    chipKey = '';
    timeline.setEntry(next);
    if (next) {
      const song = next.song;
      title.textContent = song.title;
      subtitle.textContent = [song.artist, song.key ? `Tono ${song.key}` : ''].filter(Boolean).join(' · ') || ' ';
      memValue.textContent = fmtBytes(next.player.memoryBytes());
      timeline.measure();
    }
    renderEmpty();
    updateVisibility();
  };

  const refresh = () => {
    if (!entry) return;
    title.textContent = entry.song.title;
    subtitle.textContent = [entry.song.artist, entry.song.key ? `Tono ${entry.song.key}` : ''].filter(Boolean).join(' · ') || ' ';
    memValue.textContent = fmtBytes(entry.player.memoryBytes());
    chipKey = '';
    timeline.invalidate();
  };

  const syncStatic = (snap) => {
    const player = entry.player;
    const output = app.settings.output;
    const labels = outputLabels({ ...output, mode: app.engine.effectiveMode });
    setText(meterLabelLeft, labels[0]);
    setText(meterLabelRight, labels[1]);
    const playing = snap.state === 'playing';
    if (buttons.play.__p !== playing) {
      buttons.play.__p = playing;
      playIcon.replaceChildren(icon(playing ? 'pause' : 'play', 34));
      buttons.play.setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
    }
    const states = {
      click: !player.click.def.mute,
      guide: !player.guide.def.mute,
      loop: app.loopMode,
      count: app.settings.autoCountIn,
    };
    for (const [name, on] of Object.entries(states)) {
      setClass(toggles[name], 'on', on);
      if (toggles[name].__a !== on) {
        toggles[name].__a = on;
        toggles[name].setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }
    const mode = JUMP_MODES.find((item) => item.id === app.settings.jumpMode) || JUMP_MODES[0];
    setText(toggles.jump.querySelector('.tog-text'), mode.label);
    buttons.prevSong.disabled = !app.previousSongId();
    buttons.nextSong.disabled = !app.nextSongId();
  };

  const frame = (snap, now) => {
    if (!entry || !snap) return;
    const player = entry.player;
    const [num, den] = snap.signature.split('/').map(Number);
    buildLeds({ num, den });
    buildChips(player);
    syncStatic(snap);
    const counting = snap.countIn;
    setText(barLabel, counting ? 'Pre-conteo' : 'Compás');
    setText(barValue, String(counting ? counting.beat : snap.bar));
    setClass(readout, 'counting', Boolean(counting));
    const beat = counting ? counting.beat : snap.beat;
    const fraction = counting ? 0 : snap.beatFraction;
    for (let i = 0; i < ledEls.length; i++) {
      const lit = i + 1 === beat && (snap.state === 'playing' || counting);
      const value = lit ? (1 - fraction * 0.5).toFixed(2) : '0.18';
      if (ledEls[i].__o !== value) {
        ledEls[i].__o = value;
        ledEls[i].style.opacity = value;
      }
    }
    setText(timeValue, fmtTime(snap.time));
    setText(durationValue, ` / ${fmtTime(snap.duration)}`);
    setText(bpmValue, String(Number(snap.bpm.toFixed(2))));
    setText(sigValue, snap.signature);
    const queued = snap.jump === null ? null : player.sections()[snap.jump];
    if (queued) {
      setText(nextName, queued.name);
      setText(nextWhen, app.settings.jumpMode === 'bar' ? 'al terminar este compás' : app.settings.jumpMode === 'beat' ? 'en el siguiente tiempo' : 'ahora');
      nextBanner.style.setProperty('--c', queued.color);
      setClass(nextBanner, 'none', false);
    } else if (snap.next) {
      setText(nextName, snap.next.name);
      setText(nextWhen, barsText(snap.barsToNext));
      nextBanner.style.setProperty('--c', snap.next.color);
      setClass(nextBanner, 'none', false);
    } else {
      setText(nextName, snap.section && !snap.section.implicit ? 'Última sección' : 'Sin más secciones');
      setText(nextWhen, '');
      setClass(nextBanner, 'none', true);
    }
    for (let i = 0; i < chipEls.length; i++) {
      setClass(chipEls[i], 'current', snap.section && snap.section.index === i);
      setClass(chipEls[i], 'armed', snap.jump === i);
      setClass(chipEls[i], 'upcoming', snap.next && snap.next.index === i);
    }
    const levels = app.engine.readLevels();
    meterLeft.set(levels[0], now);
    meterRight.set(levels[1], now);
    timeline.draw(snap);
  };

  app.on('loading', renderLoading);
  app.on('songs', renderEmpty);

  return { el, frame, setEntry, refresh, timeline, renderEmpty, renderLoading };
}
