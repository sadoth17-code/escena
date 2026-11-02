// Vista de la estructura de la secuencia y del cifrado, con el compás que suena resaltado.
// La usan el panel de Escena (director) y la página de los músicos. Solo muestra datos: no tiene
// ningún control sobre la reproducción.
import { parseChart, buildLayout, allChords, prefersFlats, formatChord, formatKey, locate, chordNow, fmtTime } from '../chart.js';

export function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'style') node.style.cssText = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...kids.flat().filter(kid => kid != null && kid !== false));
  return node;
}

const safeColor = color => (/^#[0-9a-f]{3,8}$/i.test(color || '') ? color : '#64748b');

const CSS = `
.cf-root{--bg:#0b0f17;--panel:#131a28;--ink:#eef2f9;--mute:#93a0b6;--line:#26304a;--on:#ffd24a;--onink:#10131a;--ok:#3ddc97;--warn:#ffb020;--bad:#ff6b6b;color:var(--ink);background:var(--bg);font:16px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%}
.cf-root[data-theme=light]{--bg:#f5f7fb;--panel:#fff;--ink:#0f1829;--mute:#56647c;--line:#d9deea;--on:#ffcc2e;--onink:#10131a}
.cf-root *{box-sizing:border-box}
.cf-head{position:sticky;top:var(--cf-top,0px);z-index:4;background:var(--bg);padding:10px 14px;border-bottom:1px solid var(--line)}
.cf-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-height:1.7em}
.cf-chip{display:inline-block;padding:2px 12px;border-radius:999px;background:var(--c,#64748b);color:#10131a;font-weight:800;font-size:.95rem;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cf-barno{color:var(--mute);font-size:.9rem}
.cf-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin:6px 0 8px}
.cf-now{font-weight:800;line-height:1.05;letter-spacing:-.02em;font-size:clamp(2.6rem,13vw,5.2rem);min-height:1.05em;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cf-now.small{font-size:clamp(1.6rem,7vw,2.6rem);color:var(--mute)}
.cf-next{color:var(--mute);font-size:1.05rem;text-align:right;white-space:nowrap}
.cf-next b{color:var(--ink);font-size:1.5rem;font-weight:800;margin-left:.3em}
.cf-times{display:flex;justify-content:space-between;color:var(--mute);font-size:.85rem;font-variant-numeric:tabular-nums;margin-bottom:5px}
.cf-track{position:relative;display:flex;gap:2px;height:24px;border-radius:7px;background:var(--line)}
.cf-seg{min-width:0;overflow:hidden;background:var(--c);opacity:.34;display:flex;align-items:center;border-radius:5px}
.cf-seg.past{opacity:.62}.cf-seg.on{opacity:1}
.cf-seg span{padding:0 6px;font-size:.7rem;font-weight:800;color:#10131a;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
.cf-play{position:absolute;top:-4px;bottom:-4px;width:3px;margin-left:-1px;background:var(--ink);border-radius:2px;box-shadow:0 0 0 2px var(--bg);pointer-events:none}
.cf-meta{margin-top:7px;color:var(--mute);font-size:.82rem;display:flex;gap:6px 14px;flex-wrap:wrap}
.cf-list{padding:6px 14px 48px;font-size:calc(16px * var(--cf-scale,1))}
.cf-note{color:var(--mute);margin:10px 0;font-size:.92em;white-space:pre-wrap}
.cf-empty-action{margin:0 0 12px}
.cf-item{margin:14px 0;padding-left:12px;border-left:4px solid var(--line);scroll-margin-top:var(--cf-sticky,170px)}
.cf-item.on{border-left-color:var(--c)}
.cf-item h3{margin:0 0 8px;font-size:1.02em;display:flex;align-items:baseline;gap:.6em}
.cf-item h3 small{color:var(--mute);font-weight:400;font-size:.8em}
.cf-dot{width:.8em;height:.8em;border-radius:50%;background:var(--c);display:inline-block;flex:none;align-self:center}
.cf-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(max(4.6em,calc(100% / var(--cols,4) - .5em)),1fr));gap:6px;margin-bottom:6px}
.cf-b{display:flex;gap:.7em;align-items:center;justify-content:center;min-height:2.7em;padding:.35em .4em;border:1px solid var(--line);border-radius:10px;background:var(--panel);font-weight:700;font-size:1.12em;scroll-margin-top:var(--cf-sticky,170px)}
.cf-b.over{opacity:.5}
.cf-b.on{background:var(--on);color:var(--onink);border-color:var(--on);box-shadow:0 0 0 3px rgba(255,210,74,.35)}
.cf-c.cur{text-decoration:underline;text-underline-offset:.22em;text-decoration-thickness:.12em}
.cf-c.hold{opacity:.45;font-weight:400}
.cf-text{margin:2px 0 8px;color:var(--mute);font-size:.95em;white-space:pre-wrap}
.cf-empty{margin:0;color:var(--mute);font-size:.88em}
`;

export function ensureStyles(doc = document) {
  if (doc.getElementById('cf-styles')) return;
  doc.head.append(el('style', { id: 'cf-styles', text: CSS }));
}

function scrollParent(node) {
  for (let n = node.parentElement; n; n = n.parentElement) {
    const overflow = getComputedStyle(n).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && n.scrollHeight > n.clientHeight) return n;
  }
  return document.scrollingElement || document.documentElement;
}

