// Cifrado en Escena (lado del director): un panel con el cifrado de la canción que suena, resaltado
// compás por compás, y la transmisión en vivo para que los músicos lo vean en sus celulares.
// Se activa solo al cargarse; no toca el motor de audio, solo lee la posición del reproductor.
import { app } from '../app.js';
import { el, ensureStyles, createChartView } from './chart-view.js';
import { parseChart, buildLayout, templateFor, extrapolate } from '../chart.js';
import { LiveHost, BROKERS, newRoom, cleanRoom, prettyRoom, viewerUrl, publicBase } from '../live.js';
import { fingerprint, chartKey, cleanEntry, mergeCharts, chartsToFile, chartsFromFile, newCode, cleanCode, prettyCode, ChartSync } from '../sync.js';

const PREFS_KEY = 'escena.cifrado.prefs';
const CHARTS_KEY = 'escena.cifrado.charts';
const DEFAULTS = { button: true, notation: 'abc', shift: 0, size: 1, follow: true, theme: 'dark', room: '', base: '', brokers: null, syncCode: '' };

const kv = {
  read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } },
};
const round = n => Math.round(n * 1000) / 1000;
// Lo que se teclea en un campo de este panel no debe llegar a los atajos de Escena (la barra espaciadora reproduce).
const isolate = node => { for (const type of ['keydown', 'keyup', 'keypress']) node.addEventListener(type, event => event.stopPropagation()); return node; };
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const CSS = `
.cf-fab{position:fixed;right:14px;bottom:calc(14px + env(safe-area-inset-bottom));z-index:900;width:48px;height:48px;border-radius:50%;border:1px solid #26304a;background:#131a28;color:#ffd24a;font-size:22px;line-height:1;box-shadow:0 6px 20px rgba(0,0,0,.45);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}
.cf-fab[hidden]{display:none}
.cf-fab[data-live=true]::after{content:"";position:absolute;top:5px;right:5px;width:11px;height:11px;border-radius:50%;background:#ff4d4d;box-shadow:0 0 0 2px #131a28}
.cf-panel{position:fixed;z-index:901;top:0;right:0;bottom:0;width:min(460px,100vw);display:flex;flex-direction:column;border-left:1px solid var(--line);box-shadow:-12px 0 32px rgba(0,0,0,.45);transform:translateX(105%);transition:transform .2s ease,visibility 0s linear .2s;visibility:hidden}
.cf-panel[data-open=true]{transform:none;visibility:visible;transition:transform .2s ease}
@media (max-width:700px){.cf-panel{top:auto;height:82vh;width:100vw;border-left:0;border-top:1px solid var(--line);transform:translateY(105%)}}
.cf-tools{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px;border-bottom:1px solid var(--line);align-items:center;background:var(--bg)}
.cf-ptitle{flex:1 1 100%;display:flex;align-items:center;gap:8px;font-weight:800}
.cf-ptitle span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cf-tb{min-height:36px;min-width:38px;padding:4px 10px;border-radius:9px;border:1px solid var(--line);background:var(--panel);color:var(--ink);font:inherit;font-weight:700;font-size:.85rem;cursor:pointer}
.cf-tb:hover{border-color:var(--mute)}
.cf-shift{color:var(--mute);font-size:.85rem;min-width:4.2em;text-align:center}
.cf-tb[aria-pressed=true]{background:var(--on);color:var(--onink);border-color:var(--on)}
.cf-tb.primary{background:var(--accent,#35c9ff);color:#06202b;border-color:transparent}
.cf-tb.danger{background:var(--bad);color:#2b0000;border-color:transparent}
.cf-scroll{flex:1;min-height:0;overflow-y:auto;position:relative}
.cf-live{flex:none;max-height:55%;overflow-y:auto;padding:12px 14px;border-bottom:1px solid var(--line);background:var(--panel);display:grid;gap:8px;align-content:start}
.cf-live[hidden]{display:none}
.cf-live p{margin:0;color:var(--mute);font-size:.85rem}
.cf-room{font-size:1.9rem;font-weight:800;letter-spacing:.12em;font-variant-numeric:tabular-nums}
.cf-link{display:flex;gap:6px}
.cf-link input{flex:1;min-width:0;padding:8px;border-radius:9px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font:inherit;font-size:.85rem}
.cf-state{display:flex;gap:8px;align-items:center;font-size:.9rem}
.cf-state i{width:10px;height:10px;border-radius:50%;background:var(--mute);display:inline-block}
.cf-state i.ok{background:var(--ok)}.cf-state i.warn{background:var(--warn)}.cf-state i.bad{background:var(--bad)}
.cf-editor{position:absolute;inset:0;z-index:6;background:var(--bg);display:flex;flex-direction:column;padding:12px;gap:8px}
.cf-editor h2{margin:0;font-size:1.05rem}
.cf-editor textarea{flex:1;min-height:0;resize:none;width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);background:var(--panel);color:var(--ink);font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;tab-size:2}
.cf-editor details{color:var(--mute);font-size:.85rem}
.cf-editor pre{margin:6px 0 0;padding:8px;border-radius:8px;background:var(--panel);color:var(--ink);overflow:auto;font-size:.8rem}
.cf-check{min-height:1.3em;font-size:.85rem;color:var(--mute)}
.cf-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.cf-library{position:absolute;inset:0;z-index:6;background:var(--bg);overflow-y:auto;padding:12px;display:grid;gap:10px;align-content:start}
.cf-library h2{margin:0;font-size:1.05rem}
.cf-lib{display:grid;gap:8px;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
.cf-lib h3{margin:0;font-size:.98rem}
.cf-lib p{margin:0;color:var(--mute);font-size:.85rem}
.cf-lib textarea,.cf-lib input[type=text]{width:100%;padding:8px;border-radius:9px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font:inherit;font-size:.88rem}
.cf-lib textarea{resize:vertical}
.cf-lib-part{display:grid;gap:8px}
.cf-lib-part[hidden]{display:none}
.cf-library .cf-room{font-size:1.5rem;overflow-wrap:anywhere}
.cf-lib .cf-actions{justify-content:flex-start}
`;

