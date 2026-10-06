import { h, fmtTime } from '../util.js';
import { accentLevel } from '../tempo.js';
import { app } from '../app.js';
import { platform } from '../platform.js';
import { icon, setText, setClass } from './kit.js';
import { barsText } from './player-view.js';

const HOLD_MS = 800;

export function createStage() {
  let open = false;
  let locked = false;
  let entry = null;
  let ledKey = '';
  let ledEls = [];
  let chipKey = '';
  let chipEls = [];
  let playingShown = null;
  let holdTimer = null;

  const position = h('span', { class: 'stage-pos' });
  const title = h('h2', { class: 'stage-title' });
  const artist = h('p', { class: 'stage-artist' });
  const lockButton = h('button', { type: 'button', class: 'stage-btn', 'aria-label': 'Bloquear pantalla', title: 'Bloquear pantalla' }, icon('lock', 26));
  const exitButton = h('button', { type: 'button', class: 'stage-btn', 'aria-label': 'Salir del modo escenario', title: 'Salir', onClick: () => api.close() }, icon('close', 26));
  const top = h('div', { class: 'stage-top' }, h('div', { class: 'stage-song' }, position, title, artist), h('div', { class: 'stage-top-actions' }, lockButton, exitButton));

  const sectionLabel = h('span', { class: 'stage-label' });
  const sectionName = h('b', { class: 'stage-section' });
  const nextLine = h('div', { class: 'stage-next' }, h('span', { class: 'stage-next-label', text: 'Siguiente' }), h('b', { class: 'stage-next-name' }), h('span', { class: 'stage-next-when' }));
  const nextName = nextLine.querySelector('.stage-next-name');
  const nextWhen = nextLine.querySelector('.stage-next-when');
  const leds = h('div', { class: 'leds big', 'aria-hidden': 'true' });
  const barValue = h('b');
  const timeValue = h('b');
  const bpmValue = h('b');
  const sigValue = h('b');
  const facts = h(
    'div',
    { class: 'stage-facts' },
    h('div', { class: 'fact' }, h('span', { text: 'Compás' }), barValue),
    h('div', { class: 'fact' }, h('span', { text: 'Tiempo' }), timeValue),
    h('div', { class: 'fact' }, h('span', { text: 'BPM' }), bpmValue),
    h('div', { class: 'fact' }, h('span', { text: 'Compás' }), sigValue)
  );
  const main = h('div', { class: 'stage-main' }, sectionLabel, sectionName, nextLine, leds, facts);

  const sections = h('div', { class: 'stage-sections' });

  const playIcon = h('span', {}, icon('play', 44));
  const buttons = {
    prevSong: h('button', { type: 'button', class: 't-btn xl', 'aria-label': 'Canción anterior', onClick: () => app.previousSong() }, icon('skipPrev', 28)),
    prevSection: h('button', { type: 'button', class: 't-btn xl', 'aria-label': 'Sección anterior', onClick: () => app.previousSection() }, icon('sectionPrev', 28)),
    stop: h('button', { type: 'button', class: 't-btn xl', 'aria-label': 'Detener', onClick: () => app.stop() }, icon('stop', 28)),
    play: h('button', { type: 'button', class: 't-btn xl play', 'aria-label': 'Reproducir', onClick: () => app.togglePlay() }, playIcon),
    nextSection: h('button', { type: 'button', class: 't-btn xl', 'aria-label': 'Sección siguiente', onClick: () => app.nextSection() }, icon('sectionNext', 28)),
    nextSong: h('button', { type: 'button', class: 't-btn xl', 'aria-label': 'Canción siguiente', onClick: () => app.nextSong() }, icon('skipNext', 28)),
  };
  const transport = h('div', { class: 'stage-transport' }, Object.values(buttons));

  const unlockButton = h(
    'button',
    { type: 'button', class: 'unlock-btn', 'aria-label': 'Pantalla bloqueada. Mantén pulsado para desbloquear' },
    h('span', { class: 'ring' }),
    icon('unlock', 34),
    h('span', { class: 'unlock-copy' }, h('b', { text: 'Pantalla bloqueada' }), h('span', { class: 'unlock-text', text: 'Mantén pulsado para desbloquear' }))
  );
  const veil = h('div', { class: 'stage-veil', hidden: true }, unlockButton);
  // Mientras se carga una canción que no estaba lista, el escenario sigue abierto y lo dice con su avance.
  const loadingTitle = h('b', { class: 'loading-title' });
  const loadingText = h('span');
  const loadingBar = h('i');
  const loadingBox = h('div', { class: 'stage-loading', hidden: true, role: 'status' }, h('div', { class: 'loading-card' }, loadingTitle, loadingText, h('div', { class: 'progress' }, loadingBar)));
  const el = h('div', { class: 'stage', hidden: true, role: 'dialog', 'aria-label': 'Modo escenario' }, top, main, sections, transport, veil, loadingBox);

  const setLocked = (value) => {
    locked = value;
    veil.hidden = !value;
    el.classList.toggle('locked', value);
    exitButton.hidden = value;
    lockButton.hidden = value;
  };
  lockButton.addEventListener('click', () => setLocked(true));

  const cancelHold = () => {
    window.clearTimeout(holdTimer);
    holdTimer = null;
    unlockButton.classList.remove('holding');
  };
  unlockButton.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    unlockButton.classList.add('holding');
    holdTimer = window.setTimeout(() => {
      cancelHold();
      setLocked(false);
    }, HOLD_MS);
  });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) unlockButton.addEventListener(type, cancelHold);

  const buildLeds = (segment) => {
    const key = `${segment.num}/${segment.den}`;
    if (key === ledKey) return;
    ledKey = key;
    leds.replaceChildren();
    ledEls = [];
    for (let beat = 1; beat <= segment.num; beat++) {
      const led = h('i', { class: `led l${accentLevel(segment, beat)}` });
      ledEls.push(led);
      leds.append(led);
    }
  };

  const buildSections = (player) => {
    const list = player.sections();
    const key = list.map((section) => `${section.name}|${section.bar}|${section.color}`).join(';');
    if (key === chipKey) return;
    chipKey = key;
    sections.replaceChildren();
    chipEls = [];
    const real = list.filter((section) => !section.implicit);
    sections.hidden = real.length === 0;
    sections.style.setProperty('--cols', String(Math.ceil(list.length / Math.ceil(list.length / 3))));
    for (const section of list) {
      const chip = h('button', { type: 'button', class: 'stage-chip', style: { '--c': section.color }, onClick: () => app.jumpToSection(section.index) }, section.name);
      chipEls.push(chip);
      sections.append(chip);
    }
  };

  const api = {
    el,
    get open() {
      return open;
    },
    setEntry(next) {
      entry = next;
      ledKey = '';
      chipKey = '';
      if (next) {
        title.textContent = next.song.title;
        artist.textContent = next.song.artist || ' ';
        const ids = app.activeSetlist().songIds.filter((id) => app.songs.has(id));
        const index = ids.indexOf(next.song.id);
        position.textContent = index >= 0 ? `${index + 1} / ${ids.length}` : '';
      }
    },
    refresh() {
      ledKey = '';
      chipKey = '';
      if (entry) {
        title.textContent = entry.song.title;
        artist.textContent = entry.song.artist || ' ';
      }
    },
    setLoading(state) {
      loadingBox.hidden = !state;
      if (!state) return;
      loadingTitle.textContent = `Cargando «${state.song.title}»`;
      loadingText.textContent = state.label ? `${state.done} de ${state.total} · ${state.label}` : 'Preparando…';
      loadingBar.style.width = `${state.total ? (state.done / state.total) * 100 : 5}%`;
    },
    show() {
      open = true;
      el.hidden = false;
      setLocked(false);
      document.body.classList.add('stage-open');
      platform.enterFullscreen();
      platform.syncWake();
    },
    close() {
      open = false;
      el.hidden = true;
      cancelHold();
      setLocked(false);
      document.body.classList.remove('stage-open');
      platform.exitFullscreen();
    },
    frame(snap) {
      if (!open || !entry || !snap) return;
      const player = entry.player;
      const [num, den] = snap.signature.split('/').map(Number);
      buildLeds({ num, den });
      buildSections(player);
      const counting = snap.countIn;
      const named = snap.section && !snap.section.implicit;
      setText(sectionLabel, counting ? 'Pre-conteo' : named ? 'Sección' : '');
      setText(sectionName, counting ? String(counting.beat) : named ? snap.section.name : snap.state === 'playing' ? '▶' : 'Listo');
      if (named && !counting) el.style.setProperty('--section', snap.section.color);
      else el.style.setProperty('--section', counting ? '#ffb020' : '#35c9ff');
      setClass(el, 'counting', Boolean(counting));
      if (snap.next) {
        setText(nextName, snap.next.name);
        setText(nextWhen, barsText(snap.barsToNext));
        nextLine.style.setProperty('--c', snap.next.color);
        setClass(nextLine, 'none', false);
      } else {
        setText(nextName, named ? 'Última sección' : '');
        setText(nextWhen, '');
        setClass(nextLine, 'none', !named);
      }
      const beat = counting ? counting.beat : snap.beat;
      const fraction = counting ? 0 : snap.beatFraction;
      for (let i = 0; i < ledEls.length; i++) {
        const lit = i + 1 === beat && (snap.state === 'playing' || counting);
        const value = lit ? (1 - fraction * 0.5).toFixed(2) : '0.16';
        if (ledEls[i].__o !== value) {
          ledEls[i].__o = value;
          ledEls[i].style.opacity = value;
        }
      }
      setText(barValue, String(snap.bar));
      setText(timeValue, `${fmtTime(snap.time)} / ${fmtTime(snap.duration)}`);
      setText(bpmValue, String(Number(snap.bpm.toFixed(2))));
      setText(sigValue, snap.signature);
      for (let i = 0; i < chipEls.length; i++) {
        setClass(chipEls[i], 'current', snap.section && snap.section.index === i);
        setClass(chipEls[i], 'armed', snap.jump === i);
        setClass(chipEls[i], 'upcoming', snap.next && snap.next.index === i);
      }
      const playing = snap.state === 'playing';
      if (playingShown !== playing) {
        playingShown = playing;
        playIcon.replaceChildren(icon(playing ? 'pause' : 'play', 44));
        buttons.play.setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
      }
      buttons.prevSong.disabled = !app.previousSongId();
      const nextId = app.nextSongId();
      buttons.nextSong.disabled = !nextId;
      // Punto verde: la siguiente canción ya está en memoria y entra al instante. Ámbar: se está preparando.
      setClass(buttons.nextSong, 'ready', Boolean(nextId) && app.isReady(nextId));
      setClass(buttons.nextSong, 'warming', Boolean(nextId) && app.isWarming(nextId));
    },
  };
  return api;
}
