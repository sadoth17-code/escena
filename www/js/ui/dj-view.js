// Pantalla de la pestaña DJ: "Ahora / Sigue", botones grandes, programa de participantes, canciones y MIDI.
// Solo dibuja y llama al controlador (dj.js); no toca el audio.

import { h, clamp, fmtBytes } from '../util.js';
import { icon, iconButton, openModal, confirmDialog, promptDialog, createRange, createSwitch, createSegmented, setText, setClass, dbLabel, showToast } from './kit.js';
import { fmtClock, parseClock, itemEnd } from '../dj-math.js';
import { ACTIONS, CONTINUOUS, describeTrigger, isKeyTrigger, shortTrigger } from '../dj-midi.js';
import { isAudioFile } from '../dj.js';

const STYLE_ID = 'dj-styles';

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  document.head.append(h('link', { id: STYLE_ID, rel: 'stylesheet', href: new URL('../../css/dj.css', import.meta.url).href }));
}

// Entrega el archivo al navegador como una descarga normal (carpeta Descargas o la ventana de guardar del escritorio).
function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: fileName, class: 'dj-file', tabindex: '-1' });
  document.body.append(link);
  link.click();
  link.remove();
  // El navegador lee el archivo mientras lo guarda: se suelta recién pasado un buen rato.
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
}

const fadeText = (seconds) => (seconds <= 0 ? 'corte' : `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`);
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
const STATUS_TEXT = { ready: 'Lista', loading: 'Preparando…', cold: 'Se carga al pulsar', missing: 'Falta el archivo', none: '' };

