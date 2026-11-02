// Página de los músicos (ver.html): se conecta a la sala del director y muestra, en solo lectura, la
// estructura de la secuencia, el cifrado y el avance de la canción. No carga el motor de audio ni nada
// de Escena: solo recibe datos. No hay ningún control sobre la reproducción.
import { LiveViewer, BROKERS, cleanRoom, prettyRoom } from './live.js';
import { createChartView, ensureStyles, el } from './ui/chart-view.js';
import { extrapolate } from './chart.js';

const KEY = 'escena.ver.v1';
const store = {
  read() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } },
  write(value) { try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* modo privado */ } },
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const prefs = { notation: 'abc', shift: 0, size: 1, follow: true, theme: 'dark', room: '', ...store.read() };
const save = () => store.write(prefs);

const params = new URLSearchParams(location.search);
const fromHash = decodeURIComponent(location.hash.replace(/^#\/?/, '').replace(/^sala=/i, ''));
let room = cleanRoom(fromHash) || cleanRoom(params.get('sala')) || cleanRoom(prefs.room);
// Para pruebas o servidores propios: ver.html?broker=ws://192.168.1.10:9001
const custom = params.getAll('broker').filter(url => /^wss?:\/\//.test(url));
const brokers = custom.length ? custom : BROKERS;

ensureStyles();
const app = document.getElementById('app');
app.classList.add('cf-root');
const applyTheme = () => {
  app.dataset.theme = prefs.theme === 'light' ? 'light' : 'dark';
  document.body.style.background = prefs.theme === 'light' ? '#f5f7fb' : '#0b0f17';
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', prefs.theme === 'light' ? '#f5f7fb' : '#0b0f17');
};

const EXTRA = `
.vw-strip{display:flex;align-items:center;gap:10px;padding-bottom:8px;margin-bottom:6px;border-bottom:1px solid var(--line)}
.vw-brand{font-weight:800;letter-spacing:.02em;color:var(--mute);font-size:.85rem}
.vw-title{flex:1;min-width:0;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vw-pill{flex:none;padding:3px 10px;border-radius:999px;font-size:.8rem;font-weight:800;background:var(--line);color:var(--ink)}
.vw-pill.ok{background:var(--ok);color:#06210f}.vw-pill.warn{background:var(--warn);color:#2b1a00}.vw-pill.bad{background:var(--bad);color:#2b0000}
.vw-room{flex:none;background:none;border:0;color:var(--mute);font:inherit;font-size:.8rem;text-decoration:underline;cursor:pointer;padding:0}
.vw-bar{position:fixed;left:0;right:0;bottom:0;z-index:8;display:flex;gap:5px;flex-wrap:nowrap;justify-content:space-between;padding:8px 8px calc(8px + env(safe-area-inset-bottom));background:var(--bg);border-top:1px solid var(--line)}
.vw-btn{flex:1 1 auto;min-width:0;min-height:42px;padding:6px 6px;border-radius:10px;border:1px solid var(--line);background:var(--panel);color:var(--ink);font:inherit;font-weight:700;font-size:.82rem;cursor:pointer;white-space:nowrap}
.vw-bar .vw-btn{flex:1 1 auto;padding:6px 4px}.vw-bar .vw-btn.wide{flex:1.6 1 auto}
.vw-btn[aria-pressed=true]{background:var(--on);color:var(--onink);border-color:var(--on)}
.vw-join{max-width:420px;margin:0 auto;padding:max(24px,env(safe-area-inset-top)) 18px 24px}
.vw-join h1{font-size:1.5rem;margin:0 0 6px}.vw-join p{color:var(--mute);margin:0 0 16px}
.vw-join form{display:flex;gap:8px}
.vw-join input{flex:1;min-width:0;padding:12px;border-radius:10px;border:1px solid var(--line);background:var(--panel);color:var(--ink);font:inherit;font-size:1.1rem;letter-spacing:.08em;text-transform:uppercase}
.vw-msg{color:var(--warn);margin-top:10px;min-height:1.4em}
.cf-list{padding-bottom:96px}
`;
document.head.append(el('style', { text: EXTRA }));
applyTheme();

function joinScreen(message = '') {
  const input = el('input', { type: 'text', inputmode: 'text', autocomplete: 'off', autocapitalize: 'characters', placeholder: 'K7P3-QX9M', 'aria-label': 'Código de sala', maxlength: '20', value: room ? prettyRoom(room) : '' });
  const note = el('div', { class: 'vw-msg', role: 'status', text: message });
  const form = el('form', { onSubmit: event => {
    event.preventDefault();
    const code = cleanRoom(input.value);
    if (!code) { note.textContent = 'Ese código no es válido. Pídele al director el enlace o el código de 8 letras y números.'; return; }
    prefs.room = code;
    save();
    history.replaceState(null, '', `#${code}`);
    location.reload();
  } }, input, el('button', { class: 'vw-btn', type: 'submit', text: 'Entrar' }));
  app.replaceChildren(el('div', { class: 'vw-join' },
    el('h1', { text: 'Escena · Ver en vivo' }),
    el('p', { text: 'Escribe el código de sala que te dio el director, o abre el enlace que te mandó. Aquí solo ves la secuencia: no controlas nada.' }),
    form, note));
  input.focus();
}

function songFrom(message) {
  const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);
  if (!Array.isArray(message.bars) || !Array.isArray(message.sections) || message.bars.length > 5000 || message.sections.length > 200) return null;
  return {
    id: String(message.id ?? ''),
    title: String(message.title || 'Canción').slice(0, 120),
    duration: Math.max(1, num(message.duration)),
    bars: message.bars.map(num),
    sections: message.sections.map(s => ({ n: String(s.n ?? '').slice(0, 60), c: String(s.c ?? ''), b: Math.max(1, num(s.b)), s: num(s.s), e: num(s.e) })),
    chart: String(message.chart || '').slice(0, 60000),
  };
}

if (!room) {
  joinScreen();
} else {
  prefs.room = room;
  save();
  const title = el('div', { class: 'vw-title', text: 'Escena' });
  const pill = el('span', { class: 'vw-pill', role: 'status' });
  const change = el('button', { class: 'vw-room', type: 'button', text: `Sala ${prettyRoom(room)}`, title: 'Cambiar de sala', onClick: () => { stopped = true; viewer.stop(); joinScreen(); } });
  const strip = el('div', { class: 'vw-strip' }, el('span', { class: 'vw-brand', text: 'ESCENA' }), title, pill, change);
  let stopped = false;
  const holder = el('div');
  const view = createChartView(holder, () => prefs, { headTop: strip });

  const rebuild = () => { applyTheme(); view.refresh(); };
  const notation = el('button', { class: 'vw-btn wide', type: 'button', 'aria-label': 'Cambiar entre letras y nombres de notas', onClick: () => { prefs.notation = prefs.notation === 'latino' ? 'abc' : 'latino'; save(); notation.textContent = prefs.notation === 'latino' ? 'Do Re Mi' : 'C D E'; rebuild(); } }, prefs.notation === 'latino' ? 'Do Re Mi' : 'C D E');
  const shiftLabel = el('button', { class: 'vw-btn wide', type: 'button', title: 'Tocar para volver al tono original' });
  const paintShift = () => { shiftLabel.textContent = `Tono ${prefs.shift > 0 ? '+' : ''}${prefs.shift}`; };
  const step = delta => { prefs.shift = clamp(prefs.shift + delta, -11, 11); save(); paintShift(); rebuild(); };
  shiftLabel.addEventListener('click', () => { prefs.shift = 0; save(); paintShift(); rebuild(); });
  paintShift();
  const size = delta => { prefs.size = Math.round(clamp(prefs.size + delta, 0.7, 2.2) * 10) / 10; save(); rebuild(); };
  const follow = el('button', { class: 'vw-btn', type: 'button', 'aria-pressed': String(prefs.follow !== false), onClick: () => { prefs.follow = prefs.follow === false; save(); follow.setAttribute('aria-pressed', String(prefs.follow !== false)); } }, 'Seguir');
  const theme = el('button', { class: 'vw-btn', type: 'button', 'aria-label': 'Cambiar entre tema oscuro y claro', onClick: () => { prefs.theme = prefs.theme === 'light' ? 'dark' : 'light'; save(); rebuild(); } }, '☀︎');
  const bar = el('div', { class: 'vw-bar' },
    notation,
    el('button', { class: 'vw-btn', type: 'button', 'aria-label': 'Bajar un semitono', onClick: () => step(-1) }, '−'), shiftLabel,
    el('button', { class: 'vw-btn', type: 'button', 'aria-label': 'Subir un semitono', onClick: () => step(1) }, '+'),
    el('button', { class: 'vw-btn', type: 'button', 'aria-label': 'Letra más pequeña', onClick: () => size(-0.1) }, 'A−'),
    el('button', { class: 'vw-btn', type: 'button', 'aria-label': 'Letra más grande', onClick: () => size(0.1) }, 'A+'),
    follow, theme);
  app.replaceChildren(holder, bar);

  const viewer = new LiveViewer({ room, brokers });
  const PHASES = {
    conectando: ['Conectando…', ''],
    esperando: ['Esperando al director…', 'warn'],
    envivo: ['En vivo', 'ok'],
    sinsenal: ['Sin señal', 'bad'],
    fuera: ['Director desconectado', 'bad'],
  };
  let startedAt = performance.now();
  const paintPhase = () => {
    let [text, kind] = PHASES[viewer.phase] || PHASES.conectando;
    if (viewer.phase === 'conectando' && performance.now() - startedAt > 15000) { text = 'Sin conexión'; kind = 'bad'; }
    pill.textContent = text;
    pill.className = `vw-pill ${kind}`;
  };
  viewer.on('status', paintPhase);
  viewer.on('song', message => {
    const song = songFrom(message);
    if (!song) return;
    title.textContent = song.title;
    document.title = `${song.title} · Escena`;
    view.setSong(song);
  });
  viewer.start();
  setInterval(paintPhase, 1000);
  paintPhase();

  const frame = () => {
    if (stopped) return;
    const live = viewer.live;
    if (live && view.song) {
      const now = performance.now();
      const waiting = live.state === 'playing' && live.fresh !== false && (now - live.at) / 1000 + viewer.oneWay < (live.wait || 0);
      view.render({
        pos: extrapolate(live, now, viewer.oneWay),
        state: live.fresh === false && live.state === 'playing' ? 'paused' : live.state,
        counting: Boolean(live.counting) && waiting,
        pitch: live.pitch || 0,
        loop: live.loop,
        stale: viewer.phase === 'sinsenal' || viewer.phase === 'fuera',
      });
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // Que la pantalla no se apague mientras se toca.
  let lock = null;
  const awake = async () => {
    try { if ('wakeLock' in navigator && document.visibilityState === 'visible' && !lock) { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); } } catch { /* sin permiso */ }
  };
  awake();
  document.addEventListener('visibilitychange', awake);
  document.addEventListener('pointerdown', awake, { once: true });
}
