import { h, clamp } from '../util.js';
import { app } from '../app.js';
import { snapToHit } from '../align.js';
import { icon, iconButton, createSectionPicker } from './kit.js';

const DIM = '#4a5a6a';
const LIT = '#35c9ff';
const MARK = '#ff3fb4';
const MARK_INK = '#1c0614';
const TEMPO_MARK = '#5eead4';
const LANE = 26;
const FLAG = 20;
const RULER = 22;
const GRIP = 30;
const MIN_SPAN = 0.25;
const SLOP = 5;
const FLAG_SLOP = 2;
const DIRECT = 512;
const ZOOM = 2;
const ZEBRA_MIN = 10;
const TIME_STEPS = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

export function waveColumns(wave, t0, span, columns) {
  const out = new Float32Array(columns);
  const perColumn = (span * wave.rate) / columns;
  const first = t0 * wave.rate;
  if (perColumn > DIRECT) {
    const data = wave.data;
    const last = data.length - 1;
    for (let i = 0; i < columns; i++) {
      const from = Math.max(0, Math.floor((first + i * perColumn) / wave.block));
      const to = Math.min(last, Math.max(from, Math.floor((first + (i + 1) * perColumn - 1) / wave.block)));
      let max = 0;
      for (let b = from; b <= to; b++) if (data[b] > max) max = data[b];
      out[i] = max;
    }
  } else {
    const stride = Math.max(1, Math.floor(perColumn / 32));
    for (let i = 0; i < columns; i++) {
      const from = Math.max(0, Math.floor(first + i * perColumn));
      const to = Math.max(from + 1, Math.floor(first + (i + 1) * perColumn));
      let max = 0;
      for (const samples of wave.channels) {
        const end = Math.min(samples.length, to);
        for (let j = from; j < end; j += stride) {
          const value = samples[j];
          const level = value < 0 ? -value : value;
          if (level > max) max = level;
        }
      }
      out[i] = max;
    }
  }
  const gain = 1 / wave.top;
  for (let i = 0; i < columns; i++) out[i] = Math.pow(Math.min(1, out[i] * gain), 0.7);
  return out;
}

export function clockText(seconds, digits = 1) {
  const scale = digits === 3 ? 1000 : 10;
  const units = Math.max(0, Math.floor(seconds * scale + 1e-6));
  const minutes = Math.floor(units / (60 * scale));
  const rest = (units % (60 * scale)) / scale;
  return `${minutes}:${rest.toFixed(digits).padStart(digits + 3, '0')}`;
}

function spanText(span, duration, barDur) {
  if (span >= duration - 0.05) return ['Toda la canción', ''];
  const seconds = span >= 10 ? `${Math.round(span)} s` : `${span.toFixed(1)} s`;
  const bars = span / barDur;
  const count = bars >= 10 ? String(Math.round(bars)) : bars.toFixed(1).replace(/\.0$/, '');
  return [seconds, `${count} ${Number(count) === 1 ? 'compás' : 'compases'}`];
}

function barStep(pixelsPerBar) {
  for (const step of [1, 2, 4, 8, 16, 32, 64, 128, 256]) if (step * pixelsPerBar >= 40) return step;
  return 512;
}

function timeStep(pixelsPerSecond) {
  for (const step of TIME_STEPS) if (step * pixelsPerSecond >= 74) return step;
  return 1200;
}

// Marca de tiempo de la regla inferior: 1:05, 1:05.5, 1:05.52…, según lo cerca que esté la vista.
function rulerTime(seconds, step) {
  const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  const unit = 10 ** digits;
  const ticks = Math.round(Math.max(0, seconds) * unit);
  const minutes = Math.floor(ticks / (60 * unit));
  const rest = (ticks - minutes * 60 * unit) / unit;
  return `${minutes}:${rest.toFixed(digits).padStart(digits ? digits + 3 : 2, '0')}`;
}

const mod = (value, size) => ((value % size) + size) % size;

function layerContext(layer, width, height) {
  if (layer.width !== width) layer.width = width;
  if (layer.height !== height) layer.height = height;
  const context = layer.getContext('2d');
  context.clearRect(0, 0, width, height);
  return context;
}

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