// `getPrefs()` devuelve { notation: 'abc' | 'latino', shift, size, follow, theme } y se lee en cada cambio.
export function createChartView(root, getPrefs = () => ({}), { headTop = null, emptyText = 'Esperando al director…', emptyAction = null } = {}) {
  ensureStyles();
  root.classList.add('cf-root', 'cf-view');
  const chip = el('span', { class: 'cf-chip' });
  const barNo = el('span', { class: 'cf-barno' });
  const now = el('div', { class: 'cf-now' });
  const next = el('div', { class: 'cf-next' });
  const elapsed = el('span', { text: '0:00' });
  const total = el('span', { text: '0:00' });
  const play = el('i', { class: 'cf-play' });
  const track = el('div', { class: 'cf-track' });
  const meta = el('div', { class: 'cf-meta' });
  const head = el('div', { class: 'cf-head' },
    headTop,
    el('div', { class: 'cf-top' }, chip, barNo),
    el('div', { class: 'cf-hero' }, now, next),
    el('div', { class: 'cf-times' }, elapsed, total),
    track, meta);
  const list = el('div', { class: 'cf-list' });
  root.replaceChildren(head, list);

  const S = { song: null, layout: null, prefs: {}, pitch: 0, opts: {}, cells: new Map(), items: [], segs: [], last: null, touched: 0 };
  const reset = () => { S.cur = { bar: -2, section: -2, index: -2, now: null, next: null, small: null, barNo: null, chip: null, pct: -1, sec: -1 }; };
  reset();
  for (const type of ['wheel', 'touchmove', 'pointerdown']) root.addEventListener(type, () => { S.touched = Date.now(); }, { passive: true });

  const show = c => (c.chord ? formatChord(c.chord, S.opts) : (c.raw === '.' ? '·' : c.raw));
  const itemOf = section => {
    const found = S.layout.items.findIndex(item => item.section === section);
    return found >= 0 ? found : 0;
  };

  function build() {
    S.prefs = getPrefs() || {};
    root.dataset.theme = S.prefs.theme === 'light' ? 'light' : 'dark';
    root.style.setProperty('--cf-scale', String(S.prefs.size || 1));
    S.cells.clear();
    S.items = [];
    S.segs = [];
    reset();
    const song = S.song;
    if (!song) {
      track.replaceChildren(play);
      list.replaceChildren(el('p', { class: 'cf-note', text: emptyText }));
      meta.replaceChildren();
      return;
    }
    const shift = S.pitch + (Number(S.prefs.shift) || 0);
    const notation = S.prefs.notation === 'latino' ? 'latino' : 'abc';
    S.opts = { shift, notation, flats: prefersFlats(S.layout.key, shift, allChords(S.layout)) };
    S.segs = song.sections.map(s => el('div', { class: 'cf-seg', style: `flex:${Math.max(0.5, s.e - s.s)} 1 0;--c:${safeColor(s.c)}`, title: s.n }, el('span', { text: s.n })));
    track.replaceChildren(...S.segs, play);
    total.textContent = fmtTime(song.duration);

    const layout = S.layout;
    const nodes = [];
    if (!layout.hasChords) {
      nodes.push(el('p', { class: 'cf-note', text: 'Esta canción todavía no tiene cifrado: aquí se ve la estructura y el avance.' }));
      // Solo en el panel de la laptop: un atajo para que Escena lo escriba sola.
      if (emptyAction) nodes.push(el('div', { class: 'cf-empty-action' }, el('button', { class: 'cf-tb primary', type: 'button', onClick: emptyAction.onClick }, emptyAction.label)));
    }
    for (const text of layout.notes) nodes.push(el('p', { class: 'cf-note', text }));
    layout.items.forEach(item => {
      const body = [];
      for (const row of item.rows) {
        if (row.type === 'text') { body.push(el('p', { class: 'cf-text', text: row.text })); continue; }
        const cells = [];
        for (let i = row.from; i < row.from + row.count; i++) {
          const bar = item.bars[i];
          const number = item.startBar + i;
          const inside = i < item.span;
          const spans = bar.show.map(c => el('span', { class: `cf-c${c.chord || c.raw === '%' ? '' : ' hold'}`, text: show(c) }));
          const cell = el('div', { class: `cf-b${inside ? '' : ' over'}` }, spans);
          if (inside) S.cells.set(number, { el: cell, spans });
          cells.push(cell);
        }
        body.push(el('div', { class: 'cf-row', style: `--cols:${Math.min(row.count, 8)}` }, cells));
      }
      if (!item.rows.length && layout.hasChords) body.push(el('p', { class: 'cf-empty', text: 'Sin cifrado para esta sección.' }));
      const node = el('section', { class: 'cf-item', style: `--c:${safeColor(item.color)}` },
        el('h3', {}, el('span', { class: 'cf-dot' }), item.name, el('small', { text: `Compás ${item.startBar}` })), body);
      S.items.push(node);
      nodes.push(node);
    });
    list.replaceChildren(...nodes);

    const info = [];
    if (layout.key) {
      const written = layout.key;
      const shown = formatKey(written, { shift, notation });
      info.push(shift ? `Tono ${shown} (escrito en ${formatKey(written, { notation })}, ${shift > 0 ? '+' : ''}${shift})` : `Tono ${shown}`);
    } else if (shift) info.push(`${shift > 0 ? '+' : ''}${shift} semitonos`);
    info.push(`${song.bars.length} compases`);
    meta.replaceChildren(...info.map(text => el('span', { text })));
    const sticky = head.offsetHeight;
    if (sticky) root.style.setProperty('--cf-sticky', `${sticky + 12}px`);
  }

  function follow(target) {
    if (S.prefs.follow === false || Date.now() - S.touched < 6000 || !target || !target.isConnected) return;
    const parent = scrollParent(root);
    const area = parent === document.scrollingElement || parent === document.documentElement ? { top: 0, bottom: window.innerHeight } : parent.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    if (rect.top < area.top + head.offsetHeight + 8 || rect.bottom > area.bottom - 24) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function render(live) {
    S.last = live;
    const song = S.song;
    if (!song) return;
    if ((live.pitch || 0) !== S.pitch) { S.pitch = live.pitch || 0; build(); }
    const pos = live.pos || 0;
    const loc = locate(song, pos);
    const cur = S.cur;
    const section = song.sections[loc.section];

    if (loc.section !== cur.section) {
      const was = cur.section;
      cur.section = loc.section;
      S.segs.forEach((seg, i) => { seg.className = `cf-seg${i < loc.section ? ' past' : i === loc.section ? ' on' : ''}`; });
      S.items[itemOf(was)]?.classList.remove('on');
      const item = S.items[itemOf(loc.section)];
      item?.classList.add('on');
      if (section && chip.textContent !== section.n) chip.textContent = section.n;
      if (section) chip.style.setProperty('--c', safeColor(section.c));
      if (S.layout.hasChords === false || loc.bar === 0) follow(item);
    }

    let text = '';
    let nextText = '';
    let small = false;
    let index = -1;
    if (live.counting) { text = 'Pre-conteo'; small = true; }
    else if (S.layout.hasChords && loc.bar > 0) {
      const found = chordNow(S.layout, loc.bar, loc.frac, S.opts);
      text = found.now;
      nextText = found.next;
      index = found.index;
    }
    if (!text) { text = live.state === 'stopped' && pos < 0.1 ? 'Listo' : (section ? section.n : ''); small = true; }
    if (text !== cur.now || small !== cur.small) { now.textContent = text; now.classList.toggle('small', small); cur.now = text; cur.small = small; }
    if (nextText !== cur.next) {
      next.replaceChildren(...(nextText ? ['Sigue', el('b', { text: nextText })] : []));
      cur.next = nextText;
    }

    if (loc.bar !== cur.bar) {
      S.cells.get(cur.bar)?.el.classList.remove('on');
      const cell = S.cells.get(loc.bar);
      cell?.el.classList.add('on');
      cur.bar = loc.bar;
      cur.index = -2;
      if (live.state === 'playing') follow(cell?.el);
    }
    if (index !== cur.index) {
      const cell = S.cells.get(loc.bar);
      if (cell && cell.spans.length > 1) cell.spans.forEach((span, i) => span.classList.toggle('cur', i === index));
      cur.index = index;
    }

    const tag = `${loc.bar ? `Compás ${loc.bar}` : 'Antes del compás 1'}${live.state === 'paused' ? ' · en pausa' : live.state === 'stopped' ? ' · detenida' : ''}${live.loop ? ' · repetición' : ''}${live.stale ? ' · sin señal' : ''}`;
    if (tag !== cur.barNo) { barNo.textContent = tag; cur.barNo = tag; }
    const pct = song.duration ? Math.min(100, (pos / song.duration) * 100) : 0;
    if (Math.abs(pct - cur.pct) > 0.05) { play.style.left = `${pct.toFixed(2)}%`; cur.pct = pct; }
    const sec = Math.floor(pos);
    if (sec !== cur.sec) { elapsed.textContent = fmtTime(pos); cur.sec = sec; }
  }

  return {
    setSong(song) {
      S.song = song && Array.isArray(song.bars) && Array.isArray(song.sections) ? song : null;
      S.layout = S.song ? buildLayout(S.song, parseChart(S.song.chart)) : null;
      S.pitch = S.last?.pitch || 0;
      build();
      if (S.last) render(S.last);
    },
    render,
    refresh() { build(); if (S.last) render(S.last); },
    get layout() { return S.layout; },
    get song() { return S.song; },
  };
}
