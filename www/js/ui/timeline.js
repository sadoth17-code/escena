import { h, clamp } from '../util.js';
import { app } from '../app.js';

const DIM = '#4a5a6a';
const LIT = '#35c9ff';

function stepFor(pixelsPerBar) {
  for (const step of [1, 2, 4, 8, 16, 32, 64, 128]) if (step * pixelsPerBar >= 38) return step;
  return 256;
}

export function createTimeline() {
  const canvas = h('canvas', { class: 'tl-canvas' });
  const tip = h('div', { class: 'tl-tip', hidden: true });
  const empty = h('div', { class: 'tl-empty', text: 'Carga una canción para ver su forma de onda' });
  const el = h('div', { class: 'timeline', role: 'img', 'aria-label': 'Línea de tiempo de la canción' }, canvas, tip, empty);
  const dim = document.createElement('canvas');
  const lit = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let entry = null;
  let size = { w: 0, h: 0, dpr: 1 };
  let dirty = true;
  let ghost = null;
  let dragging = false;
  let lastSnapshot = null;

  const timeAt = (clientX) => {
    const rect = el.getBoundingClientRect();
    const duration = entry ? entry.player.duration : 0;
    return clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1) * duration;
  };

  const measure = () => {
    const rect = el.getBoundingClientRect();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const next = { w: Math.round(rect.width), h: Math.round(rect.height), dpr };
    if (next.w === size.w && next.h === size.h && next.dpr === size.dpr) return;
    size = next;
    canvas.width = Math.max(1, Math.round(next.w * dpr));
    canvas.height = Math.max(1, Math.round(next.h * dpr));
    dirty = true;
  };

  const renderStatic = () => {
    const W = canvas.width;
    const H = canvas.height;
    const dpr = size.dpr;
    dim.width = lit.width = W;
    dim.height = lit.height = H;
    const a = dim.getContext('2d');
    const b = lit.getContext('2d');
    a.clearRect(0, 0, W, H);
    b.clearRect(0, 0, W, H);
    if (!entry || !W || !H) return;
    const player = entry.player;
    const duration = player.duration;
    const topBand = Math.round(20 * dpr);
    const bottomBand = Math.round(16 * dpr);
    const top = topBand;
    const bottom = H - bottomBand;
    const mid = (top + bottom) / 2;
    const half = Math.max(2, (bottom - top) / 2 - 3 * dpr);
    const sections = player.sections();
    for (const section of sections) {
      if (section.implicit) continue;
      const x0 = Math.round((section.start / duration) * W);
      const x1 = Math.round((section.end / duration) * W);
      a.fillStyle = section.color;
      a.globalAlpha = 0.1;
      a.fillRect(x0, 0, x1 - x0, H);
      a.globalAlpha = 0.9;
      a.fillRect(x0, 0, Math.max(1, x1 - x0 - Math.round(dpr)), Math.round(16 * dpr));
      a.globalAlpha = 0.55;
      a.fillRect(x0, 0, Math.max(1, Math.round(dpr)), H);
      a.globalAlpha = 1;
      a.save();
      a.beginPath();
      a.rect(x0, 0, Math.max(0, x1 - x0 - 3 * dpr), Math.round(16 * dpr));
      a.clip();
      a.fillStyle = '#0b0d10';
      a.font = `700 ${Math.round(11 * dpr)}px system-ui, sans-serif`;
      a.textBaseline = 'middle';
      a.fillText(section.name, x0 + Math.round(5 * dpr), Math.round(8.5 * dpr));
      a.restore();
    }
    const peaks = player.peaks(1600);
    const columns = Math.floor(W / (3 * dpr));
    const barW = Math.max(1, Math.round(2 * dpr));
    const stride = W / columns;
    for (let i = 0; i < columns; i++) {
      const from = Math.floor((i / columns) * peaks.length);
      const to = Math.max(from + 1, Math.floor(((i + 1) / columns) * peaks.length));
      let value = 0;
      for (let j = from; j < to; j++) if (peaks[j] > value) value = peaks[j];
      const height = Math.max(1, value * half);
      const x = Math.round(i * stride);
      a.fillStyle = DIM;
      a.fillRect(x, mid - height, barW, height * 2);
      b.fillStyle = LIT;
      b.fillRect(x, mid - height, barW, height * 2);
    }
    const bars = player.tempo.barCount(Math.max(0, duration - player.offset));
    const step = stepFor(W / dpr / Math.max(1, bars));
    a.fillStyle = '#7d8b99';
    a.font = `${Math.round(9.5 * dpr)}px system-ui, sans-serif`;
    a.textBaseline = 'alphabetic';
    for (let bar = 1; bar <= bars + 1; bar++) {
      const time = player.barTime(bar);
      if (time >= duration - 0.01) break;
      const x = Math.round((time / duration) * W);
      const major = (bar - 1) % step === 0;
      a.globalAlpha = major ? 0.9 : 0.35;
      a.fillRect(x, H - Math.round((major ? 7 : 4) * dpr), Math.max(1, Math.round(dpr)), Math.round((major ? 7 : 4) * dpr));
      if (major && bar > 0) a.fillText(String(bar), x + Math.round(3 * dpr), H - Math.round(3 * dpr));
      a.globalAlpha = 1;
    }
  };

  const draw = (snapshot) => {
    lastSnapshot = snapshot;
    if (!size.w) measure();
    if (!size.w) return;
    if (dirty) {
      renderStatic();
      dirty = false;
    }
    const W = canvas.width;
    const H = canvas.height;
    const dpr = size.dpr;
    ctx.clearRect(0, 0, W, H);
    if (!entry) return;
    const player = entry.player;
    const duration = player.duration;
    ctx.drawImage(dim, 0, 0);
    const time = snapshot ? snapshot.time : 0;
    const x = Math.round((time / duration) * W);
    if (x > 0) ctx.drawImage(lit, 0, 0, x, H, 0, 0, x, H);
    if (snapshot && snapshot.loop) {
      const a = Math.round((snapshot.loop.a / duration) * W);
      const b = Math.round((snapshot.loop.b / duration) * W);
      ctx.fillStyle = 'rgba(255,176,32,0.16)';
      ctx.fillRect(a, 0, b - a, H);
      ctx.fillStyle = '#ffb020';
      ctx.fillRect(a, 0, Math.round(2 * dpr), H);
      ctx.fillRect(b - Math.round(2 * dpr), 0, Math.round(2 * dpr), H);
    }
    const jump = player.jumpTarget();
    if (jump !== null) {
      const jx = Math.round((jump / duration) * W);
      ctx.save();
      ctx.strokeStyle = '#ffb020';
      ctx.lineWidth = Math.round(2 * dpr);
      ctx.setLineDash([Math.round(5 * dpr), Math.round(4 * dpr)]);
      ctx.beginPath();
      ctx.moveTo(jx, 0);
      ctx.lineTo(jx, H);
      ctx.stroke();
      ctx.restore();
    }
    if (ghost !== null) {
      const gx = Math.round((ghost / duration) * W);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillRect(gx, 0, Math.max(1, Math.round(dpr)), H);
    }
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = LIT;
    ctx.shadowBlur = 8 * dpr;
    ctx.fillRect(x - Math.round(dpr), 0, Math.round(2 * dpr), H);
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.moveTo(x - 5 * dpr, 0);
    ctx.lineTo(x + 5 * dpr, 0);
    ctx.lineTo(x, 7 * dpr);
    ctx.closePath();
    ctx.fillStyle = LIT;
    ctx.fill();
  };

  const showTip = (clientX) => {
    if (!entry) return;
    const rect = el.getBoundingClientRect();
    const time = timeAt(clientX);
    const player = entry.player;
    const bar = Math.max(1, Math.floor(player.tempo.barFloat(Math.max(0, time - player.offset)) + 1e-6));
    const section = player.sectionAt(time);
    tip.textContent = `Compás ${bar}${section && !section.implicit ? ` · ${section.name}` : ''}`;
    tip.hidden = false;
    const x = clamp(clientX - rect.left, 40, rect.width - 40);
    tip.style.left = `${x}px`;
  };

  el.addEventListener('pointermove', (event) => {
    if (!entry) return;
    if (event.pointerType === 'mouse' || dragging) {
      ghost = timeAt(event.clientX);
      showTip(event.clientX);
      if (lastSnapshot) draw(lastSnapshot);
    }
  });
  el.addEventListener('pointerdown', (event) => {
    if (!entry || (event.button !== undefined && event.button > 0)) return;
    dragging = true;
    el.setPointerCapture(event.pointerId);
    ghost = timeAt(event.clientX);
    showTip(event.clientX);
  });
  const finish = (event, commit) => {
    if (!dragging) return;
    dragging = false;
    const time = timeAt(event.clientX);
    ghost = null;
    tip.hidden = true;
    if (commit && entry) app.seekTo(time);
  };
  el.addEventListener('pointerup', (event) => finish(event, true));
  el.addEventListener('pointercancel', (event) => finish(event, false));
  el.addEventListener('pointerleave', () => {
    if (dragging) return;
    ghost = null;
    tip.hidden = true;
  });

  const observer = new ResizeObserver(() => measure());
  observer.observe(el);

  return {
    el,
    setEntry(next) {
      entry = next;
      dirty = true;
      empty.hidden = Boolean(next);
    },
    invalidate() {
      dirty = true;
    },
    draw,
    measure,
  };
}