// mode 'sections': mapa para colocar secciones. mode 'align': mapa para colocar el compás 1 sobre la onda.
// `align` (opcional) conecta la bandera «Compás 1»: { setOffset(ms), nudge(ms), magnet(), mark(time) }.
export function createSectionMap({ song, entry, quick = [], addMarker, moveMarker, removeMarker, selectMarker, mode = 'sections', align = null }) {
  const player = entry.player;
  const duration = player.duration;
  const alignMode = mode === 'align';

  const playIcon = h('span', { class: 'smap-play-icon' }, icon('play', 24));
  const playButton = h('button', { type: 'button', class: 'smap-play', 'aria-label': 'Reproducir', title: 'Reproducir o pausar', onClick: () => toggle() }, playIcon);
  const startButton = iconButton({ name: 'skipPrev', label: 'Ir al inicio', onClick: () => toStart() });
  // Reloj de dos líneas: arriba el tiempo, abajo el compás (o «Antes del compás 1»). Así su ancho casi no cambia.
  const clockTime = h('b', { class: 'smap-clock-time' });
  const clockBar = h('span', { class: 'smap-clock-bar' });
  const clock = h('span', { class: 'smap-clock', role: 'timer', 'aria-live': 'off' }, clockTime, clockBar);
  const zoomOutButton = iconButton({ name: 'minus', label: 'Alejar', onClick: () => zoomButton(1 / ZOOM) });
  const zoomInButton = iconButton({ name: 'plus', label: 'Acercar', onClick: () => zoomButton(ZOOM) });
  const zoomLabel = h('span', { class: 'smap-zoom' });
  const fitButton = h('button', { type: 'button', class: 'btn small', onClick: () => fit() }, 'Ver todo');
  const followButton = h(
    'button',
    { type: 'button', class: 'btn small smap-follow on', 'aria-pressed': 'true', 'aria-label': 'Seguir el cursor', title: 'La vista acompaña al cursor mientras suena', onClick: () => setFollow(!follow, true) },
    icon('target', 16),
    h('span', { class: 'smap-follow-text', text: 'Seguir' })
  );
  const goBarOne = h('button', { type: 'button', class: 'btn small smap-go', title: 'Llevar la vista a la bandera del compás 1', onClick: () => focusOn(gridOffset()) }, icon('flag', 16), 'Compás 1');
  const goEnd = h('button', { type: 'button', class: 'btn small smap-go', title: 'Llevar la vista al final de la canción', onClick: () => focusEnd() }, icon('sectionNext', 16), 'Final');
  const bar = h(
    'div',
    { class: 'smap-bar' },
    h('div', { class: 'smap-transport' }, startButton, playButton, clock),
    h('div', { class: 'smap-zoombox' }, zoomOutButton, zoomInButton, zoomLabel, fitButton, followButton)
  );

  const canvas = h('canvas', { class: 'smap-canvas' });
  const tip = h('div', { class: 'smap-tip', hidden: true });
  const waiting = h('div', { class: 'smap-wait', text: 'Calculando la forma de onda…' });
  const stage = h(
    'div',
    {
      class: 'smap-stage',
      tabindex: '0',
      role: 'application',
      'aria-label': alignMode
        ? 'Onda de la canción con su cuadrícula de compases. Toca un golpe para poner ahí el compás 1. Rueda del mouse para acercar, flechas para moverte, Shift y flechas para mover el compás 1 un milisegundo, espacio para reproducir'
        : 'Onda de la canción con sus secciones. Rueda del mouse para acercar, flechas para moverte, espacio para reproducir',
    },
    canvas,
    tip,
    waiting
  );
  const ovCanvas = h('canvas', { class: 'smap-ov-canvas' });
  const overview = h('div', { class: 'smap-overview', 'aria-hidden': 'true' }, ovCanvas);

  const selDot = h('i', { class: 'smap-sel-dot' });
  const selName = h('b');
  const selBarText = h('span', { class: 'smap-sel-bar' });
  const nudgeBack = h('button', { type: 'button', class: 'btn small', 'aria-label': 'Mover la sección un compás antes', title: 'Mover la sección un compás antes', onClick: () => nudge(-1) }, icon('sectionPrev', 16), '1 compás');
  const nudgeForward = h('button', { type: 'button', class: 'btn small', 'aria-label': 'Mover la sección un compás después', title: 'Mover la sección un compás después', onClick: () => nudge(1) }, '1 compás', icon('sectionNext', 16));
  const listenButton = h('button', { type: 'button', class: 'btn small', 'aria-label': 'Escuchar desde el inicio de la sección', title: 'Escuchar desde el inicio de la sección', onClick: () => listen() }, icon('play', 16), 'Escuchar');
  const removeButton = h('button', { type: 'button', class: 'btn small danger', 'aria-label': 'Quitar la sección', onClick: () => removeSelected() }, icon('trash', 16), 'Quitar');
  const selBar = h(
    'div',
    { class: 'smap-sel', hidden: true },
    h('div', { class: 'smap-sel-title' }, selDot, selName, selBarText),
    h('div', { class: 'smap-sel-actions' }, nudgeBack, nudgeForward, listenButton, removeButton)
  );

  const help = alignMode
    ? h(
        'details',
        { class: 'smap-tips' },
        h('summary', { text: 'Gestos y atajos' }),
        h('p', { class: 'field-hint', text: 'Rueda del mouse o pellizco: acercar. Arrastra la onda: moverte. Toca un golpe de la onda o arrastra la bandera «Compás 1» para colocar el primer tiempo; con Alt pulsado no se pega al golpe. Toca la regla de arriba o la de abajo para llevar el cursor a ese instante exacto. Con el teclado, Mayús + flechas mueven el compás 1 un milisegundo (con Alt, diez; con Ctrl, una décima).' })
      )
    : h('p', {
        class: 'field-hint smap-help',
        text: 'Rueda del mouse o pellizco: acercar. Arrastra la onda: moverte. Toca un compás para ir a su inicio y elegirlo. Toca el nombre de una sección para saltar a ella. Arrastra el puntito de una sección (⋮⋮): moverla de compás. La bandera rosa «Compás 1» se arrastra para alinear la cuadrícula con la música.',
      });
  const statusText = h('span', { class: 'smap-status-text' });
  const clearButton = h('button', { type: 'button', class: 'btn small', hidden: true, onClick: () => clearPick() }, 'Quitar elección');
  const status = h('div', { class: 'smap-status idle', role: 'status' }, statusText, clearButton, ...(alignMode ? [goBarOne, goEnd] : []));
  const addLabel = h('span', { class: 'smap-add-label' });
  const addRow = h(
    'div',
    { class: 'smap-add' },
    addLabel,
    h('div', { class: 'quick-add' }, quick.map((label) => h('button', { type: 'button', class: 'chip small', onClick: () => add(label) }, label)), createSectionPicker({ onPick: (label) => add(label) }))
  );
  // En la pestaña Alinear la onda (transporte y escenario) queda fija arriba mientras se baja a los controles:
  // `el` es esa parte fija e `info` lo demás (franja resumen, estado y ayuda).
  const info = alignMode ? h('div', { class: 'smap-info' }, overview, status, help) : null;
  const el = alignMode ? h('div', { class: 'smap smap-align' }, bar, stage) : h('div', { class: 'smap' }, bar, stage, overview, status, selBar, addRow, help);

  const under = document.createElement('canvas');
  const litLayer = document.createElement('canvas');
  const over = document.createElement('canvas');
  const ovDim = document.createElement('canvas');
  const ovLit = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const ovCtx = ovCanvas.getContext('2d');

  let size = { w: 0, h: 0, ow: 0, oh: 0, dpr: 1 };
  let wave = null;
  let view = { t0: 0, span: duration };
  let follow = true;
  let selectedId = null;
  let staticDirty = true;
  let overviewDirty = true;
  let drag = null;
  let pinch = null;
  let ovDrag = null;
  let preview = null;
  let hoverX = null;
  let raf = 0;
  let destroyed = false;
  let lastClock = '';
  let lastLabel = '';
  let lastZoom = '';
  let lastStatus = '';
  let lastTone = '';
  let lastClear = '';
  let pickedBar = null;
  let armedBar = null;
  let hoverY = null;
  let hoverFlag = false;
  let offsetOverride = null;
  let tapAction = 'bar1';
  let hoverSnap = null;
  let hoverKey = '';
  let markGeom = null;
  let scrubAt = 0;
  const pointers = new Map();

  const lanes = () => {
    const compact = size.h > 0 && size.h < 150;
    return { top: compact ? 20 : LANE, flag: compact ? 16 : FLAG, bottom: compact ? 16 : RULER };
  };
  // Inicio del compás 1 que se dibuja: el que se está arrastrando o, si no, el guardado.
  const gridOffset = () => (offsetOverride !== null ? offsetOverride : player.offset);
  const maxBar = () => Math.max(1, player.tempo.barCount(Math.max(0, duration - gridOffset())));
  const xCss = (time) => ((time - view.t0) / view.span) * size.w;
  const tOf = (x) => view.t0 + (x / Math.max(1, size.w)) * view.span;
  const barAtTime = (time) => clamp(Math.round(player.tempo.barFloat(Math.max(0, time - gridOffset()))), 1, maxBar());
  const blockAt = (time) => clamp(Math.floor(player.tempo.barFloat(Math.max(0, time - gridOffset())) + 1e-6), 1, maxBar());
  const barTime = (bar) => player.tempo.barStart(bar) + gridOffset();
  const cursorBar = () => blockAt(player.position());
  const markerOf = (id) => song.markers.find((item) => item.id === id) || null;
  const sectionOf = (id) => player.sections().find((item) => item.id === id) || null;
  const magnetOn = () => Boolean(align && align.magnet && align.magnet());
  const barDuration = () => player.tempo.segmentAtBar(1).barDur;

  // Las secciones siguen al compás 1 mientras se arrastra su bandera, antes de guardar.
  const sectionList = () => {
    const list = player.sections();
    if (offsetOverride === null) return list;
    const delta = offsetOverride - player.offset;
    const starts = list.map((section) => (section.implicit ? 0 : clamp(section.start + delta, 0, duration)));
    return list.map((section, index) => ({ ...section, start: starts[index], end: index + 1 < list.length ? starts[index + 1] : duration }));
  };

  const toggle = () => {
    if (player.state === 'playing') app.pause();
    else player.play({ countIn: false });
  };

  const measure = () => {
    const rect = stage.getBoundingClientRect();
    const ovRect = overview.getBoundingClientRect();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const next = {
      w: Math.round(rect.width - stage.clientLeft * 2),
      h: Math.round(rect.height - stage.clientTop * 2),
      ow: Math.round(ovRect.width - overview.clientLeft * 2),
      oh: Math.round(ovRect.height - overview.clientTop * 2),
      dpr,
    };
    if (next.w === size.w && next.h === size.h && next.ow === size.ow && next.oh === size.oh && next.dpr === size.dpr) return;
    size = next;
    canvas.width = Math.max(1, Math.round(next.w * dpr));
    canvas.height = Math.max(1, Math.round(next.h * dpr));
    ovCanvas.width = Math.max(1, Math.round(next.ow * dpr));
    ovCanvas.height = Math.max(1, Math.round(next.oh * dpr));
    staticDirty = true;
    overviewDirty = true;
  };

  const updateZoomLabel = () => {
    const center = view.t0 + view.span / 2;
    const segment = player.tempo.segmentAtTime(Math.max(0, center - gridOffset()));
    const [main, sub] = spanText(view.span, duration, segment.barDur);
    const key = `${main}|${sub}`;
    if (key === lastZoom) return;
    lastZoom = key;
    zoomLabel.replaceChildren(h('span', { class: 'smap-zoom-main', text: main }), ...(sub ? [h('span', { class: 'smap-zoom-sep', text: ' · ' }), h('span', { class: 'smap-zoom-sub', text: sub })] : []));
  };

  const setView = (t0, span) => {
    const nextSpan = clamp(span, Math.min(MIN_SPAN, duration), duration);
    const nextT0 = clamp(t0, 0, Math.max(0, duration - nextSpan));
    if (nextSpan === view.span && nextT0 === view.t0) return;
    view = { t0: nextT0, span: nextSpan };
    stage.dataset.view = `${nextT0.toFixed(3)}:${nextSpan.toFixed(3)}`;
    staticDirty = true;
    updateZoomLabel();
  };

  const zoomAround = (factor, anchor, ratio) => {
    const nextSpan = clamp(view.span / factor, Math.min(MIN_SPAN, duration), duration);
    setView(anchor - ratio * nextSpan, nextSpan);
  };

  const zoomButton = (factor) => {
    const time = player.position();
    const x = xCss(time);
    if (x >= 0 && x <= size.w) zoomAround(factor, time, (time - view.t0) / view.span);
    else zoomAround(factor, view.t0 + view.span / 2, 0.5);
  };

  const fit = () => setView(0, duration);

  const reveal = (time) => {
    if (view.span >= duration - 0.01) return;
    const x = xCss(time);
    if (x < 0 || x > size.w) setView(time - view.span * 0.1, view.span);
  };

  const setFollow = (on, show = false) => {
    if (follow === on) return;
    follow = on;
    followButton.classList.toggle('on', on);
    followButton.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on && show && view.span < duration - 0.01) setView(player.position() - view.span * 0.3, view.span);
  };

  const releaseFollow = () => {
    if (!follow) return;
    const x = xCss(player.position());
    if (x < 0 || x > size.w) setFollow(false);
  };

  // Lleva la vista a un instante (a un cuarto del borde izquierdo). Sin `wanted`, conserva el acercamiento;
  // si se ve toda la canción, acerca a unos dos compases.
  const focusOn = (time, wanted = null) => {
    const whole = view.span >= duration - 0.05;
    const span = wanted || (whole ? Math.max(2.2 * barDuration(), 2.5) : view.span);
    setView(time - clamp(span, Math.min(MIN_SPAN, duration), duration) * 0.25, span);
    releaseFollow();
  };

  const focusEnd = () => {
    const whole = view.span >= duration - 0.05;
    const span = clamp(whole ? Math.max(2.2 * barDuration(), 2.5) : view.span, Math.min(MIN_SPAN, duration), duration);
    setView(duration - span, span);
    releaseFollow();
  };

  const renderSelection = () => {
    const marker = selectedId ? markerOf(selectedId) : null;
    if (!marker) {
      selectedId = null;
      selBar.hidden = true;
      return;
    }
    selBar.hidden = false;
    selDot.style.background = marker.color;
    selName.textContent = marker.name;
    selBarText.textContent = `compás ${marker.bar}`;
    nudgeBack.disabled = marker.bar <= 1;
    nudgeForward.disabled = marker.bar >= maxBar();
  };

  const select = (id) => {
    selectedId = id;
    if (id) pickedBar = null;
    renderSelection();
    staticDirty = true;
    selectMarker(id ? markerOf(id) : null);
  };

  const setTapAction = (kind) => {
    tapAction = kind;
    stage.classList.toggle('armed-mark', kind === 'mark');
    staticDirty = true;
  };

  const clearPick = () => {
    if (tapAction === 'mark') {
      setTapAction('bar1');
      return;
    }
    pickedBar = null;
  };

  const pickBar = (bar) => {
    pickedBar = bar;
    if (selectedId) select(null);
    const inside = player.state === 'playing' && player.jumpTarget() === null && cursorBar() === bar;
    if (!inside) app.seekTo(barTime(bar));
  };

  const chooseSection = (id) => {
    select(id);
    const section = sectionOf(id);
    if (section) app.jumpToSection(section.index);
  };

  const nudge = (delta) => {
    const marker = selectedId ? markerOf(selectedId) : null;
    if (marker) moveMarker(marker, clamp(marker.bar + delta, 1, maxBar()));
  };

  const listen = () => {
    const section = selectedId ? sectionOf(selectedId) : null;
    if (!section) return;
    const idle = player.state !== 'playing';
    app.jumpToSection(section.index);
    if (idle) {
      reveal(section.start);
      player.play({ countIn: false });
    }
  };

  const toStart = () => {
    pickedBar = null;
    app.seekExact(0);
    reveal(0);
  };

  const removeSelected = () => {
    const marker = selectedId ? markerOf(selectedId) : null;
    if (marker) removeMarker(marker);
  };

  const add = (label) => {
    const marker = addMarker(label, pickedBar !== null ? pickedBar : cursorBar());
    if (!marker) return;
    pickedBar = null;
    select(marker.id);
    const section = sectionOf(marker.id);
    if (section) {
      reveal(section.start);
      releaseFollow();
    }
  };

  // Golpe más cercano a un instante, buscado en el audio de las pistas de la mezcla. El radio crece con la
  // distancia entre píxeles: acercando, el imán es fino; alejado, atrapa el golpe más claro de la zona.
  const snapNear = (time) => {
    if (!wave || !wave.channels || !wave.channels.length || !magnetOn()) return null;
    const radius = clamp((view.span / Math.max(1, size.w)) * 14, 0.012, 0.12);
    return snapToHit(wave.channels, wave.rate, time, { radius });
  };

  const tenths = (seconds) => Math.round(clamp(seconds, 0, Math.max(0, duration - 0.05)) * 10000) / 10;

  // Bandera «Compás 1»: ¿qué parte de ella hay bajo el puntero?
  const markHandleAt = (x, y, reach = 7) => {
    if (!align || !markGeom) return null;
    const lane = lanes();
    if (markGeom.edge) return y <= lane.top && x >= markGeom.left - 4 && x <= markGeom.left + markGeom.width + 4 ? 'edge' : null;
    if (y <= lane.top && x >= markGeom.left - 6 && x <= markGeom.left + markGeom.width + 6) return 'tag';
    const poleX = xCss(gridOffset());
    if (y > lane.top + lane.flag + 2 && y < size.h - lane.bottom && Math.abs(x - poleX) <= reach) return 'pole';
    return null;
  };

  const placeAt = (time, altKey = false) => {
    if (!align) return;
    const hit = altKey ? null : snapNear(time);
    const when = hit ? hit.time : time;
    if (tapAction === 'mark') {
      setTapAction('bar1');
      if (align.mark) align.mark(when, Boolean(hit));
      return;
    }
    align.setOffset(tenths(when), Boolean(hit));
  };

  const scrubTo = (time, force = false) => {
    const now = performance.now();
    if (!force && now - scrubAt < 90) return;
    scrubAt = now;
    app.seekExact(clamp(time, 0, duration));
  };

  const renderStatic = () => {
    const W = canvas.width;
    const H = canvas.height;
    const dpr = size.dpr;
    const u = layerContext(under, W, H);
    const l = layerContext(litLayer, W, H);
    const o = layerContext(over, W, H);
    if (!W || !H) return;
    const px = (value) => Math.round(value * dpr);
    const lane = lanes();
    const laneH = px(lane.top);
    const flagTop = laneH;
    const flagLaneH = px(lane.flag);
    const flagH = laneH + flagLaneH;
    const rulerH = px(lane.bottom);
    const top = flagH + px(3);
    const bottom = H - rulerH;
    const mid = (top + bottom) / 2;
    const half = Math.max(2, (bottom - top) / 2 - px(2));
    const toX = (time) => ((time - view.t0) / view.span) * W;
    const list = sectionList();
    const tempo = player.tempo;
    const off = gridOffset();
    const firstBar = Math.floor(tempo.barFloat(view.t0 - off) + 1e-9);
    const lastBar = Math.ceil(tempo.barFloat(view.t0 + view.span - off)) + 1;
    const first = tempo.segmentAtBar(Math.max(1, firstBar));
    const pxPerBar = (size.w * first.barDur) / view.span;
    const step = barStep(pxPerBar);
    const hair = Math.max(1, px(1));
    const barW = Math.max(2, Math.round(1.5 * dpr));
    const xOff = toX(off);

    // Antes del compás 1 no hay compases: se oscurece para distinguirlo.
    if (off > 0 && xOff > 0) {
      u.fillStyle = 'rgba(0, 0, 0, 0.34)';
      u.fillRect(0, flagH, Math.min(W, xOff), H - flagH);
    }

    for (const section of list) {
      if (section.implicit) continue;
      const x0 = toX(section.start);
      const x1 = toX(section.end);
      if (x1 < 0 || x0 > W) continue;
      u.globalAlpha = 0.1;
      u.fillStyle = section.color;
      u.fillRect(Math.max(0, x0), flagH, Math.min(W, x1) - Math.max(0, x0), H - flagH);
    }
    u.globalAlpha = 1;

    if (pxPerBar >= ZEBRA_MIN) {
      u.fillStyle = 'rgba(255, 255, 255, 0.07)';
      for (let number = Math.max(2, firstBar + (firstBar % 2)); number <= lastBar; number += 2) {
        const start = tempo.barStart(number) + off;
        if (start >= duration) break;
        const x0 = Math.round(toX(start));
        const x1 = Math.round(toX(Math.min(duration, tempo.barStart(number + 1) + off)));
        if (x1 < 0 || x0 > W) continue;
        u.fillRect(Math.max(0, x0), flagH, Math.min(W, x1) - Math.max(0, x0), H - flagH);
      }
    }

    if (wave) {
      const colW = Math.max(1, Math.round(dpr));
      const columns = Math.max(1, Math.floor(W / colW));
      const peaks = waveColumns(wave, view.t0, view.span * ((columns * colW) / W), columns);
      u.fillStyle = DIM;
      l.fillStyle = LIT;
      for (let i = 0; i < columns; i++) {
        const height = Math.max(px(0.5), peaks[i] * half);
        u.fillRect(i * colW, mid - height, colW, height * 2);
        l.fillRect(i * colW, mid - height, colW, height * 2);
      }
    }

    // Reglas: arriba los compases y los tiempos (como en Ableton Live), abajo el reloj.
    o.fillStyle = 'rgba(8, 11, 15, 0.94)';
    o.fillRect(0, 0, W, laneH);
    o.fillRect(0, bottom, W, rulerH);
    o.fillStyle = '#2c3643';
    o.fillRect(0, laneH - hair, W, hair);
    o.fillRect(0, bottom, W, hair);
    const vline = (x, width, alpha, color, y0, y1) => {
      o.globalAlpha = alpha;
      o.fillStyle = color;
      o.fillRect(x - Math.floor(width / 2), y0, width, y1 - y0);
    };
    o.textBaseline = 'alphabetic';
    for (let number = firstBar; number <= lastBar; number++) {
      const segment = tempo.segmentAtBar(number);
      const time = tempo.barStart(number) + off;
      if (time > duration + 0.001) break;
      const pre = number < 1;
      const x = Math.round(toX(time));
      const major = mod(number - 1, step) === 0;
      if (x >= -px(2) && x <= W + px(2) && (major || pxPerBar >= 12)) {
        vline(x, major ? barW : hair, (major ? 0.5 : 0.26) * (pre ? 0.6 : 1), '#ffffff', flagH, bottom);
        vline(x, major ? barW : hair, pre ? 0.4 : 0.9, '#a8b6c4', laneH - px(major ? 14 : 8), laneH - hair);
        if (major && !pre && number !== 1) {
          o.globalAlpha = 1;
          o.fillStyle = '#e3ebf3';
          o.font = `700 ${px(12)}px system-ui, sans-serif`;
          o.fillText(String(number), x + px(4), laneH - px(8));
        }
      }
      const beatPx = (size.w * segment.beatDur) / view.span;
      if (beatPx < 9) continue;
      for (let k = 0; k < segment.num; k++) {
        const beatTime = time + k * segment.beatDur;
        if (k > 0) {
          const bx = Math.round(toX(beatTime));
          if (bx >= 0 && bx <= W) {
            vline(bx, hair, pre ? 0.12 : 0.2, '#ffffff', flagH, bottom);
            vline(bx, hair, pre ? 0.35 : 0.65, '#a8b6c4', laneH - px(8), laneH - hair);
            if (beatPx >= 46 && !pre) {
              o.globalAlpha = 0.9;
              o.fillStyle = '#8ea0b2';
              o.font = `${px(10)}px system-ui, sans-serif`;
              o.fillText(`${number}.${k + 1}`, bx + px(3), laneH - px(8));
            }
          }
        }
        if (beatPx >= 70) {
          const parts = beatPx >= 140 ? 4 : 2;
          for (let q = 1; q < parts; q++) {
            const sx = Math.round(toX(beatTime + (q * segment.beatDur) / parts));
            if (sx < 0 || sx > W) continue;
            vline(sx, hair, pre ? 0.04 : 0.075, '#ffffff', flagH, bottom);
            vline(sx, hair, pre ? 0.25 : 0.4, '#a8b6c4', laneH - px(4), laneH - hair);
          }
        }
      }
    }
    o.globalAlpha = 1;

    // Reloj de la regla inferior.
    const pxPerSecond = size.w / view.span;
    const timeSpan = timeStep(pxPerSecond);
    o.font = `${px(10)}px system-ui, sans-serif`;
    o.fillStyle = '#8ea0b2';
    for (let i = Math.ceil(view.t0 / timeSpan - 1e-9), count = 0; i * timeSpan <= view.t0 + view.span && count < 400; i++, count++) {
      const at = i * timeSpan;
      const x = Math.round(toX(at));
      if (x < 0 || x > W) continue;
      vline(x, hair, 0.8, '#7d8b99', bottom, bottom + px(6));
      o.globalAlpha = 1;
      o.fillStyle = '#8ea0b2';
      o.fillText(rulerTime(at, timeSpan), x + px(3), H - px(4));
    }
    o.globalAlpha = 1;

    if (off > 0 && xOff > px(120)) {
      const labelX = Math.max(px(8), toX(0) + px(8));
      if (Math.min(W, xOff) - labelX > px(120)) {
        o.globalAlpha = 0.55;
        o.fillStyle = '#ffffff';
        o.font = `600 ${px(11)}px system-ui, sans-serif`;
        o.fillText('Antes del compás 1', labelX, top + px(15));
        o.globalAlpha = 1;
      }
    }

    for (const section of list) {
      if (section.implicit) continue;
      const x0 = toX(section.start);
      const x1 = toX(section.end);
      if (x1 < 0 || x0 > W) continue;
      const chosen = section.id === selectedId;
      const bx0 = Math.max(0, x0);
      const bw = Math.max(px(2), Math.min(W, x1) - bx0 - px(1));
      o.globalAlpha = 0.94;
      o.fillStyle = section.color;
      o.fillRect(bx0, flagTop, bw, flagLaneH);
      o.globalAlpha = 1;
      const startVisible = x0 >= 0 && x0 <= W;
      const gripVisible = startVisible && bw >= px(16) && !alignMode;
      if (gripVisible) {
        o.fillStyle = 'rgba(11, 13, 16, 0.6)';
        for (const gx of [5, 9]) {
          for (const gy of [6, 10, 14]) {
            o.beginPath();
            o.arc(x0 + px(gx), flagTop + px(gy), px(1.2), 0, Math.PI * 2);
            o.fill();
          }
        }
      }
      o.save();
      o.beginPath();
      o.rect(bx0, flagTop, bw, flagLaneH);
      o.clip();
      o.fillStyle = '#0b0d10';
      o.font = `700 ${px(11)}px system-ui, sans-serif`;
      o.textBaseline = 'middle';
      o.fillText(section.name, gripVisible ? x0 + px(15) : bx0 + px(5), flagTop + flagLaneH / 2 + px(0.5));
      o.restore();
      o.textBaseline = 'alphabetic';
      if (chosen) {
        o.strokeStyle = '#ffffff';
        o.lineWidth = px(2);
        o.strokeRect(bx0 + px(1), flagTop + px(1), Math.max(px(2), bw - px(2)), flagLaneH - px(2));
      }
      if (startVisible) {
        o.globalAlpha = chosen ? 1 : 0.9;
        o.fillStyle = chosen ? '#ffffff' : section.color;
        const lineW = chosen ? px(3) : px(2);
        o.fillRect(Math.round(x0) - Math.floor(lineW / 2), flagH, lineW, bottom - flagH);
        o.globalAlpha = 1;
      }
    }

    // Bandera «Compás 1»: poste de arriba abajo y etiqueta en la regla de arriba.
    if (align) {
      const wide = pxPerBar >= 34;
      const text = wide ? 'Compás 1' : '1';
      o.font = `800 ${px(11.5)}px system-ui, sans-serif`;
      const textW = Math.ceil(o.measureText(text).width);
      const tagH = laneH - px(5);
      const tagY = px(2.5);
      const poleW = Math.max(2, Math.round(2.5 * dpr));
      if (xOff >= -px(2) && xOff <= W + px(2)) {
        const tagW = textW + px(16);
        const left = xOff + tagW + px(8) <= W ? Math.round(xOff) : Math.max(0, Math.round(xOff) - tagW);
        o.globalAlpha = 1;
        o.fillStyle = MARK;
        o.fillRect(Math.round(xOff) - Math.floor(poleW / 2), 0, poleW, bottom);
        roundedRect(o, left, tagY, tagW, tagH, px(5));
        o.fill();
        o.fillStyle = MARK_INK;
        o.textBaseline = 'middle';
        o.fillText(text, left + px(8), tagY + tagH / 2 + px(0.5));
        o.textBaseline = 'alphabetic';
        markGeom = { left: left / dpr, width: tagW / dpr, edge: null };
      } else {
        const edge = xOff < 0 ? 'left' : 'right';
        const tagW = textW + px(30);
        const left = edge === 'left' ? px(3) : W - tagW - px(3);
        o.globalAlpha = 0.95;
        o.fillStyle = MARK;
        roundedRect(o, left, tagY, tagW, tagH, px(5));
        o.fill();
        const arrowX = edge === 'left' ? left + px(9) : left + tagW - px(9);
        const dir = edge === 'left' ? -1 : 1;
        o.fillStyle = MARK_INK;
        o.beginPath();
        o.moveTo(arrowX + dir * px(4), tagY + tagH / 2);
        o.lineTo(arrowX - dir * px(3), tagY + tagH / 2 - px(5));
        o.lineTo(arrowX - dir * px(3), tagY + tagH / 2 + px(5));
        o.closePath();
        o.fill();
        o.textBaseline = 'middle';
        o.fillText(text, edge === 'left' ? left + px(18) : left + px(8), tagY + tagH / 2 + px(0.5));
        o.textBaseline = 'alphabetic';
        o.globalAlpha = 1;
        markGeom = { left: left / dpr, width: tagW / dpr, edge };
      }
    }
  };

  const renderOverview = () => {
    const W = ovCanvas.width;
    const H = ovCanvas.height;
    const dpr = size.dpr;
    const a = layerContext(ovDim, W, H);
    const b = layerContext(ovLit, W, H);
    if (!W || !H) return;
    const px = (value) => Math.round(value * dpr);
    const mid = H / 2;
    const half = Math.max(2, H / 2 - px(3));
    for (const section of sectionList()) {
      if (section.implicit) continue;
      const x0 = (section.start / duration) * W;
      const x1 = (section.end / duration) * W;
      a.globalAlpha = 0.2;
      a.fillStyle = section.color;
      a.fillRect(x0, 0, Math.max(1, x1 - x0), H);
      a.globalAlpha = 0.95;
      a.fillRect(x0, 0, Math.max(1, x1 - x0 - px(1)), px(3));
      a.globalAlpha = 0.7;
      a.fillRect(x0, 0, Math.max(1, px(1)), H);
    }
    a.globalAlpha = 1;
    if (wave) {
      const colW = Math.max(1, Math.round(dpr));
      const columns = Math.max(1, Math.floor(W / colW));
      const peaks = waveColumns(wave, 0, duration * ((columns * colW) / W), columns);
      a.fillStyle = DIM;
      b.fillStyle = LIT;
      for (let i = 0; i < columns; i++) {
        const height = Math.max(px(0.5), peaks[i] * half);
        a.fillRect(i * colW, mid - height, colW, height * 2);
        b.fillRect(i * colW, mid - height, colW, height * 2);
      }
    }
    if (align) {
      a.fillStyle = MARK;
      a.fillRect(Math.round((gridOffset() / duration) * W) - Math.floor(px(2) / 2), 0, Math.max(2, px(2)), H);
    }
  };

  const draw = (snap) => {
    const W = canvas.width;
    const H = canvas.height;
    const dpr = size.dpr;
    const px = (value) => Math.round(value * dpr);
    const toX = (time) => ((time - view.t0) / view.span) * W;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(under, 0, 0);
    const x = Math.round(toX(snap.time));
    const clipX = clamp(x, 0, W);
    if (clipX > 0) ctx.drawImage(litLayer, 0, 0, clipX, H, 0, 0, clipX, H);
    ctx.drawImage(over, 0, 0);
    const lane = lanes();
    const flagH = px(lane.top + lane.flag);
    const bottom = H - px(lane.bottom);
    const block = (barNumber) => {
      const a = Math.round(toX(barTime(barNumber)));
      const b = Math.round(toX(Math.min(duration, barTime(barNumber + 1))));
      return { a, b, w: Math.max(px(2), b - a) };
    };
    const fillBlock = (rect, color) => {
      ctx.fillStyle = color;
      ctx.fillRect(rect.a, flagH, rect.w, bottom - flagH);
    };
    const frameBlock = (rect, color, dashed) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = px(2);
      if (dashed) ctx.setLineDash([px(6), px(4)]);
      ctx.strokeRect(rect.a + px(1), flagH + px(1), Math.max(px(2), rect.w - px(2)), bottom - flagH - px(2));
      ctx.restore();
    };
    const pill = (rect, text, back, ink) => {
      const left = Math.max(0, rect.a);
      const right = Math.min(W, rect.a + rect.w);
      ctx.font = `700 ${px(10.5)}px system-ui, sans-serif`;
      const padX = px(7);
      const width = Math.ceil(ctx.measureText(text).width) + padX * 2;
      if (right - left < width + px(6)) return;
      const height = px(16);
      const x0 = Math.round((left + right) / 2 - width / 2);
      const y0 = bottom - height - px(5);
      ctx.fillStyle = back;
      roundedRect(ctx, x0, y0, width, height, px(8));
      ctx.fill();
      ctx.fillStyle = ink;
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x0 + padX, y0 + height / 2 + px(0.5));
      ctx.textBaseline = 'alphabetic';
    };
    if (snap.loop) {
      const a = Math.round(toX(snap.loop.a));
      const b = Math.round(toX(snap.loop.b));
      ctx.fillStyle = 'rgba(255, 176, 32, 0.16)';
      ctx.fillRect(a, flagH, b - a, bottom - flagH);
      ctx.fillStyle = '#ffb020';
      ctx.fillRect(a, flagH, px(2), bottom - flagH);
      ctx.fillRect(b - px(2), flagH, px(2), bottom - flagH);
    }
    if (snap.time >= gridOffset()) fillBlock(block(blockAt(snap.time)), 'rgba(53, 201, 255, 0.07)');
    if (!alignMode && hoverX !== null && hoverY !== null && !hoverFlag && !drag && !pinch) fillBlock(block(blockAt(tOf(hoverX))), 'rgba(255, 255, 255, 0.09)');
    if (armedBar !== null && armedBar !== pickedBar) {
      const rect = block(armedBar);
      fillBlock(rect, 'rgba(255, 176, 32, 0.1)');
      frameBlock(rect, '#ffb020', true);
      pill(rect, 'Saltará aquí', '#ffb020', '#0b0d10');
    }
    if (pickedBar !== null) {
      const rect = block(pickedBar);
      fillBlock(rect, 'rgba(255, 255, 255, 0.13)');
      frameBlock(rect, '#ffffff', false);
      pill(rect, 'Elegido', '#ffffff', '#0b0d10');
    }
    const jump = player.jumpTarget();
    if (jump !== null) {
      ctx.save();
      ctx.strokeStyle = '#ffb020';
      ctx.lineWidth = px(2);
      ctx.setLineDash([px(5), px(4)]);
      const jx = Math.round(toX(jump));
      ctx.beginPath();
      ctx.moveTo(jx, flagH);
      ctx.lineTo(jx, bottom);
      ctx.stroke();
      ctx.restore();
    }
    if (preview) {
      fillBlock(block(preview.bar), 'rgba(255, 255, 255, 0.1)');
      ctx.save();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = px(2);
      ctx.setLineDash([px(5), px(4)]);
      const sx = Math.round(toX(barTime(preview.bar)));
      ctx.beginPath();
      ctx.moveTo(sx, px(lane.top));
      ctx.lineTo(sx, bottom);
      ctx.stroke();
      ctx.restore();
    }
    // Golpe al que se pegaría la bandera (o la marca de tempo) si se tocara en este punto.
    const dragging = drag && drag.type === 'offset' && drag.moved;
    if (align && hoverX !== null && hoverY !== null && !drag && !pinch && !hoverFlag && hoverY > lane.top + lane.flag && hoverY < size.h - lane.bottom) {
      const at = hoverSnap ? hoverSnap.time : tOf(hoverX);
      const gx = Math.round(toX(at));
      const color = tapAction === 'mark' ? TEMPO_MARK : MARK;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = hoverSnap ? 0.95 : 0.5;
      ctx.lineWidth = Math.max(1, px(1.5));
      ctx.setLineDash([px(4), px(4)]);
      ctx.beginPath();
      ctx.moveTo(gx, flagH);
      ctx.lineTo(gx, bottom);
      ctx.stroke();
      ctx.restore();
      if (hoverSnap) {
        const cy = (flagH + bottom) / 2;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(gx, cy - px(6));
        ctx.lineTo(gx + px(5), cy);
        ctx.lineTo(gx, cy + px(6));
        ctx.lineTo(gx - px(5), cy);
        ctx.closePath();
        ctx.fill();
      }
    }
    if (dragging && drag.hit) {
      const gx = Math.round(toX(drag.hit.time));
      const cy = (flagH + bottom) / 2;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(gx, cy - px(7));
      ctx.lineTo(gx + px(6), cy);
      ctx.lineTo(gx, cy + px(7));
      ctx.lineTo(gx - px(6), cy);
      ctx.closePath();
      ctx.fill();
    }
    if (x >= -px(8) && x <= W + px(8)) {
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = LIT;
      ctx.shadowBlur = 8 * dpr;
      ctx.fillRect(x - px(1), 0, px(2), bottom);
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.moveTo(x - px(5), 0);
      ctx.lineTo(x + px(5), 0);
      ctx.lineTo(x, px(7));
      ctx.closePath();
      ctx.fillStyle = LIT;
      ctx.fill();
    }
  };

  const drawOverview = (snap) => {
    const W = ovCanvas.width;
    const H = ovCanvas.height;
    const dpr = size.dpr;
    const px = (value) => Math.round(value * dpr);
    ovCtx.clearRect(0, 0, W, H);
    ovCtx.drawImage(ovDim, 0, 0);
    const x = Math.round((snap.time / duration) * W);
    if (x > 0) ovCtx.drawImage(ovLit, 0, 0, Math.min(W, x), H, 0, 0, Math.min(W, x), H);
    const x0 = (view.t0 / duration) * W;
    const x1 = ((view.t0 + view.span) / duration) * W;
    ovCtx.fillStyle = 'rgba(5, 7, 10, 0.55)';
    ovCtx.fillRect(0, 0, x0, H);
    ovCtx.fillRect(x1, 0, W - x1, H);
    ovCtx.strokeStyle = LIT;
    ovCtx.lineWidth = px(1.5);
    ovCtx.strokeRect(x0 + px(0.75), px(0.75), Math.max(px(2), x1 - x0 - px(1.5)), H - px(1.5));
    ovCtx.fillStyle = '#ffffff';
    ovCtx.fillRect(x - px(1), 0, px(2), H);
  };

  const showTip = (x, text) => {
    const lane = lanes();
    tip.textContent = text;
    tip.hidden = false;
    tip.style.left = `${clamp(x, 90, Math.max(90, size.w - 90))}px`;
    tip.style.top = `${lane.top + lane.flag + 6}px`;
  };

  const hideTip = () => {
    tip.hidden = true;
  };

  const msText = (seconds) => `${(Math.round(seconds * 10000) / 10).toFixed(1)} ms`;

  const hoverText = (x, y) => {
    const time = tOf(x);
    const handle = markHandleAt(x, y);
    if (handle === 'edge') return 'Ir a la bandera del compás 1';
    if (handle) return `Compás 1 en ${msText(gridOffset())} · arrástrala`;
    if (alignMode) {
      const off = gridOffset();
      const place = time < off ? 'antes del compás 1' : `compás ${blockAt(time)}`;
      const where = clockText(time, 3);
      if (tapAction === 'mark') return `${where} · toca el golpe que cae en un compás`;
      return `${where} · ${place}${hoverSnap ? ' · golpe' : ''}`;
    }
    const section = player.sectionAt(time);
    const name = section && !section.implicit ? section.name : '';
    if (flagAt(x, y)) return `${name} · compás ${section.bar}`;
    return `Compás ${blockAt(time)}${name ? ` · ${name}` : ''}`;
  };

  const flagAt = (x, y) => {
    if (alignMode) return null;
    const lane = lanes();
    if (y < lane.top || y > lane.top + lane.flag) return null;
    const list = sectionList();
    for (let i = list.length - 1; i >= 0; i--) {
      const section = list[i];
      if (section.implicit) continue;
      if (x >= xCss(section.start) && x < xCss(section.end)) return section;
    }
    return null;
  };

  const gripAt = (x, y) => {
    if (alignMode) return null;
    const lane = lanes();
    if (y < lane.top || y > lane.top + lane.flag) return null;
    const list = sectionList();
    for (let i = list.length - 1; i >= 0; i--) {
      const section = list[i];
      if (section.implicit) continue;
      const x0 = xCss(section.start);
      const x1 = xCss(section.end);
      const width = Math.min(GRIP, Math.max(12, x1 - x0));
      if (x >= x0 - 4 && x <= x0 + width) return section;
    }
    return null;
  };

  const localX = (event) => event.clientX - stage.getBoundingClientRect().left - stage.clientLeft;
  const localY = (event) => event.clientY - stage.getBoundingClientRect().top - stage.clientTop;

  const setHover = (x, y) => {
    hoverX = x;
    hoverY = y;
    const grip = gripAt(x, y);
    const flag = grip ? null : flagAt(x, y);
    const handle = markHandleAt(x, y);
    hoverFlag = Boolean(grip || flag || handle);
    showTip(x, hoverText(x, y));
    stage.classList.toggle('over-grip', Boolean(grip));
    stage.classList.toggle('over-flag', Boolean(flag));
    stage.classList.toggle('over-mark', Boolean(handle));
  };

  const startPinch = () => {
    const [first, second] = Array.from(pointers.values());
    const distance = Math.max(10, Math.abs(first.x - second.x));
    const middle = (first.x + second.x) / 2;
    pinch = { distance, span: view.span, anchor: tOf(middle) };
    drag = null;
    preview = null;
    offsetOverride = null;
    hideTip();
  };

  const applyPinch = () => {
    const [first, second] = Array.from(pointers.values());
    const distance = Math.max(10, Math.abs(first.x - second.x));
    const middle = (first.x + second.x) / 2;
    const nextSpan = clamp((pinch.span * pinch.distance) / distance, Math.min(MIN_SPAN, duration), duration);
    setView(pinch.anchor - (middle / Math.max(1, size.w)) * nextSpan, nextSpan);
    releaseFollow();
  };

  const dirtyGrid = () => {
    staticDirty = true;
    overviewDirty = true;
  };

  const onDown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const x = localX(event);
    const y = localY(event);
    pointers.set(event.pointerId, { x, y });
    try {
      stage.setPointerCapture(event.pointerId);
    } catch (error) {
      void error;
    }
    stage.focus({ preventScroll: true });
    if (pointers.size === 2) {
      startPinch();
      return;
    }
    if (pointers.size > 2) return;
    hideTip();
    const lane = lanes();
    const handle = markHandleAt(x, y, event.pointerType === 'mouse' ? 7 : 16);
    if (handle === 'edge') {
      drag = { type: 'edge', startX: x, moved: false };
      return;
    }
    if (handle) {
      drag = { type: 'offset', startX: x, grab: x - xCss(gridOffset()), moved: false, hit: null };
      return;
    }
    if (y < lane.top || y > size.h - lane.bottom) {
      drag = { type: 'scrub', startX: x, moved: false };
      scrubTo(tOf(x), true);
      return;
    }
    const grip = gripAt(x, y);
    if (grip) {
      drag = { type: 'marker', id: grip.id, startX: x, grab: x - xCss(grip.start), moved: false, bar: grip.bar, name: grip.name };
      if (selectedId !== grip.id) select(grip.id);
    } else {
      const flag = flagAt(x, y);
      drag = { type: flag ? 'flag' : 'pan', id: flag ? flag.id : null, startX: x, t0: view.t0, moved: false, dead: alignMode && y <= lane.top + lane.flag + 2 };
    }
  };

  const onMove = (event) => {
    const x = localX(event);
    const y = localY(event);
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x, y });
    if (pinch && pointers.size >= 2) {
      applyPinch();
      return;
    }
    if (drag) {
      const dx = x - drag.startX;
      if (drag.type === 'scrub') {
        scrubTo(tOf(x));
        return;
      }
      if (!drag.moved && Math.abs(dx) < (drag.type === 'offset' ? FLAG_SLOP : SLOP)) return;
      drag.moved = true;
      if (drag.type === 'edge') return;
      if (drag.type === 'offset') {
        const raw = tOf(x - drag.grab);
        const hit = event.altKey ? null : snapNear(raw);
        drag.hit = hit;
        offsetOverride = tenths(hit ? hit.time : raw) / 1000;
        dirtyGrid();
        showTip(x, `Compás 1 en ${msText(offsetOverride)}${hit ? ' · pegado al golpe' : ''}`);
        return;
      }
      if (drag.type === 'pan' || drag.type === 'flag') {
        drag.type = 'pan';
        setView(drag.t0 - (dx / Math.max(1, size.w)) * view.span, view.span);
        releaseFollow();
        stage.classList.add('grabbing');
      } else {
        drag.bar = barAtTime(tOf(x - drag.grab));
        preview = { id: drag.id, bar: drag.bar };
        showTip(x, `Mover «${drag.name}» al compás ${drag.bar}`);
      }
      return;
    }
    if (event.pointerType === 'mouse') setHover(x, y);
  };

  const onUp = (event) => {
    if (!pointers.delete(event.pointerId)) return;
    if (pinch) {
      if (pointers.size < 2) pinch = null;
      drag = null;
      return;
    }
    const current = drag;
    drag = null;
    stage.classList.remove('grabbing');
    if (!current) return;
    if (current.type === 'edge') {
      if (!current.moved) focusOn(gridOffset());
      return;
    }
    if (current.type === 'scrub') {
      scrubTo(tOf(localX(event)), true);
      return;
    }
    if (current.type === 'offset') {
      hideTip();
      const value = offsetOverride;
      offsetOverride = null;
      dirtyGrid();
      if (current.moved && value !== null) align.setOffset(Math.round(value * 10000) / 10, Boolean(current.hit));
      return;
    }
    if (current.type === 'flag') {
      if (!current.moved) chooseSection(current.id);
      return;
    }
    if (current.type === 'pan') {
      if (!current.moved && !current.dead) {
        if (alignMode) placeAt(tOf(localX(event)), event.altKey);
        else pickBar(blockAt(tOf(localX(event))));
      }
      return;
    }
    preview = null;
    hideTip();
    if (current.moved) {
      moveMarker(markerOf(current.id), current.bar);
      return;
    }
    chooseSection(current.id);
  };

  const onCancel = (event) => {
    pointers.delete(event.pointerId);
    if (pinch && pointers.size < 2) pinch = null;
    drag = null;
    preview = null;
    if (offsetOverride !== null) {
      offsetOverride = null;
      dirtyGrid();
    }
    stage.classList.remove('grabbing');
    hideTip();
  };

  const onLeave = () => {
    hoverX = null;
    hoverY = null;
    hoverFlag = false;
    hoverSnap = null;
    hoverKey = '';
    if (!drag) hideTip();
    stage.classList.remove('over-grip');
    stage.classList.remove('over-flag');
    stage.classList.remove('over-mark');
  };

  const onWheel = (event) => {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    const dx = event.deltaX * unit;
    const dy = event.deltaY * unit;
    const x = localX(event);
    if (event.shiftKey || Math.abs(dx) > Math.abs(dy)) {
      const amount = dx || dy;
      setView(view.t0 + (amount / Math.max(1, size.w)) * view.span, view.span);
      releaseFollow();
    } else {
      const rate = event.ctrlKey ? 0.01 : 0.002;
      zoomAround(Math.exp(-dy * rate), tOf(x), x / Math.max(1, size.w));
      releaseFollow();
    }
    if (!drag && !pinch) setHover(x, localY(event));
  };

  const onKey = (event) => {
    const key = event.key;
    if (align && event.shiftKey && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      event.preventDefault();
      const unit = event.ctrlKey || event.metaKey ? 0.1 : event.altKey ? 10 : 1;
      align.nudge((key === 'ArrowRight' ? 1 : -1) * unit);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (key === ' ' || key === 'Spacebar') {
      event.preventDefault();
      toggle();
    } else if (key === '+' || key === '=') {
      event.preventDefault();
      zoomButton(ZOOM);
    } else if (key === '-' || key === '_') {
      event.preventDefault();
      zoomButton(1 / ZOOM);
    } else if (key === '0') {
      event.preventDefault();
      fit();
    } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
      event.preventDefault();
      setView(view.t0 + (key === 'ArrowRight' ? 1 : -1) * view.span * 0.2, view.span);
      releaseFollow();
    } else if (key === 'Home') {
      event.preventDefault();
      toStart();
    } else if (key === 'Escape' && tapAction === 'mark') {
      event.preventDefault();
      event.stopPropagation();
      setTapAction('bar1');
    }
  };

  const overviewTime = (event) => {
    const rect = overview.getBoundingClientRect();
    return clamp((event.clientX - rect.left - overview.clientLeft) / Math.max(1, size.ow), 0, 1) * duration;
  };

  const onOverviewDown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const time = overviewTime(event);
    const inside = time >= view.t0 && time <= view.t0 + view.span;
    ovDrag = { offset: inside ? time - view.t0 : view.span / 2 };
    try {
      overview.setPointerCapture(event.pointerId);
    } catch (error) {
      void error;
    }
    setView(time - ovDrag.offset, view.span);
    releaseFollow();
  };

  const onOverviewMove = (event) => {
    if (!ovDrag) return;
    setView(overviewTime(event) - ovDrag.offset, view.span);
    releaseFollow();
  };

  const onOverviewUp = () => {
    ovDrag = null;
  };

  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', onCancel);
  stage.addEventListener('pointerleave', onLeave);
  stage.addEventListener('wheel', onWheel, { passive: false });
  stage.addEventListener('keydown', onKey);
  overview.addEventListener('pointerdown', onOverviewDown);
  overview.addEventListener('pointermove', onOverviewMove);
  overview.addEventListener('pointerup', onOverviewUp);
  overview.addEventListener('pointercancel', onOverviewUp);

  const observer = new ResizeObserver(() => measure());
  observer.observe(stage);

  const offUpdated = app.on('song:updated', (updated, kind) => {
    if (updated !== song || (kind !== 'tempo' && kind !== 'markers')) return;
    dirtyGrid();
    lastLabel = '';
    lastZoom = '';
    updateZoomLabel();
    if (kind === 'tempo') {
      renderSelection();
      if (pickedBar !== null && pickedBar > maxBar()) pickedBar = null;
    }
  });

  const followStep = (snap) => {
    if (!follow || snap.state !== 'playing' || drag || pinch || ovDrag || view.span >= duration - 0.01) return;
    const x = ((snap.time - view.t0) / view.span) * size.w;
    if (x < 0 || x > size.w * 0.94) setView(snap.time - view.span * 0.1, view.span);
  };

  const jumpInfo = () => {
    const target = player.jumpTarget();
    if (target === null || player.state !== 'playing' || app.settings.jumpMode === 'now') return null;
    const section = player.sectionAt(target + 1e-4);
    return {
      bar: blockAt(target + 1e-4),
      name: section && !section.implicit && Math.abs(section.start - target) < 0.01 ? section.name : '',
    };
  };

  const syncStatus = () => {
    const jump = jumpInfo();
    let tone = 'idle';
    let text = alignMode ? 'Toca en la onda el golpe donde empieza el compás 1, o arrastra la bandera «Compás 1».' : 'Toca un compás de la onda para elegirlo y saltar a él.';
    let showClear = pickedBar !== null;
    let clearLabel = 'Quitar elección';
    if (alignMode && tapAction === 'mark') {
      tone = 'pick';
      text = 'Toca el golpe que debería caer justo al inicio de un compás. Cuanto más lejos del compás 1 (hacia el final), más exacto queda el tempo.';
      showClear = true;
      clearLabel = 'Cancelar';
    } else if (jump && !alignMode) {
      tone = 'armed';
      const where = jump.name ? `a «${jump.name}» (compás ${jump.bar})` : `al compás ${jump.bar}`;
      text = `Saltará ${where} ${app.settings.jumpMode === 'beat' ? 'en el siguiente tiempo' : 'al terminar este compás'}.`;
    } else if (pickedBar !== null && !alignMode) {
      tone = 'pick';
      text = `Compás ${pickedBar} elegido. Pulsa una sección para marcarlo ahí.`;
    }
    if (text !== lastStatus) {
      lastStatus = text;
      statusText.textContent = text;
    }
    if (tone !== lastTone) {
      lastTone = tone;
      status.classList.remove('idle', 'pick', 'armed');
      status.classList.add(tone);
    }
    const pick = pickedBar === null ? '' : String(pickedBar);
    if (stage.dataset.pick !== pick) stage.dataset.pick = pick;
    armedBar = jump && !alignMode ? jump.bar : null;
    const armed = armedBar !== null ? String(armedBar) : '';
    if (stage.dataset.armed !== armed) stage.dataset.armed = armed;
    const clearKey = `${showClear}|${clearLabel}`;
    if (clearKey !== lastClear) {
      lastClear = clearKey;
      clearButton.hidden = !showClear;
      clearButton.textContent = clearLabel;
    }
  };

  const syncControls = (snap) => {
    const before = snap.time < player.offset - 0.0005;
    const barText = before ? 'Antes del compás 1' : `Compás ${snap.bar}`;
    const timeText = `${clockText(snap.time)} / ${clockText(duration)}`;
    const text = `${barText}|${timeText}`;
    if (text !== lastClock) {
      lastClock = text;
      clockTime.textContent = timeText;
      clockBar.textContent = barText;
    }
    const playing = snap.state === 'playing';
    if (playButton.__playing !== playing) {
      playButton.__playing = playing;
      playIcon.replaceChildren(icon(playing ? 'pause' : 'play', 24));
      playButton.setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
    }
    if (!alignMode) {
      const target = pickedBar !== null ? pickedBar : cursorBar();
      const label = `Marcar en el compás ${target} (${pickedBar !== null ? 'elegido' : 'cursor'})`;
      if (label !== lastLabel) {
        lastLabel = label;
        addLabel.textContent = label;
      }
    }
    syncStatus();
  };

  // Golpe bajo el puntero (solo con el ratón y el imán activado), para dibujar adónde se pegaría la bandera.
  const syncHover = () => {
    if (!align || hoverX === null || drag || pinch) {
      hoverSnap = null;
      hoverKey = '';
      return;
    }
    const key = `${hoverX}|${hoverY}|${view.t0}|${view.span}|${magnetOn()}|${wave ? 1 : 0}`;
    if (key === hoverKey) return;
    hoverKey = key;
    const lane = lanes();
    const inside = hoverY !== null && hoverY > lane.top + lane.flag && hoverY < size.h - lane.bottom;
    hoverSnap = inside && !hoverFlag ? snapNear(tOf(hoverX)) : null;
    if (inside && !hoverFlag) showTip(hoverX, hoverText(hoverX, hoverY));
  };

  const frame = () => {
    if (destroyed) return;
    raf = requestAnimationFrame(frame);
    if (!stage.isConnected || !stage.offsetParent) return;
    if (!size.w || !size.ow) measure();
    if (!size.w || app.current !== entry) return;
    const snap = app.snapshot();
    if (!snap) return;
    followStep(snap);
    syncControls(snap);
    syncHover();
    if (staticDirty) {
      renderStatic();
      staticDirty = false;
    }
    if (overviewDirty) {
      renderOverview();
      overviewDirty = false;
    }
    draw(snap);
    drawOverview(snap);
  };

  player.prepareWaveform().then((result) => {
    if (destroyed || !result) return;
    wave = result;
    waiting.hidden = true;
    staticDirty = true;
    overviewDirty = true;
  });

  if (alignMode) {
    // Al abrir se muestran unos dos compases alrededor de la bandera: lo bastante cerca para ver los golpes sueltos.
    const span = clamp(Math.max(2.2 * barDuration(), 2.5), Math.min(MIN_SPAN, duration), duration);
    view = { t0: clamp(player.offset - span * 0.25, 0, Math.max(0, duration - span)), span };
  }
  stage.dataset.view = `${view.t0.toFixed(3)}:${view.span.toFixed(3)}`;
  updateZoomLabel();
  renderSelection();
  raf = requestAnimationFrame(frame);

  return {
    el,
    info,
    cursorBar,
    refresh() {
      staticDirty = true;
      overviewDirty = true;
      lastLabel = '';
      if (pickedBar !== null && pickedBar > maxBar()) pickedBar = null;
      renderSelection();
    },
    select(id) {
      if (id === selectedId) return;
      selectedId = id;
      renderSelection();
      staticDirty = true;
    },
    focusOn,
    focusEnd,
    arm(kind) {
      setTapAction(kind === 'mark' ? 'mark' : 'bar1');
    },
    view: () => ({ ...view }),
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      offUpdated();
    },
  };
}
