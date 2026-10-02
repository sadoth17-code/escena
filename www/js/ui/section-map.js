import { h, clamp } from '../util.js';
import { app } from '../app.js';
import { icon, iconButton } from './kit.js';

const DIM = '#4a5a6a';
const LIT = '#35c9ff';
const FLAG = 20;
const RULER = 22;
const GRIP = 30;
const MIN_SPAN = 0.25;
const SLOP = 5;
const DIRECT = 512;
const ZOOM = 2;

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

function layerContext(layer, width, height) {
  if (layer.width !== width) layer.width = width;
  if (layer.height !== height) layer.height = height;
  const context = layer.getContext('2d');
  context.clearRect(0, 0, width, height);
  return context;
}

export function createSectionMap({ song, entry, quick, addMarker, moveMarker, removeMarker, selectMarker }) {
  const player = entry.player;
  const duration = player.duration;

  const playIcon = h('span', { class: 'smap-play-icon' }, icon('play', 24));
  const playButton = h('button', { type: 'button', class: 'smap-play', 'aria-label': 'Reproducir', title: 'Reproducir o pausar', onClick: () => toggle() }, playIcon);
  const startButton = iconButton({ name: 'skipPrev', label: 'Ir al inicio', onClick: () => toStart() });
  const clock = h('span', { class: 'smap-clock' });
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
  const bar = h(
    'div',
    { class: 'smap-bar' },
    h('div', { class: 'smap-transport' }, startButton, playButton, clock),
    h('div', { class: 'smap-zoombox' }, zoomOutButton, zoomInButton, zoomLabel, fitButton, followButton)
  );

  const canvas = h('canvas', { class: 'smap-canvas' });
  const tip = h('div', { class: 'smap-tip', hidden: true });
  const waiting = h('div', { class: 'smap-wait', text: 'Calculando la forma de onda…' });
  const stage = h('div', { class: 'smap-stage', tabindex: '0', role: 'application', 'aria-label': 'Onda de la canción con sus secciones. Rueda del mouse para acercar, flechas para moverte, espacio para reproducir' }, canvas, tip, waiting);
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

  const help = h('p', { class: 'field-hint smap-help', text: 'Rueda del mouse o pellizco: acercar. Arrastra la onda: moverte. Toca la onda: poner el cursor. Arrastra el puntito de una sección (⋮⋮): moverla de compás.' });
  const addLabel = h('span', { class: 'smap-add-label' });
  const addRow = h(
    'div',
    { class: 'smap-add' },
    addLabel,
    h('div', { class: 'quick-add' }, quick.map((label) => h('button', { type: 'button', class: 'chip small', onClick: () => add(label) }, label)))
  );
  const el = h('div', { class: 'smap' }, bar, stage, overview, selBar, addRow, help);

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
  let lastCursorBar = 0;
  let lastZoom = '';
  const pointers = new Map();

  const maxBar = () => Math.max(1, player.tempo.barCount(Math.max(0, duration - player.offset)));
  const xCss = (time) => ((time - view.t0) / view.span) * size.w;
  const tOf = (x) => view.t0 + (x / Math.max(1, size.w)) * view.span;
  const barAtTime = (time) => clamp(Math.round(player.tempo.barFloat(Math.max(0, time - player.offset))), 1, maxBar());
  const cursorBar = () => barAtTime(player.position());
  const markerOf = (id) => song.markers.find((item) => item.id === id) || null;
  const sectionOf = (id) => player.sections().find((item) => item.id === id) || null;

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
    const segment = player.tempo.segmentAtTime(Math.max(0, center - player.offset));
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
    renderSelection();
    staticDirty = true;
    selectMarker(id ? markerOf(id) : null);
  };

  const nudge = (delta) => {
    const marker = selectedId ? markerOf(selectedId) : null;
    if (marker) moveMarker(marker, clamp(marker.bar + delta, 1, maxBar()));
  };

  const listen = () => {
    const section = selectedId ? sectionOf(selectedId) : null;
    if (!section) return;
    app.seekExact(section.start);
    reveal(section.start);
    if (player.state !== 'playing') player.play({ countIn: false });
  };

  const toStart = () => {
    app.seekExact(0);
    reveal(0);
  };

  const removeSelected = () => {
    const marker = selectedId ? markerOf(selectedId) : null;
    if (marker) removeMarker(marker);
  };

  const add = (label) => {
    const marker = addMarker(label, cursorBar());
    if (!marker) return;
    select(marker.id);
    const section = sectionOf(marker.id);
    if (section) {
      reveal(section.start);
      releaseFollow();
    }
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
    const flagH = px(FLAG);
    const rulerH = px(RULER);
    const top = flagH + px(3);
    const bottom = H - rulerH;
    const mid = (top + bottom) / 2;
    const half = Math.max(2, (bottom - top) / 2 - px(2));
    const toX = (time) => ((time - view.t0) / view.span) * W;
    const list = player.sections();
    const tempo = player.tempo;
    const offset = player.offset;

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

    o.fillStyle = 'rgba(8, 11, 15, 0.9)';
    o.fillRect(0, bottom, W, rulerH);
    o.fillStyle = '#242c36';
    o.fillRect(0, bottom, W, Math.max(1, px(1)));
    const firstBar = Math.max(1, Math.floor(tempo.barFloat(Math.max(0, view.t0 - offset))));
    const lastBar = Math.ceil(tempo.barFloat(Math.max(0, view.t0 + view.span - offset))) + 1;
    const first = tempo.segmentAtBar(firstBar);
    const pxPerBar = (size.w * first.barDur) / view.span;
    const step = barStep(pxPerBar);
    const hair = Math.max(1, px(1));
    o.textBaseline = 'alphabetic';
    for (let number = firstBar; number <= lastBar; number++) {
      const segment = tempo.segmentAtBar(number);
      const time = tempo.barStart(number) + offset;
      if (time > duration + 0.001) break;
      const x = Math.round(toX(time));
      if (x < -px(2) || x > W + px(2)) continue;
      const major = (number - 1) % step === 0;
      if (major || pxPerBar >= 30) {
        o.globalAlpha = major ? 0.4 : 0.24;
        o.fillStyle = '#ffffff';
        o.fillRect(x, top - px(2), hair, bottom - top + px(2));
      }
      o.globalAlpha = major ? 0.95 : 0.55;
      o.fillStyle = '#7d8b99';
      o.fillRect(x, bottom, hair, px(major ? 8 : 5));
      if (major) {
        o.globalAlpha = 1;
        o.fillStyle = '#b4c0cc';
        o.font = `700 ${px(10.5)}px system-ui, sans-serif`;
        o.fillText(String(number), x + px(3), H - px(4));
      }
      const beatPx = (size.w * segment.beatDur) / view.span;
      if (beatPx >= 14) {
        for (let k = 1; k < segment.num; k++) {
          const bx = Math.round(toX(time + k * segment.beatDur));
          if (bx < 0 || bx > W) continue;
          o.globalAlpha = 0.11;
          o.fillStyle = '#ffffff';
          o.fillRect(bx, top - px(2), hair, bottom - top + px(2));
          o.globalAlpha = 0.5;
          o.fillStyle = '#7d8b99';
          o.fillRect(bx, bottom, hair, px(3));
          if (beatPx >= 44) {
            o.globalAlpha = 0.8;
            o.font = `${px(9)}px system-ui, sans-serif`;
            o.fillText(String(k + 1), bx + px(2), H - px(4));
          }
        }
      }
    }
    o.globalAlpha = 1;

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
      o.fillRect(bx0, 0, bw, flagH);
      o.globalAlpha = 1;
      const startVisible = x0 >= 0 && x0 <= W;
      const gripVisible = startVisible && bw >= px(16);
      if (gripVisible) {
        o.fillStyle = 'rgba(11, 13, 16, 0.6)';
        for (const gx of [5, 9]) {
          for (const gy of [6, 10, 14]) {
            o.beginPath();
            o.arc(x0 + px(gx), px(gy), px(1.2), 0, Math.PI * 2);
            o.fill();
          }
        }
      }
      o.save();
      o.beginPath();
      o.rect(bx0, 0, bw, flagH);
      o.clip();
      o.fillStyle = '#0b0d10';
      o.font = `700 ${px(11)}px system-ui, sans-serif`;
      o.textBaseline = 'middle';
      o.fillText(section.name, gripVisible ? x0 + px(15) : bx0 + px(5), flagH / 2 + px(0.5));
      o.restore();
      o.textBaseline = 'alphabetic';
      if (chosen) {
        o.strokeStyle = '#ffffff';
        o.lineWidth = px(2);
        o.strokeRect(bx0 + px(1), px(1), Math.max(px(2), bw - px(2)), flagH - px(2));
      }
      if (startVisible) {
        o.globalAlpha = chosen ? 1 : 0.9;
        o.fillStyle = chosen ? '#ffffff' : section.color;
        const lineW = chosen ? px(3) : px(2);
        o.fillRect(Math.round(x0) - Math.floor(lineW / 2), flagH, lineW, bottom - flagH);
        o.globalAlpha = 1;
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
    for (const section of player.sections()) {
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
    const flagH = px(FLAG);
    const bottom = H - px(RULER);
    if (snap.loop) {
      const a = Math.round(toX(snap.loop.a));
      const b = Math.round(toX(snap.loop.b));
      ctx.fillStyle = 'rgba(255, 176, 32, 0.16)';
      ctx.fillRect(a, flagH, b - a, bottom - flagH);
      ctx.fillStyle = '#ffb020';
      ctx.fillRect(a, flagH, px(2), bottom - flagH);
      ctx.fillRect(b - px(2), flagH, px(2), bottom - flagH);
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
      const pxTime = player.tempo.barStart(preview.bar) + player.offset;
      ctx.save();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = px(2);
      ctx.setLineDash([px(5), px(4)]);
      const sx = Math.round(toX(pxTime));
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, bottom);
      ctx.stroke();
      ctx.restore();
    }
    if (hoverX !== null && !drag && !pinch) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.fillRect(Math.round(hoverX * dpr), flagH, Math.max(1, px(1)), bottom - flagH);
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
    tip.textContent = text;
    tip.hidden = false;
    tip.style.left = `${clamp(x, 90, Math.max(90, size.w - 90))}px`;
  };

  const hideTip = () => {
    tip.hidden = true;
  };

  const hoverText = (x) => {
    const time = tOf(x);
    const position = player.tempo.position(Math.max(0, time - player.offset));
    const section = player.sectionAt(time);
    const name = section && !section.implicit ? ` · ${section.name}` : '';
    return `Compás ${position.bar} · tiempo ${position.beat} · ${clockText(time, view.span < 3 ? 3 : 1)}${name}`;
  };

  const gripAt = (x, y) => {
    if (y > FLAG) return null;
    const list = player.sections();
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

  const startPinch = () => {
    const [first, second] = Array.from(pointers.values());
    const distance = Math.max(10, Math.abs(first.x - second.x));
    const middle = (first.x + second.x) / 2;
    pinch = { distance, span: view.span, anchor: tOf(middle) };
    drag = null;
    preview = null;
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
    const grip = gripAt(x, y);
    if (grip) {
      drag = { type: 'marker', id: grip.id, startX: x, grab: x - xCss(grip.start), moved: false, bar: grip.bar, name: grip.name };
      if (selectedId !== grip.id) select(grip.id);
    } else {
      drag = { type: 'pan', startX: x, t0: view.t0, moved: false };
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
      if (!drag.moved && Math.abs(dx) < SLOP) return;
      drag.moved = true;
      if (drag.type === 'pan') {
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
    if (event.pointerType === 'mouse') {
      hoverX = x;
      showTip(x, hoverText(x));
      stage.classList.toggle('over-grip', Boolean(gripAt(x, y)));
    }
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
    if (current.type === 'pan') {
      if (!current.moved) app.seekExact(tOf(localX(event)));
      return;
    }
    preview = null;
    hideTip();
    if (current.moved) {
      moveMarker(markerOf(current.id), current.bar);
      return;
    }
    const section = sectionOf(current.id);
    if (section) app.seekExact(section.start);
  };

  const onCancel = (event) => {
    pointers.delete(event.pointerId);
    if (pinch && pointers.size < 2) pinch = null;
    drag = null;
    preview = null;
    stage.classList.remove('grabbing');
    hideTip();
  };

  const onLeave = () => {
    hoverX = null;
    if (!drag) hideTip();
    stage.classList.remove('over-grip');
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
    if (!drag && !pinch) {
      hoverX = x;
      showTip(x, hoverText(x));
    }
  };

  const onKey = (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key;
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

  const followStep = (snap) => {
    if (!follow || snap.state !== 'playing' || drag || pinch || ovDrag || view.span >= duration - 0.01) return;
    const x = ((snap.time - view.t0) / view.span) * size.w;
    if (x < 0 || x > size.w * 0.94) setView(snap.time - view.span * 0.1, view.span);
  };

  const syncControls = (snap) => {
    const text = `Compás ${snap.bar} · ${clockText(snap.time)} / ${clockText(duration)}`;
    if (text !== lastClock) {
      lastClock = text;
      clock.textContent = text;
    }
    const playing = snap.state === 'playing';
    if (playButton.__playing !== playing) {
      playButton.__playing = playing;
      playIcon.replaceChildren(icon(playing ? 'pause' : 'play', 24));
      playButton.setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
    }
    const bar = cursorBar();
    if (bar !== lastCursorBar) {
      lastCursorBar = bar;
      addLabel.textContent = `Marcar una sección en el cursor (compás ${bar})`;
    }
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

  stage.dataset.view = `0.000:${duration.toFixed(3)}`;
  updateZoomLabel();
  renderSelection();
  raf = requestAnimationFrame(frame);

  return {
    el,
    cursorBar,
    refresh() {
      staticDirty = true;
      overviewDirty = true;
      lastCursorBar = 0;
      renderSelection();
    },
    select(id) {
      if (id === selectedId) return;
      selectedId = id;
      renderSelection();
      staticDirty = true;
    },
    view: () => ({ ...view }),
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
    },
  };
}