// Hace cuánto fue algo, en palabras (para la lista de programas de la nube).
function fmtAgo(time, now = Date.now()) {
  if (!time) return '';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 90) return 'hace un momento';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `hace ${days} ${days === 1 ? 'día' : 'días'}`;
  return new Date(time).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function createDjView({ dj, djCloud = null }) {
  ensureStyles();
  const state = dj.state;
  let active = false;
  let raf = 0;
  let paintQueued = 0;
  let mixingNow = false;
  const signatures = new Map();

  // Vuelve a dibujar una zona solo si lo que muestra cambió de verdad (así no se pierde el foco ni se corta un toque).
  const refresh = (name, signature, build) => {
    if (signatures.get(name) === signature) return false;
    signatures.set(name, signature);
    build();
    return true;
  };

  // ------------------------------------------------------------ avisos arriba

  const banners = h('div', { class: 'dj-banners', role: 'status', 'aria-live': 'polite' });

  // Aviso mientras se sube o se trae un programa de la nube (con «Cancelar» mientras se puede).
  function cloudBanner(busy) {
    const name = busy.name ? `«${busy.name}»` : 'el programa';
    const percent = busy.bytesTotal ? Math.min(100, Math.floor((busy.bytesDone / busy.bytesTotal) * 100)) : 0;
    const bytes = busy.bytesTotal ? `${fmtBytes(busy.bytesDone)} de ${fmtBytes(busy.bytesTotal)}` : '';
    const withFile = (text) => [busy.file, text].filter(Boolean).join(' · ');
    let title;
    let sub = busy.file;
    if (busy.kind === 'delete') title = `Eliminando ${name} de tu nube…`;
    else if (busy.kind === 'download') {
      title = busy.filesTotal ? `Trayendo ${name} de tu nube… ${Math.min(busy.filesDone, busy.filesTotal)} de ${busy.filesTotal}` : `Trayendo ${name} de tu nube…`;
      sub = withFile(bytes);
    } else if (busy.phase === 'publish') title = `Guardando ${name} en tu nube…`;
    else if (busy.phase === 'upload') {
      title = `Subiendo ${name} a tu nube… ${percent}%`;
      sub = withFile(bytes);
    } else if (busy.phase === 'hash') title = `Preparando ${name}… ${Math.min(busy.filesDone, busy.filesTotal)} de ${busy.filesTotal}`;
    else title = `Preparando ${name}…`;
    return h(
      'div',
      { class: 'dj-banner is-info', 'data-banner': 'cloud', 'data-phase': busy.phase },
      h('span', { class: 'spinner' }),
      h('b', { text: title }),
      sub ? h('span', { class: 'dj-banner-sub', text: sub }) : null,
      busy.cancelable ? h('button', { type: 'button', class: 'btn small', 'data-act': 'cloud-cancel', onClick: () => djCloud.cancel() }, 'Cancelar') : null
    );
  }

  function renderBanners() {
    const learning = state.learning;
    const importing = state.importing;
    const exporting = state.exporting;
    const cloudBusy = djCloud ? djCloud.state.busy : null;
    // Al traer un programa de la nube, su propio aviso (con los bytes) reemplaza al de «Trayendo el programa…».
    const showImporting = importing && !(cloudBusy && cloudBusy.kind === 'download');
    const cloudKey = cloudBusy && [cloudBusy.kind, cloudBusy.phase, cloudBusy.name, cloudBusy.file, cloudBusy.filesDone, cloudBusy.filesTotal, cloudBusy.bytesDone, cloudBusy.bytesTotal, cloudBusy.cancelable].join('/');
    const signature = [state.audioBlocked, state.storage, learning && learning.label, importing && `${importing.done}/${importing.total}/${importing.name}/${importing.label || ''}`, exporting && `${exporting.done}/${exporting.total}/${exporting.name}`, cloudKey].join('|');
    refresh('banners', signature, () => {
      const list = [];
      if (learning) {
        list.push(
          h(
            'div',
            { class: 'dj-banner is-learn', 'data-banner': 'learn' },
            icon('keyboard', 20),
            h('b', { text: learning.label }),
            h('button', { type: 'button', class: 'btn small', onClick: () => dj.cancelLearn() }, 'Cancelar')
          )
        );
      }
      if (state.audioBlocked) {
        list.push(
          h(
            'button',
            { type: 'button', class: 'dj-banner is-warn', 'data-banner': 'audio', onClick: () => dj.activateAudio() },
            icon('speaker', 20),
            h('b', { text: 'El navegador tiene el audio en pausa. Toca aquí para activarlo.' })
          )
        );
      }
      if (showImporting) {
        list.push(
          h(
            'div',
            { class: 'dj-banner is-info', 'data-banner': 'import' },
            h('span', { class: 'spinner' }),
            h('b', { text: `${importing.label || 'Añadiendo canciones…'} ${importing.done} de ${importing.total}` }),
            h('span', { class: 'dj-banner-sub', text: importing.name })
          )
        );
      }
      if (cloudBusy) list.push(cloudBanner(cloudBusy));
      if (exporting) {
        list.push(
          h(
            'div',
            { class: 'dj-banner is-info', 'data-banner': 'export' },
            h('span', { class: 'spinner' }),
            h('b', { text: exporting.total > 0 ? `Preparando el paquete… ${Math.min(exporting.done, exporting.total)} de ${exporting.total}` : 'Preparando el paquete…' }),
            h('span', { class: 'dj-banner-sub', text: exporting.name })
          )
        );
      }
      if (state.storage === 'memory') {
        list.push(h('div', { class: 'dj-banner is-warn', 'data-banner': 'memory' }, icon('info', 20), h('b', { text: 'Este navegador no deja guardar las canciones: se perderán al cerrar la ventana.' })));
      }
      banners.replaceChildren(...list);
    });
  }

  // ------------------------------------------------------------ AHORA

  const nowChip = h('span', { class: 'dj-chip' });
  const nowTitle = h('div', { class: 'dj-title' });
  const nowSub = h('div', { class: 'dj-sub' });
  const elapsedEl = h('span', { class: 'dj-elapsed', text: '0:00' });
  const leftEl = h('span', { class: 'dj-left' });
  const barFill = h('i', { class: 'dj-bar-fill' });
  const barZone = h('i', { class: 'dj-bar-zone' });
  const meterFill = h('i', { class: 'dj-meter-fill' });
  const nowCard = h(
    'section',
    { class: 'dj-card dj-now', 'aria-label': 'Ahora suena' },
    h('div', { class: 'dj-card-head' }, h('span', { class: 'dj-tag', text: 'Ahora' }), nowChip),
    nowTitle,
    nowSub,
    h('div', { class: 'dj-clock' }, elapsedEl, leftEl),
    h('div', { class: 'dj-bar', role: 'progressbar', 'aria-label': 'Avance de la canción' }, barZone, barFill),
    h('div', { class: 'dj-meter', 'aria-hidden': 'true' }, meterFill)
  );

  // ------------------------------------------------------------ SIGUE

  const nextDot = h('i', { class: 'dj-dot none' });
  const nextState = h('span', { class: 'dj-state' });
  const nextTitle = h('div', { class: 'dj-title is-small' });
  const nextSub = h('div', { class: 'dj-sub' });
  const nextCard = h(
    'section',
    { class: 'dj-card dj-next', 'aria-label': 'Sigue' },
    h('div', { class: 'dj-card-head' }, h('span', { class: 'dj-tag is-amber', text: 'Sigue' }), h('span', { class: 'dj-readiness' }, nextDot, nextState)),
    nextTitle,
    nextSub
  );

  // ------------------------------------------------------------ botones de mando

  const btnPrev = h('button', { type: 'button', class: 'dj-round', 'data-act': 'prev', 'aria-label': 'Anterior (mezcla)', title: 'Anterior (mezcla)', onClick: () => dj.prev() }, icon('skipPrev', 26));
  const playIcon = h('span', { class: 'dj-play-icon' });
  const btnPlay = h('button', { type: 'button', class: 'dj-round is-big', 'data-act': 'playPause', onClick: () => dj.playPause() }, playIcon);
  const nextBtnSub = h('span', { class: 'dj-next-sub' });
  const btnNext = h('button', { type: 'button', class: 'dj-next-btn', 'data-act': 'next', onClick: () => dj.next() }, h('span', { class: 'dj-next-main' }, h('b', { text: 'Siguiente' }), nextBtnSub), icon('skipNext', 30));
  const btnStop = h('button', { type: 'button', class: 'btn dj-wide', 'data-act': 'stopFade', onClick: () => dj.stopFade() }, icon('stop', 18), 'Parar con fade');
  const btnPanic = h('button', { type: 'button', class: 'btn danger dj-wide', 'data-act': 'panic', onClick: () => dj.panic() }, icon('close', 18), 'Pánico');
  const transport = h('div', { class: 'dj-transport' }, h('div', { class: 'dj-t-main' }, btnPrev, btnPlay, btnNext), h('div', { class: 'dj-t-sub' }, btnStop, btnPanic));

  // ------------------------------------------------------------ mezcla, volumen y avance automático

  const fadeRange = createRange({
    min: 0,
    max: 12,
    step: 0.5,
    value: state.settings.fade,
    label: 'Duración de la mezcla',
    format: (value) => (value <= 0 ? 'Corte' : fadeText(value)),
    onInput: (value) => dj.setFade(value),
  });
  const presets = [0, 2, 4, 8].map((seconds) =>
    h(
      'button',
      {
        type: 'button',
        class: 'dj-preset',
        'data-seconds': String(seconds),
        onClick: () => {
          fadeRange.set(seconds);
          dj.setFade(seconds);
        },
      },
      seconds === 0 ? 'Corte' : `${seconds} s`
    )
  );
  const volumeRange = createRange({
    min: 0,
    max: 100,
    step: 1,
    value: Math.round(state.settings.volume * 100),
    label: 'Volumen general',
    format: (value) => `${dbLabel(value / 100)} dB`,
    onInput: (value) => dj.setVolume(value / 100),
  });
  const pickupHint = h('div', { class: 'dj-hint is-warn', hidden: true });
  const autoSwitch = createSwitch({ value: state.settings.autoAdvance, label: 'Avance automático', onChange: (value) => dj.setAutoAdvance(value) });

  const controls = h(
    'section',
    { class: 'dj-card dj-controls', 'aria-label': 'Mezcla y volumen' },
    h('div', { class: 'dj-field' }, h('div', { class: 'dj-field-head' }, h('span', { class: 'dj-label', text: 'Mezcla entre canciones' }), h('div', { class: 'dj-presets' }, presets)), fadeRange.el),
    h('div', { class: 'dj-field' }, h('div', { class: 'dj-field-head' }, h('span', { class: 'dj-label', text: 'Volumen' })), volumeRange.el, pickupHint),
    h(
      'div',
      { class: 'dj-switch-row' },
      h('div', { class: 'dj-switch-text' }, h('strong', { text: 'Avance automático' }), h('span', { text: 'Pasa solo a la siguiente cuando termina el tiempo de cada participante (o la canción).' })),
      autoSwitch.el
    )
  );

  const deck = h('div', { class: 'dj-deck' }, nowCard, nextCard, transport, controls);

  // ------------------------------------------------------------ trabajo: programa / canciones / MIDI

  const fileInput = h('input', { type: 'file', class: 'dj-file', multiple: true, accept: 'audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.oga,.opus,.aif,.aiff', 'aria-label': 'Elegir canciones', tabindex: '-1' });
  let addToProgram = true;
  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files || []);
    fileInput.value = '';
    if (files.length) dj.importFiles(files, { addToProgram });
  });
  const pickFiles = (toProgram) => {
    addToProgram = toProgram;
    fileInput.click();
  };

  // Paquete de otra PC (.zip con canciones o .json solo con el programa).
  const packageInput = h('input', { type: 'file', class: 'dj-file', accept: '.zip,.json,application/zip,application/x-zip-compressed,application/json', 'aria-label': 'Elegir un paquete de Escena DJ', tabindex: '-1' });
  packageInput.addEventListener('change', () => {
    const file = packageInput.files && packageInput.files[0];
    packageInput.value = '';
    if (file) openImport(file);
  });
  const pickPackage = () => packageInput.click();
  const transferButton = () => h('button', { type: 'button', class: 'btn', 'data-act': 'transfer', onClick: openTransferModal }, icon('share', 18), 'Llevar a otra PC');

  const tabs = createSegmented({
    options: [
      { value: 'program', label: 'Programa', icon: 'list' },
      { value: 'library', label: 'Canciones', icon: 'music' },
      { value: 'midi', label: 'MIDI', icon: 'keyboard' },
    ],
    value: state.settings.tab,
    label: 'Sección',
    className: 'dj-tabs',
    onChange: (value) => dj.setTab(value),
  });
  const workBody = h('div', { class: 'dj-work-body' });
  const work = h('section', { class: 'dj-work', 'aria-label': 'Programa, canciones y MIDI' }, tabs.el, workBody);

  // ------------------------------------------------------------ participantes: filas y pads

  const triggersOf = (slot) => (slot ? dj.effectiveBindings()[slot] || [] : []);

  function padBadge(item) {
    const list = triggersOf(item.slot);
    const midi = list.find((trigger) => !isKeyTrigger(trigger));
    const shown = midi || list.find(isKeyTrigger);
    if (!shown) return null;
    return h('span', { class: `dj-badge${midi ? ' is-midi' : ''}`, title: list.map(describeTrigger).join(' · '), text: shortTrigger(shown) });
  }

  function itemSub(item) {
    const parts = [item.trackName];
    if (item.trackDuration) parts.push(fmtClock(item.trackDuration));
    if (item.start > 0) parts.push(`desde ${fmtClock(item.start)}`);
    if (item.maxDur > 0) parts.push(`máx. ${fmtClock(item.maxDur)}`);
    if (item.gainDb) parts.push(`${item.gainDb > 0 ? '+' : ''}${item.gainDb} dB`);
    return parts.join(' · ');
  }

  function buildRow(item) {
    return h(
      'div',
      { class: `dj-row${item.missing ? ' is-missing' : ''}`, 'data-id': item.id },
      h('span', { class: 'dj-num' }, h('b', { text: String(item.number) }), h('i', { class: 'dj-dot none' })),
      h(
        'button',
        { type: 'button', class: 'dj-row-body', title: 'Marcar como la que sigue', onClick: () => dj.cue(item.id) },
        h('span', { class: 'dj-row-title', text: item.title }),
        h('span', { class: 'dj-row-sub', text: itemSub(item) })
      ),
      padBadge(item),
      h('span', { class: 'dj-tagline', text: 'SIGUE' }),
      h('button', { type: 'button', class: 'dj-icon-btn is-up', 'aria-label': `Subir: ${item.title}`, title: 'Subir', onClick: () => dj.moveItemBy(item.id, -1) }, icon('up', 18)),
      h('button', { type: 'button', class: 'dj-icon-btn is-down', 'aria-label': `Bajar: ${item.title}`, title: 'Bajar', onClick: () => dj.moveItemBy(item.id, 1) }, icon('down', 18)),
      h('button', { type: 'button', class: 'dj-icon-btn is-play', 'data-act': 'jump', 'aria-label': `Poner ahora: ${item.title}`, title: 'Poner ahora (con mezcla)', onClick: () => dj.jump(item.id) }, icon('play', 20)),
      h('button', { type: 'button', class: 'dj-icon-btn', 'aria-label': `Editar: ${item.title}`, title: 'Editar', onClick: () => openItemEditor(item.id) }, icon('more', 20))
    );
  }

  function buildPad(item) {
    return h(
      'button',
      { type: 'button', class: `dj-pad${item.missing ? ' is-missing' : ''}`, 'data-id': item.id, 'data-act': 'jump', title: itemSub(item), onClick: () => dj.jump(item.id) },
      h('span', { class: 'dj-pad-top' }, h('b', { text: String(item.number) }), h('i', { class: 'dj-dot none' })),
      h('span', { class: 'dj-pad-name', text: item.title }),
      padBadge(item)
    );
  }

  // Estado de cada fila o pad (suena / sigue / marcada / lista) sin volver a crear nada: los toques no se pierden.
  function patchProgram() {
    const items = dj.items();
    const next = dj.nextItem();
    const nextId = next ? next.id : null;
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const el of workBody.querySelectorAll('.dj-row[data-id], .dj-pad[data-id]')) {
      const item = byId.get(el.dataset.id);
      if (!item) continue;
      setClass(el, 'is-now', item.id === state.nowId);
      setClass(el, 'is-next', item.id === nextId);
      setClass(el, 'is-cued', item.id === state.cueId);
      const status = dj.itemStatus(item);
      const dot = el.querySelector('.dj-dot');
      if (dot && dot.__s !== status) {
        dot.__s = status;
        dot.className = `dj-dot ${status}`;
      }
    }
  }

  function emptyProgram() {
    return h(
      'div',
      { class: 'dj-empty' },
      icon('disc', 40),
      h('h3', { text: 'Arma tu programa' }),
      h('p', { text: 'Añade las canciones de la boda, el desfile o el evento. Cada una es un participante o un momento: la mezcla entre ellas es suave, como la de un DJ.' }),
      h(
        'ol',
        { class: 'dj-steps' },
        h('li', { text: 'Añade las canciones (puedes elegir muchas a la vez).' }),
        h('li', { text: 'Ponles el nombre del participante y, si quieres, desde qué segundo empiezan y cuánto duran.' }),
        h('li', { text: 'Conecta tu controlador en la pestaña MIDI y asigna Siguiente y los pads.' })
      ),
      h('button', { type: 'button', class: 'btn primary big', 'data-act': 'add', onClick: () => pickFiles(true) }, icon('plus', 20), 'Añadir canciones')
    );
  }

  function renderProgram() {
    const items = dj.items();
    const program = dj.program();
    const signature = ['program', state.structure, state.programId, state.settings.layout].join('|');
    refresh('work', signature, () => {
      const select = h(
        'select',
        { class: 'select dj-program-select', 'aria-label': 'Programa' },
        state.programs.map((entry) => h('option', { value: entry.id, text: entry.name, selected: entry.id === state.programId }))
      );
      select.addEventListener('change', () => dj.selectProgram(select.value));
      const layout = createSegmented({
        options: [
          { value: 'list', label: 'Lista', icon: 'list' },
          { value: 'pads', label: 'Pads', icon: 'pads' },
        ],
        value: state.settings.layout,
        label: 'Vista',
        onChange: (value) => dj.setLayout(value),
      });
      const head = h(
        'div',
        { class: 'dj-program-head' },
        select,
        h(
          'div',
          { class: 'dj-program-tools' },
          iconButton({ name: 'plus', label: 'Programa nuevo', onClick: newProgram }),
          iconButton({ name: 'edit', label: 'Cambiar el nombre del programa', onClick: renameProgram }),
          iconButton({ name: 'trash', label: 'Borrar el programa', onClick: deleteProgram })
        )
      );
      const actions = h(
        'div',
        { class: 'dj-program-actions' },
        h('div', { class: 'dj-action-group' }, h('button', { type: 'button', class: 'btn primary', 'data-act': 'add', onClick: () => pickFiles(true) }, icon('plus', 18), 'Añadir canciones'), transferButton()),
        layout.el
      );
      const missing = items.filter((item) => item.missing);
      const missingNote = missing.length
        ? h(
            'div',
            { class: 'dj-banner is-warn dj-missing-note', 'data-banner': 'missing' },
            icon('info', 20),
            h('b', {
              text:
                missing.length === 1
                  ? 'A 1 participante le falta su archivo. Añade la canción con «Añadir canciones»: si se llama como el archivo original, se vincula sola.'
                  : `A ${missing.length} participantes les falta su archivo. Añade las canciones con «Añadir canciones»: las que se llamen como los archivos originales se vinculan solas.`,
            }),
            h('button', { type: 'button', class: 'btn small', 'data-act': 'add-missing', onClick: () => pickFiles(true) }, 'Añadir')
          )
        : null;
      let body;
      let hint = null;
      if (!items.length) body = emptyProgram();
      else if (state.settings.layout === 'pads') {
        body = h('div', { class: 'dj-pads' }, items.map(buildPad));
        hint = 'Toca un pad para mezclar a ese participante al instante.';
      } else {
        body = h('div', { class: 'dj-list' }, items.map(buildRow));
        hint = 'Toca un nombre para marcarlo como «Sigue» (queda cargado y listo). El botón ▶ lo mezcla ahora.';
      }
      workBody.replaceChildren(...[head, actions, missingNote, hint ? h('p', { class: 'dj-hint' }, hint) : null, body].filter(Boolean));
      if (program) workBody.dataset.program = program.id;
    });
    patchProgram();
  }

  // ------------------------------------------------------------ canciones

  function renderLibrary() {
    const signature = ['library', state.structure, state.tracks.length, state.programs.length].join('|');
    refresh('work', signature, () => {
      const usage = new Map();
      for (const program of state.programs) for (const item of program.items) usage.set(item.trackId, (usage.get(item.trackId) || 0) + 1);
      const storage = h('p', { class: 'dj-hint' });
      dj.estimate()
        .then((estimate) => {
          if (estimate && estimate.quota) storage.textContent = `Espacio usado en este dispositivo: ${fmtBytes(estimate.usage)} de ${fmtBytes(estimate.quota)} disponibles.`;
        })
        .catch(() => {});
      const head = h('div', { class: 'dj-program-actions' }, h('div', { class: 'dj-action-group' }, h('button', { type: 'button', class: 'btn primary', 'data-act': 'add', onClick: () => pickFiles(false) }, icon('upload', 18), 'Añadir canciones'), transferButton()));
      const rows = state.tracks.map((track) =>
        h(
          'div',
          { class: 'dj-row is-library', 'data-track': track.id },
          h('span', { class: 'dj-num' }, icon('music', 18)),
          h(
            'div',
            { class: 'dj-row-body is-static' },
            h('span', { class: 'dj-row-title', text: track.name }),
            h('span', { class: 'dj-row-sub', text: [track.duration ? fmtClock(track.duration) : null, fmtBytes(track.size), usage.get(track.id) ? `en ${plural(usage.get(track.id), 'participante', 'participantes')}` : 'sin usar'].filter(Boolean).join(' · ') })
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'dj-icon-btn',
              'aria-label': `Añadir al programa: ${track.name}`,
              title: 'Añadir al programa actual',
              onClick: () => {
                dj.addItem(track.id);
                dj.setTab('program');
              },
            },
            icon('plus', 20)
          ),
          h('button', { type: 'button', class: 'dj-icon-btn', 'aria-label': `Borrar: ${track.name}`, title: 'Borrar de la biblioteca', onClick: () => removeTrack(track) }, icon('trash', 20))
        )
      );
      const body = rows.length
        ? h('div', { class: 'dj-list' }, rows)
        : h('div', { class: 'dj-empty' }, icon('music', 40), h('h3', { text: 'Todavía no hay canciones' }), h('p', { text: 'Añade archivos MP3, WAV, M4A o FLAC. También puedes arrastrarlos a esta pantalla. Quedan guardados en este dispositivo y funcionan sin internet.' }));
      workBody.replaceChildren(head, body, storage);
    });
  }

  // ------------------------------------------------------------ MIDI

  const monitor = h('div', { class: 'dj-monitor', 'aria-live': 'off' });
  const updateMonitor = () => {
    setText(monitor, state.midi.last || 'Todavía no llegó ninguna señal. Pulsa un pad o mueve una perilla.');
    setClass(monitor, 'is-idle', !state.midi.last);
    const waiting = state.midi.pickup !== null && state.midi.pickup !== undefined;
    pickupHint.hidden = !waiting;
    if (waiting) setText(pickupHint, `Mueve la perilla hasta el volumen actual para tomar el control (está en ${Math.round(state.midi.pickup * 100)}%).`);
  };

  function chips(action) {
    const list = dj.effectiveBindings()[action] || [];
    return list.map((trigger) =>
      h(
        'span',
        { class: `dj-chiptag${isKeyTrigger(trigger) ? ' is-key' : ' is-midi'}` },
        h('span', { text: describeTrigger(trigger) }),
        h('button', { type: 'button', class: 'dj-chip-x', 'aria-label': `Quitar ${describeTrigger(trigger)}`, title: 'Quitar', onClick: () => dj.unassign(action, trigger) }, icon('close', 14))
      )
    );
  }

  function midiStatusBlock() {
    const status = state.midi.status;
    const inputs = state.midi.inputs;
    if (!state.midi.supported || status === 'unsupported') {
      return h(
        'div',
        { class: 'notice info' },
        icon('info', 22),
        h('div', {}, h('b', { text: 'Este navegador no permite controladores MIDI' }), h('p', { text: 'Funciona en Chrome o Edge (computador o Android) y en Firefox. No existe en Safari ni en iPhone/iPad. Mientras tanto puedes usar la pantalla y el teclado.' }))
      );
    }
    if (status === 'ready') {
      return h(
        'div',
        { class: 'dj-midi-status is-ok' },
        h('div', {}, h('b', { text: inputs.length ? `Conectado: ${inputs.join(', ')}` : 'MIDI activado, pero no veo ningún controlador' }), inputs.length ? null : h('p', { class: 'dj-hint', text: 'Conéctalo por USB (o Bluetooth) y enciéndelo. Si no aparece, desconéctalo y vuelve a conectarlo.' })),
        h('button', { type: 'button', class: 'btn small', onClick: () => dj.disableMidi() }, 'Desactivar')
      );
    }
    if (status === 'denied') {
      return h(
        'div',
        { class: 'notice warn' },
        icon('info', 22),
        h(
          'div',
          {},
          h('b', { text: 'El navegador bloqueó el MIDI' }),
          h('p', { text: 'Toca el candado junto a la dirección de la página, permite «Dispositivos MIDI» y vuelve a pulsar Activar.' }),
          h('button', { type: 'button', class: 'btn small', onClick: () => dj.enableMidi() }, 'Activar MIDI')
        )
      );
    }
    return h(
      'div',
      { class: 'dj-midi-status' },
      h('div', {}, h('b', { text: status === 'asking' ? 'Esperando el permiso del navegador…' : 'MIDI apagado' }), h('p', { class: 'dj-hint', text: 'Actívalo para usar los pads, botones, perillas y faders de tu controlador.' })),
      h('button', { type: 'button', class: 'btn primary', 'data-act': 'midi-on', disabled: status === 'asking', onClick: () => dj.enableMidi() }, icon('keyboard', 18), 'Activar MIDI')
    );
  }

  function actionRow(action) {
    const learningThis = Boolean(state.learning && state.learning.action === action.id);
    return h(
      'div',
      { class: `dj-map-row${learningThis ? ' is-learning' : ''}`, 'data-action': action.id },
      h('div', { class: 'dj-map-name' }, h('b', { text: action.name }), h('span', { text: action.detail })),
      h('div', { class: 'dj-map-chips' }, chips(action.id)),
      h(
        'button',
        { type: 'button', class: `btn small${learningThis ? ' primary' : ''}`, 'data-act': 'learn', onClick: () => (learningThis ? dj.cancelLearn() : dj.learn(action.id)) },
        learningThis ? 'Esperando…' : CONTINUOUS.has(action.id) ? 'Asignar perilla' : 'Asignar'
      )
    );
  }

  function renderMidi() {
    const signature = ['midi', state.structure, state.midi.status, state.midi.inputs.join(','), state.learning && state.learning.action, dj.items().length].join('|');
    refresh('work', signature, () => {
      const total = dj.items().length;
      const pads = h(
        'div',
        { class: 'dj-pads-box' },
        h('h4', { class: 'sub', text: 'Pads de los participantes' }),
        h('p', {
          class: 'dj-hint',
          text: total
            ? `Cada pad lleva a un participante del programa (${plural(total, 'participante', 'participantes')}): el pad 1 al primero, el 2 al segundo… Al pulsarlo la música mezcla a esa canción. Con el teclado ya funcionan las teclas 1 a 9.`
            : 'Primero añade canciones al programa y luego asigna un pad a cada participante.',
        }),
        h(
          'div',
          { class: 'dj-pads-actions' },
          h('button', { type: 'button', class: 'btn', 'data-act': 'learn-slots', disabled: !total, onClick: () => dj.learnSlots(1) }, icon('pads', 18), 'Asignar en orden'),
          h('button', { type: 'button', class: 'btn', 'data-act': 'learn-notes', disabled: !total, onClick: () => dj.learnSlotsByNote() }, icon('music', 18), 'Pulsar el pad 1 y seguir solo'),
          h('button', { type: 'button', class: 'btn', onClick: () => dj.clearPads() }, 'Quitar los pads')
        ),
        h('p', { class: 'dj-hint', text: '«Asignar en orden» te pide un pad para cada participante. «Pulsar el pad 1» sirve si tus pads mandan notas consecutivas: pulsas el primero y el resto se reparte solo.' })
      );
      workBody.replaceChildren(
        midiStatusBlock(),
        h('div', { class: 'dj-monitor-box' }, h('span', { class: 'dj-label', text: 'Última señal recibida' }), monitor),
        h('h4', { class: 'sub', text: 'Botones' }),
        h('div', { class: 'dj-map' }, ACTIONS.map(actionRow)),
        pads,
        h('div', { class: 'dj-keys-help' }, h('b', { text: 'Teclado: ' }), 'Espacio = reproducir/pausa · → o Av Pág = siguiente · ← o Re Pág = anterior · 1 a 9 = participantes 1 a 9.'),
        h('button', { type: 'button', class: 'btn small', onClick: resetBindings }, 'Restablecer todas las asignaciones')
      );
      updateMonitor();
    });
  }

  function renderWork() {
    const tab = state.settings.tab;
    if (tab === 'library') renderLibrary();
    else if (tab === 'midi') renderMidi();
    else renderProgram();
    tabs.set(tab);
  }

  // ------------------------------------------------------------ diálogos

  async function newProgram() {
    const name = await promptDialog({ title: 'Programa nuevo', label: 'Nombre (boda, desfile, cumpleaños…)', value: `Programa ${state.programs.length + 1}`, confirm: 'Crear' });
    if (name) dj.createProgram(name);
  }

  async function renameProgram() {
    const program = dj.program();
    if (!program) return;
    const name = await promptDialog({ title: 'Nombre del programa', label: 'Nombre', value: program.name, confirm: 'Guardar' });
    if (name) dj.renameProgram(program.id, name);
  }

  async function deleteProgram() {
    const program = dj.program();
    if (!program) return;
    const ok = await confirmDialog({ title: 'Borrar el programa', message: `¿Borrar «${program.name}»? Las canciones siguen en la biblioteca.`, confirm: 'Borrar', danger: true });
    if (ok) dj.deleteProgram(program.id);
  }

  async function removeTrack(track) {
    const ok = await confirmDialog({ title: 'Borrar la canción', message: `¿Borrar «${track.name}» de este dispositivo? También se quita de los programas donde esté.`, confirm: 'Borrar', danger: true });
    if (ok) dj.removeTrack(track.id);
  }

  async function resetBindings() {
    const ok = await confirmDialog({ title: 'Restablecer asignaciones', message: 'Se borran todos los botones y pads asignados y vuelven las teclas de siempre.', confirm: 'Restablecer', danger: true });
    if (ok) dj.resetBindings();
  }

  function openItemEditor(itemId) {
    const find = () => dj.items().find((entry) => entry.id === itemId);
    const item = find();
    if (!item) return null;
    const label = h('input', { type: 'text', class: 'input', value: item.label, placeholder: item.trackName, maxlength: '80', autocomplete: 'off', 'aria-label': 'Nombre del participante o momento', 'data-field': 'label' });
    const start = h('input', { type: 'text', class: 'input num', value: fmtClock(item.start), inputmode: 'decimal', autocomplete: 'off', 'aria-label': 'Empieza en', 'data-field': 'start' });
    const max = h('input', { type: 'text', class: 'input num', value: item.maxDur > 0 ? fmtClock(item.maxDur) : '', placeholder: 'Toda la canción', inputmode: 'decimal', autocomplete: 'off', 'aria-label': 'Duración máxima', 'data-field': 'max' });
    const gain = createRange({
      min: -12,
      max: 6,
      step: 0.5,
      value: item.gainDb,
      label: 'Volumen de esta canción',
      format: (value) => `${value > 0 ? '+' : ''}${value} dB`,
      onInput: (value) => dj.updateItem(itemId, { gainDb: value }),
    });
    label.addEventListener('change', () => dj.updateItem(itemId, { label: label.value }));
    start.addEventListener('change', () => {
      const seconds = parseClock(start.value);
      if (Number.isNaN(seconds)) {
        start.value = fmtClock(find()?.start || 0);
        return;
      }
      dj.updateItem(itemId, { start: seconds });
      start.value = fmtClock(find()?.start || 0);
    });
    max.addEventListener('change', () => {
      if (!max.value.trim()) {
        dj.updateItem(itemId, { maxDur: 0 });
        return;
      }
      const seconds = parseClock(max.value);
      if (Number.isNaN(seconds)) {
        const current = find();
        max.value = current && current.maxDur > 0 ? fmtClock(current.maxDur) : '';
        return;
      }
      dj.updateItem(itemId, { maxDur: seconds });
      max.value = seconds > 0 ? fmtClock(seconds) : '';
    });
    const padBox = h('div', { class: 'dj-modal-pad' });
    let learning = false;
    const renderPad = () => {
      const current = find();
      if (!current) return;
      const list = triggersOf(current.slot);
      padBox.replaceChildren(
        h(
          'div',
          { class: 'dj-map-chips' },
          list.length
            ? list.map((trigger) =>
                h(
                  'span',
                  { class: `dj-chiptag${isKeyTrigger(trigger) ? ' is-key' : ' is-midi'}` },
                  h('span', { text: describeTrigger(trigger) }),
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'dj-chip-x',
                      'aria-label': `Quitar ${describeTrigger(trigger)}`,
                      onClick: () => {
                        dj.unassign(current.slot, trigger);
                        renderPad();
                      },
                    },
                    icon('close', 14)
                  )
                )
              )
            : h('span', { class: 'dj-hint', text: 'Sin pad ni tecla asignados' })
        ),
        h(
          'button',
          {
            type: 'button',
            class: `btn small${learning ? ' primary' : ''}`,
            'data-act': 'learn-item',
            onClick: async () => {
              if (learning) {
                dj.cancelLearn();
                return;
              }
              learning = true;
              renderPad();
              try {
                await dj.learn(current.slot, { replace: true });
              } finally {
                learning = false;
                renderPad();
              }
            },
          },
          learning ? 'Pulsa el pad o la tecla… (Esc cancela)' : 'Asignar pad o tecla'
        )
      );
    };
    renderPad();
    const body = h(
      'div',
      { class: 'dj-editor' },
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Participante o momento' }), label, h('span', { class: 'field-hint', text: 'Por ejemplo «Entrada de los novios». Si lo dejas vacío se muestra el nombre de la canción.' })),
      h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Canción' }), h('div', { class: 'dj-readonly', text: item.trackName + (item.trackDuration ? ` · ${fmtClock(item.trackDuration)}` : '') })),
      h(
        'div',
        { class: 'dj-two' },
        h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Empieza en' }), start, h('span', { class: 'field-hint', text: 'Para saltarte la introducción (m:ss).' })),
        h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Dura como máximo' }), max, h('span', { class: 'field-hint', text: 'Vacío = toda la canción.' }))
      ),
      h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Volumen de esta canción' }), gain.el, h('span', { class: 'field-hint', text: 'Sube o baja solo esta canción si suena más fuerte o más suave que las demás.' })),
      h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Pad o tecla' }), padBox),
      h(
        'div',
        { class: 'dj-editor-tools' },
        h('button', { type: 'button', class: 'btn small', onClick: () => dj.moveItemBy(itemId, -1) }, icon('up', 16), 'Subir'),
        h('button', { type: 'button', class: 'btn small', onClick: () => dj.moveItemBy(itemId, 1) }, icon('down', 16), 'Bajar'),
        h(
          'button',
          {
            type: 'button',
            class: 'btn small danger',
            'data-act': 'remove-item',
            onClick: () => {
              if (dj.removeItem(itemId)) modal.close();
            },
          },
          icon('trash', 16),
          'Quitar del programa'
        )
      )
    );
    const modal = openModal({
      title: `Participante ${item.number}`,
      size: 'md',
      className: 'dj-modal',
      body,
      actions: [{ label: 'Listo', kind: 'primary', icon: 'check', onClick: (api) => api.close() }],
      onClose: () => {
        if (learning) dj.cancelLearn();
      },
    });
    return modal;
  }

  // ------------------------------------------------------------ llevar el programa a otra PC

  const choice = ({ act, iconName, title, detail, onClick }) => {
    const detailEl = h('span', { class: 'dj-choice-detail', text: detail });
    const el = h('button', { type: 'button', class: 'dj-choice', 'data-act': act, onClick }, icon(iconName, 24), h('span', { class: 'dj-choice-text' }, h('b', { text: title }), detailEl));
    return { el, setDetail: (text) => setText(detailEl, text) };
  };

  function openTransferModal() {
    const scope = { value: 'current' };
    let modal = null;
    let offCloud = () => {};
    const warn = h('p', { class: 'dj-hint is-warn', 'data-role': 'transfer-warn', hidden: true });
    const run = async (audio) => {
      if (modal) modal.close();
      const out = await dj.exportPackage({ scope: scope.value, audio });
      if (!out) return;
      downloadBlob(out.blob, out.fileName);
      showToast({ message: `Listo: «${out.fileName}» (${fmtBytes(out.bytes)}). Cópialo a la otra PC y ábrelo allá en «Llevar a otra PC» > «Elegir un paquete…».`, duration: 10000 });
    };
    const full = choice({ act: 'export-full', iconName: 'download', title: 'Paquete completo (.zip)', detail: '', onClick: () => run(true) });
    const light = choice({
      act: 'export-light',
      iconName: 'file',
      title: 'Solo el programa (.json)',
      detail: 'Archivo liviano, sin audio. En la otra PC cada participante espera su canción y se vincula por el nombre del archivo cuando la añades.',
      onClick: () => run(false),
    });
    const pick = choice({
      act: 'import-pick',
      iconName: 'upload',
      title: 'Elegir un paquete…',
      detail: 'Un archivo .zip o .json hecho con «Llevar a otra PC». También puedes arrastrarlo a esta pantalla.',
      onClick: () => {
        if (modal) modal.close();
        pickPackage();
      },
    });
    const update = () => {
      const preview = dj.previewPackage(scope.value);
      const empty = !preview.participants;
      full.setDetail(`Canciones, orden, tiempos, pads y mezcla en un solo archivo: ${plural(preview.participants, 'participante', 'participantes')}, ${plural(preview.withAudio, 'canción', 'canciones')}, unos ${fmtBytes(preview.bytes)}.`);
      full.el.disabled = empty || preview.tooBig || !preview.withAudio;
      light.el.disabled = empty;
      const notes = [];
      if (empty) notes.push('Este programa está vacío.');
      if (preview.tooBig) notes.push('Estas canciones pesan más de 4 GB y no caben en un solo paquete: lleva un programa a la vez, o usa «Solo el programa» y copia las canciones aparte.');
      if (preview.waiting) notes.push(`${plural(preview.waiting, 'canción', 'canciones')} ${preview.waiting === 1 ? 'todavía espera' : 'todavía esperan'} su archivo en esta PC y ${preview.waiting === 1 ? 'viaja' : 'viajan'} sin audio.`);
      if (preview.skipped) notes.push(`${plural(preview.skipped, 'participante', 'participantes')} sin canción ${preview.skipped === 1 ? 'no se incluye' : 'no se incluyen'}.`);
      warn.hidden = !notes.length;
      setText(warn, notes.join(' '));
    };
    const scopeSeg =
      state.programs.length > 1
        ? createSegmented({
            options: [
              { value: 'current', label: 'Este programa' },
              { value: 'all', label: `Todos (${state.programs.length})` },
            ],
            value: 'current',
            label: 'Qué llevar',
            className: 'dj-scope',
            onChange: (value) => {
              scope.value = value;
              update();
            },
          })
        : null;

    // ---- Con tu nube: subir este programa y traer los que hay en la nube (desde cualquier dispositivo conectado a ella).
    const cloudBox = djCloud ? h('section', { class: 'dj-cloud', 'data-role': 'cloud' }) : null;
    const runUpload = async (asNew) => {
      if (modal) modal.close();
      await djCloud.upload(dj.program().id, { asNew });
    };
    const getFromCloud = async (entry) => {
      const found = await djCloud.inspect(entry);
      if (!found) return;
      if (modal) modal.close();
      openImportModal(found, null);
    };
    const removeFromCloud = async (entry) => {
      const ok = await confirmDialog({
        title: 'Eliminar de la nube',
        message: `¿Eliminar «${entry.name}» de tu nube? Se borra para todos los equipos conectados; los que ya lo trajeron conservan su copia.`,
        confirm: 'Eliminar',
        danger: true,
      });
      if (ok) await djCloud.remove(entry);
    };
    const cloudRow = (entry, busy) => {
      const mine = state.programs.some((item) => item.cloud && item.cloud.endpoint === djCloud.endpoint && item.cloud.id === entry.id);
      const meta = [plural(entry.participants, 'participante', 'participantes'), plural(entry.songs, 'canción', 'canciones'), fmtBytes(entry.size), entry.by, fmtAgo(entry.updatedAt)].filter(Boolean).join(' · ');
      const trash = djCloud.canDelete ? iconButton({ name: 'trash', label: `Eliminar «${entry.name}» de la nube`, onClick: () => removeFromCloud(entry) }) : null;
      if (trash) trash.dataset.act = 'cloud-delete';
      return h(
        'li',
        { class: `dj-cloudrow${mine ? ' is-mine' : ''}`, 'data-id': entry.id },
        h('div', { class: 'dj-cloudrow-text' }, h('b', { text: entry.name }), h('span', { class: 'dj-cloudrow-meta', text: meta })),
        h('button', { type: 'button', class: 'btn small', 'data-act': 'cloud-get', disabled: busy, onClick: () => getFromCloud(entry) }, icon('download', 16), 'Traer'),
        trash
      );
    };
    const drawCloud = () => {
      if (!cloudBox) return;
      const cs = djCloud.state;
      const busy = Boolean(cs.busy);
      const parts = [h('h4', { class: 'sub', text: 'Con tu nube' })];
      if (!djCloud.connected) {
        parts.push(h('p', { class: 'dj-hint', 'data-role': 'cloud-off', text: 'Conecta tu nube en la pestaña Nube para subir tus programas y traerlos en cualquier otro dispositivo.' }));
        cloudBox.replaceChildren(...parts);
        return;
      }
      const current = dj.program();
      const preview = dj.previewPackage('current');
      const status = current ? djCloud.statusOf(current) : null;
      const remote = status && status.remote;
      const notes = [];
      if (status && status.linked) {
        if (status.gone) notes.push('Este programa estuvo en tu nube, pero ya no está: al subirlo se vuelve a crear.');
        else if (status.behind) notes.push(`La nube tiene una versión más nueva de este programa${remote && remote.by ? `, subida por ${remote.by}` : ''}. Tráela para ponerlo al día.`);
        if (status.localChanges && !status.gone) notes.push('Tienes cambios en este programa que todavía no están en la nube.');
        if (!status.gone && !status.behind && !status.localChanges && remote) notes.push(`Este programa está en tu nube y al día${remote.by ? ` (subido por ${remote.by}, ${fmtAgo(remote.updatedAt)})` : ''}.`);
      }
      if (notes.length) parts.push(h('p', { class: 'dj-hint', 'data-role': 'cloud-status', text: notes.join(' ') }));
      const updating = Boolean(status && status.linked && !status.gone);
      const upload = choice({
        act: 'cloud-upload',
        iconName: 'cloud',
        title: current ? (updating ? `Subir los cambios de «${current.name}»` : `Subir «${current.name}» a la nube`) : 'Subir a la nube',
        detail: '',
        onClick: () => runUpload(false),
      });
      let why = '';
      if (!djCloud.canUpload) why = djCloud.canRead && !djCloud.accountCanUpload ? 'Tu cuenta solo puede traer programas de la nube. El propietario puede darte permiso de editor para subirlos.' : 'Verifica tu acceso con internet (pestaña Nube) para subir programas.';
      else if (!preview.withAudio) why = 'Este programa no tiene canciones con audio en este dispositivo: añádelas primero.';
      else if (state.transport === 'playing') why = 'Detén la música para subir el programa.';
      upload.setDetail(why || `${plural(preview.participants, 'participante', 'participantes')}, ${plural(preview.withAudio, 'canción', 'canciones')}: unos ${fmtBytes(preview.bytes)}. Las canciones que ya estén en tu nube no se vuelven a subir.`);
      upload.el.disabled = busy || Boolean(why);
      parts.push(upload.el);
      if (updating) {
        parts.push(h('button', { type: 'button', class: 'btn small', 'data-act': 'cloud-upload-new', disabled: busy || Boolean(why), onClick: () => runUpload(true) }, 'Subir como programa nuevo'));
      }
      parts.push(
        h(
          'div',
          { class: 'dj-cloud-head' },
          h('h5', { text: 'En tu nube' }),
          h('button', { type: 'button', class: 'btn small', 'data-act': 'cloud-refresh', 'aria-busy': cs.loading ? 'true' : 'false', onClick: () => djCloud.refresh() }, cs.loading ? 'Consultando…' : 'Actualizar')
        )
      );
      if (cs.error) parts.push(h('p', { class: 'dj-hint is-warn', 'data-role': 'cloud-error', text: cs.error }));
      else if (!cs.loaded) parts.push(h('p', { class: 'dj-hint', 'data-role': 'cloud-loading', text: 'Consultando tu nube…' }));
      else if (!cs.programs.length) parts.push(h('p', { class: 'dj-hint', 'data-role': 'cloud-empty', text: 'Todavía no hay programas del DJ en tu nube.' }));
      else parts.push(h('ul', { class: 'dj-cloudlist', 'data-role': 'cloud-list' }, cs.programs.map((entry) => cloudRow(entry, busy))));
      cloudBox.replaceChildren(...parts);
    };
    // Al redibujar se conserva el foco en el mismo botón (o, si ya no existe, en la ventana): así el teclado sigue funcionando y Escape cierra.
    const renderCloud = () => {
      if (!cloudBox) return;
      const active = document.activeElement;
      const spot = active && cloudBox.contains(active) ? { act: active.dataset.act || '', id: (active.closest('[data-id]') || { dataset: {} }).dataset.id || '' } : null;
      drawCloud();
      if (!spot || !modal) return;
      const next = spot.act ? cloudBox.querySelector(`${spot.id ? `[data-id="${spot.id}"] ` : ''}[data-act="${spot.act}"]`) : null;
      if (next && !next.disabled) next.focus({ preventScroll: true });
      else modal.el.focus({ preventScroll: true });
    };

    const body = h(
      'div',
      { class: 'dj-transfer-body' },
      h('p', { class: 'dj-hint', text: 'Las canciones del DJ se guardan en este dispositivo. Para usar el mismo programa en otro, súbelo a tu nube de Escena, o crea un archivo y cópialo (USB, correo…): con el archivo las canciones no se suben a internet.' }),
      cloudBox,
      h('h4', { class: 'sub', text: 'Llevar a otra PC' }),
      scopeSeg ? scopeSeg.el : null,
      full.el,
      light.el,
      warn,
      h('h4', { class: 'sub', text: 'Traer a esta PC' }),
      pick.el
    );
    modal = openModal({ title: 'Llevar el programa a otra PC', size: 'md', className: 'dj-modal dj-transfer', body, onClose: () => offCloud(), actions: [{ label: 'Cerrar', onClick: (api) => api.close() }] });
    update();
    if (djCloud) {
      renderCloud();
      offCloud = djCloud.on('change', renderCloud);
      // Se consulta la nube al abrir: pudo cambiar desde otro dispositivo.
      if (djCloud.connected) djCloud.refresh();
    }
    return modal;
  }

  async function openImport(file) {
    const result = await dj.openPackage(file);
    if (result) openImportModal(result, file);
  }

  // Qué trae un paquete (archivo) o un programa de la nube, y qué pasará al traerlo. `linked` (solo nube): el programa de
  // este dispositivo que ya viene de ese mismo programa de la nube.
  function openImportModal({ opened, summary, linked = null }, file) {
    const fromCloud = summary.kind === 'cloud';
    const playing = state.transport === 'playing';
    let useSettings = summary.hasSettings && !(summary.hasBindings && summary.customBindings);
    const shown = summary.programs.slice(0, 8);
    const facts = [];
    if (summary.withAudio) facts.push(h('li', { 'data-fact': 'audio' }, h('b', { text: String(summary.withAudio) }), ` ${summary.withAudio === 1 ? 'canción nueva' : 'canciones nuevas'} con audio · ${fmtBytes(summary.audioBytes)} · se guardan en este dispositivo`));
    if (summary.reused) facts.push(h('li', { 'data-fact': 'reused' }, h('b', { text: String(summary.reused) }), ` ${summary.reused === 1 ? 'ya estaba' : 'ya estaban'} en esta PC · no se repiten`));
    if (summary.linked) facts.push(h('li', { 'data-fact': 'linked' }, h('b', { text: String(summary.linked) }), ` sin audio en ${fromCloud ? 'la nube' : 'el paquete'}, pero ya ${summary.linked === 1 ? 'tienes un archivo con ese nombre' : 'tienes archivos con esos nombres'} · se vinculan solas`));
    if (summary.waiting) facts.push(h('li', { 'data-fact': 'waiting' }, h('b', { text: String(summary.waiting) }), ` sin audio · ${summary.waiting === 1 ? 'queda esperando su archivo' : 'quedan esperando su archivo'}: al añadirlo con «Añadir canciones» se vincula por el nombre`));
    const source = fromCloud ? 'de la nube' : 'del paquete';
    const settingsRow = summary.hasSettings
      ? (() => {
          const toggle = createSwitch({ value: useSettings, label: `Usar también la mezcla y los pads ${source}`, onChange: (value) => (useSettings = value) });
          const detail = summary.hasBindings ? (summary.customBindings ? 'Reemplaza los pads y las teclas que tienes asignados en este equipo.' : `Los pads y las teclas quedan asignados igual que en ${fromCloud ? 'el equipo que lo subió' : 'la otra PC'}.`) : 'Duración de la mezcla y avance automático.';
          return h('div', { class: 'dj-switch-row', 'data-role': 'import-settings' }, h('div', { class: 'dj-switch-text' }, h('strong', { text: `Usar también la mezcla y los pads ${source}` }), h('span', { text: detail })), toggle.el);
        })()
      : null;

    // Si ese programa ya está en este dispositivo (se trajo o se subió desde aquí), se puede actualizar en vez de duplicarlo.
    let mode = 'new';
    let modeBlock = null;
    let modeNote = null;
    let modalApi = null;
    if (fromCloud && linked) {
      const changed = Boolean(djCloud && djCloud.statusOf(linked).localChanges);
      const canUpdate = state.transport === 'idle';
      const describe = () => {
        if (mode === 'update') return `Se reemplazan los participantes de «${linked.name}» por los de la nube.${changed ? ' Los cambios de este equipo que no subiste se pierden.' : ''}`;
        return `Se crea un programa nuevo y «${linked.name}» no cambia.`;
      };
      if (canUpdate) {
        mode = changed ? 'new' : 'update';
        const seg = createSegmented({
          options: [
            { value: 'update', label: 'Actualizar mi programa' },
            { value: 'new', label: 'Traer como programa nuevo' },
          ],
          value: mode,
          label: 'Qué hacer con el programa de la nube',
          className: 'dj-scope',
          onChange: (value) => {
            mode = value;
            setText(modeNote, describe());
            if (modalApi) modalApi.setActions(actions());
          },
        });
        modeNote = h('p', { class: `dj-hint${changed ? ' is-warn' : ''}`, 'data-role': 'import-mode', text: describe() });
        modeBlock = h('div', { class: 'dj-import-mode', 'data-role': 'import-linked' }, h('p', { class: 'dj-hint', text: `Ya tienes «${linked.name}» en este dispositivo, vinculado a este programa de la nube.` }), seg.el, modeNote);
      } else {
        modeBlock = h('p', { class: 'dj-hint', 'data-role': 'import-linked', text: `Ya tienes «${linked.name}» en este dispositivo. Para actualizarlo detén primero la música; ahora se traería como programa nuevo.` });
      }
    }

    const by = fromCloud && opened.info ? opened.info.by : '';
    const when = fromCloud && opened.info ? opened.info.publishedAt : 0;
    const fileLine = fromCloud
      ? ` · en tu nube${by ? ` · subido por ${by}` : ''}${when ? ` · ${fmtAgo(when)}` : ''}`
      : ` · ${summary.kind === 'zip' ? fmtBytes(file.size) : 'solo el programa, sin audio'}`;
    const body = h(
      'div',
      { class: 'dj-import' },
      h('p', { class: 'dj-import-file' }, h('b', { text: summary.fileName || 'Paquete' }), fileLine),
      h(
        'ul',
        { class: 'dj-sumlist', 'data-role': 'programs' },
        shown.map((entry) => h('li', {}, h('b', { text: entry.name }), ` · ${plural(entry.participants, 'participante', 'participantes')}`)),
        summary.programs.length > shown.length ? h('li', { text: `y ${summary.programs.length - shown.length} más` }) : null
      ),
      facts.length ? h('ul', { class: 'dj-sumlist is-facts', 'data-role': 'songs' }, facts) : null,
      modeBlock,
      settingsRow,
      playing ? h('p', { class: 'dj-hint is-warn', text: 'Hay música sonando. Detenla (o ponla en pausa) antes de traer el programa.' }) : null
    );
    const actions = () => [
      { label: 'Cancelar', onClick: (api) => api.close() },
      {
        label: fromCloud && linked && mode === 'update' ? 'Actualizar el programa' : summary.programs.length === 1 ? 'Traer el programa' : 'Traer los programas',
        kind: 'primary',
        icon: 'check',
        disabled: playing,
        onClick: (api) => {
          api.close();
          if (fromCloud) djCloud.download(opened, { applySettings: useSettings, replaceId: linked && mode === 'update' ? linked.id : null });
          else dj.importPackage(opened, { applySettings: useSettings });
        },
      },
    ];
    modalApi = openModal({
      title: fromCloud ? 'Traer un programa de la nube' : summary.programs.length === 1 ? 'Traer un programa' : 'Traer programas',
      size: 'md',
      className: 'dj-modal dj-import-modal',
      body,
      actions: actions(),
    });
  }

  // ------------------------------------------------------------ arrastrar archivos

  const root = h('div', { class: 'dj' }, banners, deck, work, fileInput, packageInput);
  let dragDepth = 0;
  const hasFiles = (event) => event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files');
  root.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth++;
    root.classList.add('is-dropping');
  });
  root.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
  });
  root.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) root.classList.remove('is-dropping');
  });
  root.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth = 0;
    root.classList.remove('is-dropping');
    const files = Array.from(event.dataTransfer.files);
    // Un paquete (.zip/.json) suelto se abre como paquete; con canciones de por medio, se tratan como canciones.
    const packageFile = files.find((file) => /\.(zip|json)$/i.test(file.name || ''));
    if (packageFile && !files.some(isAudioFile)) {
      openImport(packageFile);
      return;
    }
    dj.importFiles(files, { addToProgram: state.settings.tab !== 'library' });
  });

  // ------------------------------------------------------------ teclado (solo con la pestaña DJ a la vista)

  const onKeyDown = (event) => {
    if (!active) return;
    if (dj.router.handleKey(event)) event.stopPropagation();
  };
  const onKeyUp = (event) => {
    if (!active) return;
    if (dj.router.claimsKey(event)) event.preventDefault();
  };
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);

  // ------------------------------------------------------------ dibujar

  const transportText = () => {
    if (state.transport === 'playing') return 'Sonando';
    if (state.transport === 'paused') return 'En pausa';
    return state.nowId ? 'Detenido' : 'Listo';
  };

  function renderDeck() {
    const now = dj.nowItem();
    const next = dj.nextItem();
    const items = dj.items();
    const nowView = now ? items.find((item) => item.id === now.id) : null;
    const nextView = next ? items.find((item) => item.id === next.id) : null;
    const playing = state.transport === 'playing';
    setText(nowTitle, nowView ? nowView.title : 'Nada sonando');
    setText(nowSub, nowView ? `${nowView.trackName} · ${nowView.number} de ${items.length}` : items.length ? 'Pulsa Siguiente para empezar' : 'Añade canciones para empezar');
    if (!mixingNow) setText(nowChip, transportText());
    setClass(nowCard, 'is-playing', playing);
    setClass(nowCard, 'is-paused', state.transport === 'paused');
    setText(nextTitle, nextView ? nextView.title : items.length ? 'Fin del programa' : '—');
    setText(nextSub, nextView ? itemSub(nextView) : '');
    const playable = dj.playableNext();
    const status = next ? dj.itemStatus(next) : 'none';
    setText(nextState, STATUS_TEXT[status] || '');
    if (nextDot.__s !== status) {
      nextDot.__s = status;
      nextDot.className = `dj-dot ${status}`;
    }
    setClass(nextCard, 'is-cued', Boolean(state.cueId));
    if (playIcon.__p !== playing) {
      playIcon.__p = playing;
      playIcon.replaceChildren(icon(playing ? 'pause' : 'play', 34));
    }
    const playLabel = playing ? 'Pausar' : state.transport === 'paused' ? 'Reanudar' : 'Reproducir';
    btnPlay.setAttribute('aria-label', playLabel);
    btnPlay.title = playLabel;
    const fade = state.settings.fade;
    const nextButtonText = !next ? 'no hay más canciones' : !playable ? 'les falta el archivo' : nextView && nextView.missing ? 'salta al que sí tiene archivo' : playing ? (fade <= 0 ? 'corte directo' : `mezcla de ${fadeText(fade)}`) : 'empezar';
    setText(nextBtnSub, nextButtonText);
    btnNext.disabled = !playable;
    btnPrev.disabled = !now || items.findIndex((item) => item.id === now.id) <= 0;
    btnStop.disabled = state.transport === 'idle';
    for (const preset of presets) setClass(preset, 'is-on', Number(preset.dataset.seconds) === fade);
    if (document.activeElement !== fadeRange.input) fadeRange.set(fade);
    if (document.activeElement !== volumeRange.input) volumeRange.set(Math.round(state.settings.volume * 100));
    autoSwitch.set(state.settings.autoAdvance);
    updateMonitor();
  }

  function render() {
    renderBanners();
    renderDeck();
    renderWork();
  }

  // Junta varios avisos seguidos en un solo dibujo por cuadro.
  function schedule() {
    if (paintQueued || !active) return;
    paintQueued = requestAnimationFrame(() => {
      paintQueued = 0;
      if (active) render();
    });
  }

  const last = { zone: '', bar: -1, meter: -1 };

  function frame() {
    raf = requestAnimationFrame(frame);
    const live = dj.live();
    const item = dj.nowItem();
    setText(elapsedEl, item ? fmtClock(live.elapsed) : '0:00');
    let left = '';
    let tone = '';
    if (item) {
      if (item.maxDur > 0 && live.elapsed > item.maxDur + 0.5) {
        left = `+${fmtClock(live.elapsed - item.maxDur)} de más`;
        tone = 'over';
      } else if (live.remaining !== null) {
        left = `quedan ${fmtClock(live.remaining)}`;
        tone = live.remaining <= 10 && state.transport === 'playing' ? 'warn' : '';
      }
    }
    setText(leftEl, left);
    setClass(leftEl, 'is-warn', tone === 'warn');
    setClass(leftEl, 'is-over', tone === 'over');
    const bar = Math.round(live.progress * 1000);
    if (bar !== last.bar) {
      last.bar = bar;
      barFill.style.transform = `scaleX(${live.progress.toFixed(4)})`;
    }
    // Zona de mezcla: los últimos segundos antes del final, donde empieza a entrar la siguiente.
    let zone = '';
    if (item && live.duration) {
      const end = itemEnd(item, live.duration);
      const span = end - item.start;
      if (span > 0) {
        const width = clamp(state.settings.fade / span, 0, 1);
        zone = `${((1 - width) * 100).toFixed(2)}|${(width * 100).toFixed(2)}`;
      }
    }
    if (zone !== last.zone) {
      last.zone = zone;
      const [from, size] = zone ? zone.split('|') : ['100', '0'];
      barZone.style.left = `${from}%`;
      barZone.style.width = `${size}%`;
    }
    const level = live.level > 0.001 ? clamp((20 * Math.log10(live.level) + 60) / 60, 0, 1) : 0;
    const meter = Math.round(level * 100);
    if (meter !== last.meter) {
      last.meter = meter;
      meterFill.style.transform = `scaleX(${level.toFixed(3)})`;
      setClass(meterFill, 'is-hot', level > 0.97);
    }
    const mixing = Boolean(live.mixing && live.mixing.active);
    mixingNow = mixing;
    setClass(nowCard, 'is-mixing', mixing);
    if (mixing) {
      setText(nowChip, `Mezclando… ${Math.round(live.mixing.progress * 100)}%`);
      nowCard.style.setProperty('--mix', live.mixing.progress.toFixed(3));
    } else {
      setText(nowChip, transportText());
    }
  }

  const offChange = dj.on('change', schedule);
  const offCloudChange = djCloud ? djCloud.on('change', schedule) : () => {};
  const offSignal = dj.on('signal', () => {
    if (active) updateMonitor();
  });

  return {
    el: root,
    setActive(on) {
      active = Boolean(on);
      if (active) {
        render();
        if (!raf) raf = requestAnimationFrame(frame);
      } else {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        if (paintQueued) cancelAnimationFrame(paintQueued);
        paintQueued = 0;
      }
    },
    render,
    openItemEditor,
    destroy() {
      offChange();
      offCloudChange();
      offSignal();
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      if (raf) cancelAnimationFrame(raf);
      if (paintQueued) cancelAnimationFrame(paintQueued);
      raf = 0;
      paintQueued = 0;
    },
  };
}