const HELP = `Tono: G
[Intro]
| G | D/F# | Em7 | C . . D |
[Verso 1]
| G | D | Em | C |
Letra o notas (cualquier línea sin barras)
[Coro]
| C | G | Am | F | x2

Un compás va entre barras |. Varios
acordes reparten el compás en partes
iguales. «%» repite el compás anterior,
«.» sostiene, «x2» repite la línea.
Acordes en letras (C D E) o nombres
(Do Re Mi). El nombre de [Sección] debe
parecerse al del marcador de la canción.`;

class Cifrado {
  constructor() {
    this.prefs = { ...DEFAULTS, ...kv.read(PREFS_KEY, {}) };
    this.charts = kv.read(CHARTS_KEY, {});
    this.player = null;
    this.offs = [];
    this.snapshot = null;
    this.signature = '';
    this.host = null;
    this.status = null;
    this.last = null;
    this.openState = false;
    this.detector = null;
    this.sync = null;
    this.syncStatus = null;
    this.library = null;
    this.raf = 0;
    this.timer = 0;
    this.sigAt = 0;
  }

  init() {
    if (this.ready || typeof document === 'undefined') return;
    this.ready = true;
    try { this._init(); } catch (error) { console.error('Cifrado: no se pudo iniciar', error); }
  }

  _init() {
    ensureStyles();
    document.head.append(el('style', { text: CSS }));
    this.fab = el('button', { class: 'cf-fab', type: 'button', title: 'Cifrado y transmisión en vivo', 'aria-label': 'Abrir el cifrado', onClick: () => this.toggle() }, '♪');
    this.fab.hidden = !this.prefs.button;
    document.body.append(this.fab);
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && this.openState && !this.editor && !this.detector && !this.library) this.close(); });
    if (typeof app?.on === 'function') {
      app.on('song:loaded', () => this.attach());
      app.on('song:unloaded', () => this.attach());
    }
    this.attach();
    if (this.syncCode) setTimeout(() => this.startSync(), 1500);
  }

  // ───────── Preferencias ─────────
  setPref(key, value) {
    this.prefs[key] = value;
    kv.write(PREFS_KEY, this.prefs);
    if (key === 'button' && this.fab) this.fab.hidden = !value;
    if (key !== 'button') this.view?.refresh();
  }

  get live() { return Boolean(this.host); }

  // ───────── Canción actual ─────────
  currentPlayer() {
    const cur = app?.current;
    if (cur && typeof cur.position === 'function' && typeof cur.sections === 'function') return cur;
    if (cur?.player && typeof cur.player.position === 'function') return cur.player;
    return null;
  }

  attach() {
    try { this._attach(); } catch (error) { console.error('Cifrado: no se pudo seguir la canción', error); }
  }

  _attach() {
    const player = this.currentPlayer();
    if (player === this.player) return;
    for (const off of this.offs) off();
    this.offs = [];
    this.detector?.close();
    this.player = player;
    this.signature = '';
    this.snapshot = null;
    this.migrate();
    if (player) {
      for (const name of ['state', 'loop', 'pitch', 'ended']) this.offs.push(player.on(name, () => this.publish()));
      this.refreshSong(true);
    } else {
      this.view?.setSong(null);
      this.paintTitle();
    }
  }

  songKey() {
    const song = this.player?.song;
    return song ? String(song.id ?? song.title ?? '') : '';
  }

  // La huella del nombre: es la misma canción en todas las computadoras, aunque cada una le ponga su propio número interno.
  songFp() { return fingerprint(this.player?.song?.title); }

  // El cifrado de la canción actual: por su nombre o, si es de una versión anterior, por su número interno.
  chartEntry() {
    const fp = this.songFp();
    return (fp && this.charts[chartKey(fp)]) || this.charts[this.songKey()] || null;
  }

  chartText() { return this.chartEntry()?.text || ''; }

  // Los cifrados de versiones anteriores se guardaban por el número interno de la canción: se pasan a su nombre para que
  // puedan viajar a otras computadoras.
  migrate() {
    const fp = this.songFp();
    const id = this.songKey();
    const old = fp && id && id !== chartKey(fp) ? this.charts[id] : null;
    if (!old || typeof old.text !== 'string') return;
    const current = this.charts[chartKey(fp)];
    const updated = Number(old.updated) || Date.now();
    // Si ya hay una versión por nombre (por ejemplo llegó de otra computadora), gana la más reciente.
    if (!current || updated > (Number(current.updated) || 0)) {
      this.charts[chartKey(fp)] = { fp, title: String(this.player.song.title || ''), text: old.text, updated };
      this.sync?.push(this.charts[chartKey(fp)]);
    }
    delete this.charts[id];
    kv.write(CHARTS_KEY, this.charts);
  }

  // Cifrados de versiones anteriores que aún no se pasaron a su nombre (se pasan al abrir cada canción).
  legacyCount() { return Object.entries(this.charts).filter(([key, entry]) => !key.startsWith('fp:') && entry && typeof entry.text === 'string' && entry.text.trim()).length; }

  buildSnapshot() {
    const player = this.player;
    const bars = [];
    for (let n = 1; n < 4000; n++) {
      const t = player.barTime(n);
      if (t >= player.duration - 0.05 || (bars.length && t <= bars[bars.length - 1] + 1e-6)) break;
      bars.push(round(t));
    }
    return {
      id: this.songKey(),
      title: String(player.song.title || 'Canción'),
      duration: round(player.duration),
      bars,
      sections: player.sections().map(s => ({ n: s.name, c: s.color, b: s.bar, s: round(s.start), e: round(s.end) })),
      chart: this.chartText(),
    };
  }

  // Vuelve a armar la canción si cambió algo (marcadores, tempo, cifrado) y la manda al panel y a los músicos.
  refreshSong(force) {
    const player = this.player;
    if (!player) return;
    const signature = `${this.songKey()}|${player.tempoSignature()}|${JSON.stringify(player.song.markers)}|${player.duration}|${this.chartText()}`;
    if (!force && signature === this.signature) return;
    this.signature = signature;
    this.snapshot = this.buildSnapshot();
    this.view?.setSong(this.snapshot);
    this.paintTitle();
    if (this.host) { this.host.setSong(this.snapshot); this.publish(); }
  }

  // ───────── Transmisión ─────────
  payload() {
    const s = this.player.liveState();
    return { song: this.snapshot.id, state: s.state, pos: round(s.pos), wait: round(s.wait), counting: s.counting, loop: s.loop, pitch: s.pitch, duration: round(s.duration) };
  }

  publish() {
    if (!this.host || !this.player || !this.snapshot) return;
    const payload = this.payload();
    this.host.setState(payload);
    this.last = { ...payload, at: performance.now() };
  }

  // Cada 250 ms: reenvía cuando algo cambia o el avance se aparta de lo que los visores calculan por su cuenta;
  // y cada 2 s aunque nada cambie, para que sepan que la laptop sigue ahí.
  tick() {
    if (!this.host || !this.player || !this.snapshot) return;
    const now = performance.now();
    const next = this.payload();
    const last = this.last;
    let need = !last || now - last.at > 2000 || next.state !== last.state || next.counting !== last.counting || next.pitch !== last.pitch || JSON.stringify(next.loop) !== JSON.stringify(last.loop);
    if (!need) need = Math.abs(extrapolate(last, now) - next.pos) > 0.25;
    if (need) this.publish();
    if (now - this.sigAt > 1000) { this.sigAt = now; this.refreshSong(false); }
  }

  startLive() {
    if (this.host) return;
    const room = cleanRoom(this.prefs.room) || newRoom();
    if (room !== this.prefs.room) this.setPref('room', room);
    const brokers = Array.isArray(this.prefs.brokers) && this.prefs.brokers.length ? this.prefs.brokers : BROKERS;
    this.host = new LiveHost({ room, brokers });
    this.host.on('status', status => { this.status = status; this.paintLive(); });
    this.status = null;
    this.host.start();
    if (this.snapshot) { this.host.setSong(this.snapshot); this.publish(); }
    this.timer = setInterval(() => this.tick(), 250);
    this.paintLive();
  }

  stopLive() {
    if (!this.host) return;
    clearInterval(this.timer);
    this.host.stop();
    this.host = null;
    this.status = null;
    this.paintLive();
  }

  newRoom() {
    const wasLive = this.live;
    this.stopLive();
    this.setPref('room', newRoom());
    if (wasLive) this.startLive(); else this.paintLive();
  }

  link() {
    const room = cleanRoom(this.prefs.room);
    if (!room) return '';
    return viewerUrl(room, this.prefs.base || publicBase());
  }

  tell(message, kind = 'info') {
    if (typeof app?.toast === 'function') app.toast(message, kind);
    else if (this.message) this.message.textContent = message;
  }

  async copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* sin permiso */ }
    const area = el('textarea', { style: 'position:fixed;opacity:0' }, text);
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* sin permiso */ }
    area.remove();
    return ok;
  }

  async share() {
    const url = this.link();
    const text = `Mira la secuencia en vivo: ${url}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Escena en vivo', text, url }); return; } catch (error) { if (error?.name === 'AbortError') return; }
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  }

  // ───────── Panel ─────────
  buildPanel() {
    this.title = el('span', { text: 'Cifrado' });
    const notation = el('button', { class: 'cf-tb', type: 'button', 'aria-label': 'Cambiar entre letras y nombres de notas', onClick: () => { this.setPref('notation', this.prefs.notation === 'latino' ? 'abc' : 'latino'); notation.textContent = this.prefs.notation === 'latino' ? 'Do Re Mi' : 'C D E'; } }, this.prefs.notation === 'latino' ? 'Do Re Mi' : 'C D E');
    const shiftLabel = el('span', { class: 'cf-shift' });
    const paintShift = () => { shiftLabel.textContent = `Vista ${this.prefs.shift > 0 ? '+' : ''}${this.prefs.shift}`; };
    const shift = delta => { this.setPref('shift', clamp(this.prefs.shift + delta, -11, 11)); paintShift(); };
    paintShift();
    const size = delta => this.setPref('size', Math.round(clamp(this.prefs.size + delta, 0.7, 2.2) * 10) / 10);
    this.liveButton = el('button', { class: 'cf-tb', type: 'button', 'aria-pressed': 'false', onClick: () => this.toggleLiveBox() }, 'En vivo');
    const tools = el('div', { class: 'cf-tools' },
      el('div', { class: 'cf-ptitle' }, this.title, el('button', { class: 'cf-tb', type: 'button', 'aria-label': 'Cerrar el cifrado', onClick: () => this.close() }, '✕')),
      notation,
      el('button', { class: 'cf-tb', type: 'button', 'aria-label': 'Bajar la vista un semitono', onClick: () => shift(-1) }, '−'), shiftLabel,
      el('button', { class: 'cf-tb', type: 'button', 'aria-label': 'Subir la vista un semitono', onClick: () => shift(1) }, '+'),
      el('button', { class: 'cf-tb', type: 'button', 'aria-label': 'Letra más pequeña', onClick: () => size(-0.1) }, 'A−'),
      el('button', { class: 'cf-tb', type: 'button', 'aria-label': 'Letra más grande', onClick: () => size(0.1) }, 'A+'),
      el('button', { class: 'cf-tb', type: 'button', onClick: () => this.edit() }, 'Editar cifrado'),
      el('button', { class: 'cf-tb', type: 'button', onClick: () => this.detect() }, 'Detectar acordes'),
      el('button', { class: 'cf-tb', type: 'button', onClick: () => this.openLibrary() }, 'Mis cifrados'),
      this.liveButton);

    this.liveBox = el('section', { class: 'cf-live', hidden: true, 'aria-label': 'Transmisión en vivo' });
    this.message = el('p', { role: 'status' });
    this.holder = el('div');
    this.view = createChartView(this.holder, () => this.prefs, { emptyText: 'Carga una canción para ver su cifrado.', emptyAction: { label: 'Detectar acordes ahora', onClick: () => this.detect() } });
    this.scroll = el('div', { class: 'cf-scroll' }, this.holder);
    this.panel = el('aside', { class: 'cf-root cf-panel', 'data-open': 'false', 'aria-label': 'Cifrado' }, tools, this.liveBox, this.scroll);
    this.panel.dataset.theme = this.prefs.theme === 'light' ? 'light' : 'dark';
    document.body.append(this.panel);
    this.view.setSong(this.snapshot);
    this.paintTitle();
    this.paintLive();
  }

  paintTitle() {
    if (this.title) this.title.textContent = this.snapshot ? `Cifrado · ${this.snapshot.title}` : 'Cifrado';
  }

  toggleLiveBox(force) {
    const open = typeof force === 'boolean' ? force : this.liveBox.hidden;
    this.liveBox.hidden = !open;
    this.liveButton.setAttribute('aria-pressed', String(open));
    this.paintedKey = '';
    this.paintLive();
  }

  paintLive() {
    this.fab?.setAttribute('data-live', String(this.live));
    if (!this.liveBox) return;
    this.liveButton.textContent = this.live ? 'En vivo ●' : 'En vivo';
    if (this.liveBox.hidden) return;
    const status = this.status;
    const key = JSON.stringify([this.live, this.prefs.room, this.prefs.base, status?.connected, status?.brokers?.length, status?.viewers]);
    if (key === this.paintedKey) return;
    this.paintedKey = key;
    const nodes = [];
    if (!this.live) {
      nodes.push(
        el('p', { text: 'Los músicos abren un enlace en su celular (con internet) y ven la estructura, el cifrado y el avance de la canción mientras tú la lanzas. Solo ven: no pueden controlar nada.' }),
        el('div', { class: 'cf-actions', style: 'justify-content:flex-start' }, el('button', { class: 'cf-tb primary', type: 'button', onClick: () => this.startLive() }, 'Transmitir en vivo')));
    } else {
      const connected = status?.connected ?? 0;
      const total = status?.brokers?.length || (Array.isArray(this.prefs.brokers) && this.prefs.brokers.length) || BROKERS.length;
      const kind = connected ? 'ok' : 'warn';
      const url = this.link();
      const input = isolate(el('input', { type: 'text', readonly: true, value: url, 'aria-label': 'Enlace para los músicos', onFocus: event => event.target.select() }));
      const base = isolate(el('input', { type: 'text', value: this.prefs.base || '', placeholder: publicBase(), 'aria-label': 'Dirección pública de Escena', onChange: event => { this.setPref('base', event.target.value.trim()); this.paintLive(); } }));
      nodes.push(
        el('div', {}, el('p', { text: 'Código de sala' }), el('div', { class: 'cf-room', text: prettyRoom(cleanRoom(this.prefs.room)) })),
        el('div', { class: 'cf-link' }, input, el('button', { class: 'cf-tb', type: 'button', onClick: async () => this.tell((await this.copy(url)) ? 'Enlace copiado' : 'No se pudo copiar el enlace', 'info') }, 'Copiar'),
          el('button', { class: 'cf-tb', type: 'button', onClick: () => this.share() }, 'Enviar')),
        el('div', { class: 'cf-state' }, el('i', { class: kind }),
          el('span', { text: connected ? `${connected} de ${total} servidores conectados · ${status?.viewers ?? 0} ${status?.viewers === 1 ? 'músico viendo' : 'músicos viendo'}` : 'Conectando con los servidores…' })),
        el('p', { text: connected ? 'Cualquiera que tenga este código puede mirar (no controlar). Cámbialo con «Nueva sala» si lo compartiste de más.' : 'Si esto no avanza, revisa la conexión a internet de la laptop.' }),
        el('div', { class: 'cf-actions', style: 'justify-content:space-between' },
          el('button', { class: 'cf-tb', type: 'button', onClick: () => this.newRoom() }, 'Nueva sala'),
          el('button', { class: 'cf-tb danger', type: 'button', onClick: () => this.stopLive() }, 'Detener transmisión')),
        el('details', {}, el('summary', { text: 'Dirección que reciben los músicos' }), el('p', { text: 'Normalmente no hace falta tocarla. Escríbela solo si Escena no está en la raíz de tu sitio (por ejemplo https://ingvelarde.com/escena/).' }), base));
    }
    nodes.push(this.message);
    this.liveBox.replaceChildren(...nodes);
  }

  // Guarda el cifrado de la canción actual en este equipo (si está vacío, lo borra) y lo manda al panel y a los músicos.
  saveChart(text) {
    const fp = this.songFp();
    const body = String(text || '');
    if (fp) {
      // Una baja queda anotada (texto vacío) para que las demás computadoras también lo quiten.
      const entry = { fp, title: String(this.player?.song?.title || ''), text: body.trim() ? body : '', updated: Date.now() };
      this.charts[chartKey(fp)] = entry;
      delete this.charts[this.songKey()];
      this.sync?.push(entry);
    } else {
      const key = this.songKey();
      if (body.trim()) this.charts[key] = { text: body, updated: Date.now() }; else delete this.charts[key];
    }
    if (!kv.write(CHARTS_KEY, this.charts)) this.tell('No se pudo guardar el cifrado en este dispositivo', 'error');
    this.refreshSong(true);
    this.paintLibrary?.();
  }

  // ───────── Entre computadoras ─────────
  get syncCode() { return cleanCode(this.prefs.syncCode); }

  startSync(code = this.syncCode) {
    const clean = cleanCode(code);
    if (!clean) return false;
    this.stopSync();
    if (clean !== this.prefs.syncCode) this.setPref('syncCode', clean);
    const brokers = Array.isArray(this.prefs.brokers) && this.prefs.brokers.length ? this.prefs.brokers : BROKERS;
    this.sync = new ChartSync({
      code: clean,
      brokers,
      getCharts: () => this.charts,
      onChart: entry => this.receive(entry),
      onState: status => { this.syncStatus = status; this.paintLibrary?.(); },
    });
    this.sync.start();
    this.paintLibrary?.();
    return true;
  }

  stopSync(forget = false) {
    this.sync?.stop();
    this.sync = null;
    this.syncStatus = null;
    if (forget) this.setPref('syncCode', '');
    this.paintLibrary?.();
  }

  // Llega un cifrado de otra computadora (o de un archivo): se queda el más reciente.
  receive(entry) {
    const { next, added, updated } = mergeCharts(this.charts, [entry]);
    if (!added && !updated) return;
    this.charts = next;
    kv.write(CHARTS_KEY, this.charts);
    if (entry.fp === this.songFp()) {
      this.refreshSong(true);
      this.tell(entry.text.trim() ? 'Cifrado actualizado desde otra computadora' : 'El cifrado se quitó desde otra computadora', 'info');
    }
    this.paintLibrary?.();
  }

  // Une un archivo (o texto pegado) de cifrados con los de este equipo. Devuelve el resumen para mostrarlo.
  importCharts(text) {
    const list = chartsFromFile(text);
    const result = mergeCharts(this.charts, list);
    this.charts = result.next;
    kv.write(CHARTS_KEY, this.charts);
    for (const raw of list) {
      const entry = cleanEntry(raw);
      if (entry && this.charts[chartKey(entry.fp)]?.updated === entry.updated) this.sync?.push(entry);
    }
    this.refreshSong(true);
    this.paintLibrary?.();
    const parts = [`${result.added} nuevos`, `${result.updated} actualizados`, `${result.kept} ya estaban al día`];
    if (result.skipped) parts.push(`${result.skipped} no se pudieron leer`);
    return `Listo: ${parts.join(', ')}.`;
  }

  chartCount() { return Object.values(this.charts).filter(entry => entry && typeof entry.text === 'string' && entry.text.trim()).length; }

  openLibrary() {
    if (this.library) return;
    if (!this.panel) this.buildPanel();
    const report = el('p', { class: 'cf-check', role: 'status' });
    const intro = el('p');
    const code = el('div', { class: 'cf-room' });
    const state = el('div', { class: 'cf-state' }, el('i'), el('span'));
    const codeInput = isolate(el('input', { type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'Código de la otra computadora', 'aria-label': 'Código de sincronización' }));
    const paste = isolate(el('textarea', { rows: '4', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', placeholder: 'Pega aquí los cifrados copiados de otra computadora', 'aria-label': 'Cifrados copiados de otra computadora' }));
    const picker = el('input', { type: 'file', accept: '.json,application/json,text/plain', hidden: true });
    const off = el('div', { class: 'cf-lib-part' },
      el('p', { text: 'Pon el mismo código en las dos computadoras y cada cifrado que guardes en una aparece solo en la otra.' }),
      el('div', { class: 'cf-actions' }, el('button', { class: 'cf-tb primary', type: 'button', onClick: () => { this.startSync(newCode()); } }, 'Crear un código nuevo')),
      codeInput,
      el('div', { class: 'cf-actions' }, el('button', { class: 'cf-tb', type: 'button', onClick: () => {
        const clean = cleanCode(codeInput.value);
        if (!clean) { report.textContent = 'Ese código no es válido: son 12 letras y números (por ejemplo K7P2-9QXM-4HTD).'; return; }
        report.textContent = '';
        this.startSync(clean);
      } }, 'Usar este código')));
    const on = el('div', { class: 'cf-lib-part' },
      code, state,
      el('p', { text: 'Escribe este mismo código en la otra computadora («Mis cifrados» → «Usar este código»). Pasa por los servidores públicos gratuitos de la transmisión en vivo: quien tenga el código puede leer tus cifrados (es solo texto de acordes).' }),
      el('div', { class: 'cf-actions' },
        el('button', { class: 'cf-tb', type: 'button', onClick: async () => this.tell((await this.copy(this.syncCode)) ? 'Código copiado' : 'No se pudo copiar el código', 'info') }, 'Copiar código'),
        el('button', { class: 'cf-tb danger', type: 'button', onClick: () => this.stopSync(true) }, 'Dejar de sincronizar')));
    const close = () => { this.library?.remove(); this.library = null; this.paintLibrary = null; };
    const exportText = () => chartsToFile(this.charts);
    const load = async text => {
      try { report.textContent = this.importCharts(text); } catch (error) { report.textContent = error.message || 'No se pudo leer.'; }
    };
    picker.addEventListener('change', async () => {
      const file = picker.files && picker.files[0];
      picker.value = '';
      if (!file) return;
      try { await load(await file.text()); } catch { report.textContent = 'No se pudo abrir ese archivo.'; }
    });
    this.paintLibrary = () => {
      const status = this.syncStatus;
      const saved = this.chartCount();
      const legacy = this.legacyCount();
      intro.textContent = `En este equipo hay ${saved} ${saved === 1 ? 'cifrado guardado' : 'cifrados guardados'}`
        + (legacy ? `; ${legacy === 1 ? '1 es de una versión anterior y solo se podrá llevar' : `${legacy} son de una versión anterior y solo se podrán llevar`} a otra computadora después de abrir su canción una vez aquí.` : '.');
      const active = Boolean(this.syncCode);
      off.hidden = active;
      on.hidden = !active;
      code.textContent = prettyCode(this.syncCode);
      const connected = status?.connected ?? 0;
      const offline = status && !connected && status.waiting === status.total;
      state.firstChild.className = connected ? 'ok' : offline ? 'bad' : 'warn';
      state.lastChild.textContent = connected ? `${connected} de ${status.total} servidores conectados`
        : offline ? 'Sin conexión con los servidores (¿hay internet?). Se reintenta solo.' : 'Conectando con los servidores…';
    };
    this.library = el('div', { class: 'cf-library' },
      el('h2', { text: 'Mis cifrados' }), intro,
      el('section', { class: 'cf-lib' }, el('h3', { text: 'Sincronizar con un código' }), off, on),
      el('section', { class: 'cf-lib' }, el('h3', { text: 'Llevarlos en un archivo' }),
        el('p', { text: 'Guarda todos tus cifrados en un archivo y cárgalo en la otra computadora. Cada canción se reconoce por su nombre; si hay dos versiones, se queda la más reciente.' }),
        el('div', { class: 'cf-actions' },
          el('button', { class: 'cf-tb', type: 'button', onClick: () => {
            const url = URL.createObjectURL(new Blob([exportText()], { type: 'application/json' }));
            const link = el('a', { href: url, download: 'escena-cifrados.json' });
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
            report.textContent = 'Archivo escena-cifrados.json guardado (revisa la carpeta de descargas).';
          } }, 'Guardar en un archivo'),
          el('button', { class: 'cf-tb', type: 'button', onClick: async () => { report.textContent = (await this.copy(exportText())) ? 'Copiado: pégalo en «Mis cifrados» de la otra computadora.' : 'No se pudo copiar.'; } }, 'Copiar todo'),
          el('button', { class: 'cf-tb', type: 'button', onClick: () => picker.click() }, 'Cargar de un archivo…'), picker),
        paste,
        el('div', { class: 'cf-actions' }, el('button', { class: 'cf-tb', type: 'button', onClick: () => load(paste.value) }, 'Cargar lo pegado')),
        report),
      el('div', { class: 'cf-actions' }, el('button', { class: 'cf-tb primary', type: 'button', onClick: close }, 'Cerrar')));
    this.paintLibrary();
    this.scroll.parentElement.append(this.library);
  }

  // ───────── Editor del cifrado ─────────
  // `initial`: texto con que abrir el editor (por ejemplo, el que salió de la detección); si el editor ya está
  // abierto, lo reemplaza. `detected` avisa de que es un borrador automático.
  edit(initial, { detected = false } = {}) {
    if (this.editor) { if (typeof initial === 'string') this.editorSet?.(initial, detected); return; }
    if (!this.player || !this.snapshot) { this.tell('Carga una canción para escribir su cifrado', 'info'); return; }
    const area = isolate(el('textarea', { spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', 'aria-label': 'Cifrado de la canción', placeholder: 'Pega aquí el cifrado o usa «Plantilla de las secciones»' }));
    area.value = typeof initial === 'string' ? initial : this.chartText();
    const check = el('div', { class: 'cf-check', role: 'status' });
    const validate = () => {
      const layout = buildLayout(this.snapshot, parseChart(area.value));
      const withChart = layout.items.filter(item => item.bars.length);
      const missing = layout.items.filter(item => !item.bars.length && item.section >= 0).map(item => item.name);
      check.textContent = !area.value.trim() ? '' : layout.hasChords
        ? `${withChart.length} de ${layout.items.length} secciones con cifrado${missing.length ? ` · sin cifrado: ${[...new Set(missing)].join(', ')}` : ''}`
        : 'No se encontró ningún compás. Escribe los acordes entre barras: | G | D | Em | C |';
    };
    area.addEventListener('input', validate);
    const close = () => { this.editor.remove(); this.editor = null; this.editorSet = null; };
    this.editor = el('div', { class: 'cf-editor' },
      el('h2', { text: `Cifrado de «${this.snapshot.title}»` }),
      area, check,
      el('details', {}, el('summary', { text: 'Cómo se escribe' }), el('pre', { text: HELP })),
      el('div', { class: 'cf-actions' },
        el('button', { class: 'cf-tb', type: 'button', onClick: () => this.detect() }, 'Detectar acordes'),
        el('button', { class: 'cf-tb', type: 'button', onClick: () => { area.value = `${area.value.trim() ? `${area.value.replace(/\s+$/, '')}\n\n` : ''}${templateFor(this.snapshot)}`; validate(); area.focus(); } }, 'Plantilla de las secciones'),
        el('button', { class: 'cf-tb', type: 'button', onClick: close }, 'Cancelar'),
        el('button', { class: 'cf-tb primary', type: 'button', onClick: () => { close(); this.saveChart(area.value); } }, 'Guardar')));
    this.scroll.parentElement.append(this.editor);
    validate();
    if (detected) check.textContent = `Detectado automáticamente (borrador): revísalo y corrige lo que haga falta. ${check.textContent}`;
    this.editorSet = (text, fromDetector) => {
      area.value = text;
      validate();
      if (fromDetector) check.textContent = `Detectado automáticamente (borrador): revísalo y corrige lo que haga falta. ${check.textContent}`;
      area.focus();
    };
    area.focus();
  }

  // ───────── Detección automática de acordes ─────────
  async detect() {
    if (!this.player || !this.snapshot) { this.tell('Carga una canción para detectar sus acordes', 'info'); return; }
    if (this.detector) return;
    try {
      const { openDetector } = await import('./detector.js');
      if (this.detector) return;
      this.detector = openDetector(this, () => { this.detector = null; });
    } catch (error) {
      console.error('Cifrado: no se pudo abrir la detección de acordes', error);
      this.tell('No se pudo abrir la detección de acordes. Revisa que estén publicados www/js/detect.js y www/js/ui/detector.js; si ya lo están, cierra las pestañas de Escena y vuelve a abrir.', 'error');
    }
  }

  // ───────── Abrir y cerrar ─────────
  get isOpen() { return this.openState; }

  open({ live = false } = {}) {
    if (!this.panel) this.buildPanel();
    this.openState = true;
    this.panel.dataset.open = 'true';
    this.fab.setAttribute('aria-label', 'Cerrar el cifrado');
    this.view.refresh();
    if (live) this.toggleLiveBox(true);
    cancelAnimationFrame(this.raf);
    const loop = () => {
      if (!this.openState) return;
      const player = this.player;
      if (player && this.snapshot) {
        const s = player.liveState();
        this.view.render({ pos: s.pos, state: s.state, counting: s.counting, pitch: s.pitch, loop: s.loop });
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  openLive() { this.open({ live: true }); }

  close() {
    this.openState = false;
    cancelAnimationFrame(this.raf);
    if (this.panel) this.panel.dataset.open = 'false';
    this.fab?.setAttribute('aria-label', 'Abrir el cifrado');
  }

  toggle() { if (this.openState) this.close(); else this.open(); }
}

export const cifrado = new Cifrado();
if (typeof document !== 'undefined') {
  // Se inicia cuando ya terminó de cargarse todo el código de Escena: así no importa en qué orden se importen los módulos.
  const start = () => setTimeout(() => cifrado.init(), 0);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}
