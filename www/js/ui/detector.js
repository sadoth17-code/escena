// Detectar acordes desde el panel del cifrado: elegir de dónde se escucha (las pistas ya cargadas, archivos de
// audio, o mientras suena), correr el detector de ../detect.js y entregar el resultado al editor del cifrado,
// donde se revisa y se guarda. No toca el audio de Escena: lee los datos, o añade un analizador que no suena.
import { el } from './chart-view.js';
import { classifyTrack, bufferToMono, streamToMono, decodeToMono, PCMGroup, framesFromGroups, detectChart, LiveListener, meterSlots } from '../detect.js';

const STYLE_ID = 'cf-detect-style';
const CSS = `
.cf-detect{position:absolute;inset:0;z-index:7;background:var(--bg);display:flex;flex-direction:column;padding:12px;gap:10px;overflow-y:auto}
.cf-detect h2{margin:0;font-size:1.05rem}
.cf-detect p{margin:0;color:var(--mute);font-size:.88rem}
.cf-d-tabs{display:flex;gap:6px;flex-wrap:wrap}
.cf-d-list{display:grid;gap:6px}
.cf-d-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--line);border-radius:9px;background:var(--panel);font-size:.9rem}
.cf-d-row label{flex:1;min-width:0;display:flex;gap:8px;align-items:center}
.cf-d-row label span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cf-d-row small{color:var(--mute);font-size:.78rem}
.cf-d-row select,.cf-d-opts select,.cf-d-offset input{font:inherit;font-size:.85rem;padding:3px 6px;border-radius:7px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}
.cf-d-row[data-off=true]{opacity:.55}
.cf-d-opts{display:grid;gap:6px;font-size:.88rem}
.cf-d-opts label,.cf-d-offset{display:flex;gap:8px;align-items:center}
.cf-d-offset input{width:5.5em}
.cf-d-bar{height:10px;border-radius:6px;background:var(--line);overflow:hidden}
.cf-d-fill{height:100%;width:0;background:var(--on);transition:width .15s linear}
.cf-d-status{min-height:1.3em}
.cf-d-result{display:grid;gap:8px;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
.cf-d-result p{color:var(--ink)}
.cf-d-result .cf-d-warn,.cf-detect .cf-d-warn{color:var(--warn)}
.cf-detect input[type=file]{display:none}
`;

const CANCEL = Symbol('cancelado');
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
const isolate = node => { for (const type of ['keydown', 'keyup', 'keypress']) node.addEventListener(type, event => event.stopPropagation()); return node; };
const SOURCES = [
  ['tracks', 'Pistas cargadas'],
  ['files', 'Archivos de audio'],
  ['live', 'Mientras suena'],
];
const HELP = {
  tracks: 'Lee el audio de las pistas de la canción, tal como las tiene Escena. No hace falta que suene, pero la canción debe estar parada o en pausa. Tarda de unos segundos a un minuto, según lo larga que sea.',
  files: 'Elige los archivos de audio de la canción: cada pista suelta, o la mezcla completa. Tienen que empezar en el mismo punto que la secuencia.',
  live: 'Pulsa «Empezar a escuchar» y luego ▶ en Escena. Deja correr la canción (entera, si puedes) y no cambies de pestaña: Escena va anotando los acordes mientras suena. Lo que esté silenciado o sin volumen no se oye. No cambia el audio.',
};

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  document.head.append(el('style', { id: STYLE_ID, text: CSS }));
}

// ¿Se puede leer el audio de esta pista? Las normales (AudioBuffer) sí. Las «por bloques» (el motor local de Escena)
// se leen bloque a bloque con getChunk().
const readable = track => {
  const buffer = track.buffer;
  if (!buffer) return false;
  if (buffer.stream) return typeof buffer.getChunk === 'function' && buffer.sampleRate > 0;
  return typeof buffer.getChannelData === 'function';
};

// Para «Mientras suena» no hace falta leer el audio: se escucha lo que sale de cada pista, sea del tipo que sea.
function trackRows(player, { listening = false } = {}) {
  return (player.fileTracks || []).map((track, index) => {
    const name = String(track.def?.name || `Pista ${index + 1}`);
    const kind = classifyTrack(name);
    const cue = track.def?.dest === 'cue'; // las pistas que solo van a los audífonos (guía, click) no llevan armonía
    return { id: `t${index}`, name, track, role: kind === 'bass' ? 'bass' : 'harm', include: kind !== 'skip' && !cue, readable: listening ? true : readable(track) };
  });
}

// Partes iguales en que se divide cada compás: las que corresponden al numerador del compás de la canción (4/4 → 4,
// 3/4 → 3, 6/8 → 2…). Si no se puede saber, 4.
function guessSlots(player, snapshot) {
  try {
    const tempo = player.tempo;
    if (!tempo || typeof tempo.segmentAtTime !== 'function') return 4;
    const offset = Number(player.offset) || 0;
    const votes = new Map();
    for (const start of snapshot.bars) {
      const num = tempo.segmentAtTime(Math.max(0, start - offset))?.num;
      if (num) votes.set(num, (votes.get(num) || 0) + 1);
    }
    let best = 4;
    let top = 0;
    for (const [num, count] of votes) if (count > top) { top = count; best = num; }
    return meterSlots(best);
  } catch {
    return 4;
  }
}

// Abre el panel de detección dentro del panel del cifrado `cf`. Devuelve { close }.
export function openDetector(cf, onClose = () => {}) {
  injectStyles();
  const player = cf.player;
  const root = el('div', { class: 'cf-detect', role: 'dialog', 'aria-label': 'Detectar acordes' });
  const first = trackRows(player);
  const state = {
    // Si ninguna pista se puede leer (formato desconocido), se empieza por «Mientras suena», que siempre sirve.
    source: first.length && !first.some(row => row.readable && row.include) ? 'live' : 'tracks',
    rows: { tracks: first, files: [], live: trackRows(player, { listening: true }) },
    busy: false,
    cancel: false,
    listening: false,
    listener: null,
    offEnded: null,
    result: null,
    progress: 0,
    message: '',
    loud: 0,
    frames: 0,
    opts: { extended: false, unify: true },
    slots: 'auto',
    guess: guessSlots(player, cf.snapshot),
    offset: 0,
    closed: false,
  };
  const ui = {};

  const songInfo = (offset = 0) => ({
    bars: cf.snapshot.bars.map(t => t + offset),
    duration: cf.snapshot.duration + offset,
    sections: cf.snapshot.sections,
  });

  const setProgress = (progress, message) => {
    state.progress = progress;
    if (message !== undefined) state.message = message;
    if (ui.fill) ui.fill.style.width = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
    if (ui.status && message !== undefined) ui.status.textContent = message;
  };

  const close = () => {
    if (state.closed) return;
    state.closed = true;
    state.cancel = true;
    state.offEnded?.();
    state.listener?.stop();
    root.remove();
    onClose();
  };

  // ───────── Resultado ─────────
  function finish(frames, offset) {
    const slots = state.slots === 'auto' ? state.guess : Number(state.slots);
    const result = detectChart(frames, songInfo(offset), { extended: state.opts.extended, unifyRepeats: state.opts.unify, slots });
    state.result = result && result.text ? result : { empty: true };
  }

  function resultView() {
    const result = state.result;
    if (!result) return null;
    if (result.empty) {
      return el('div', { class: 'cf-d-result' },
        el('p', { class: 'cf-d-warn', text: 'No se pudo sacar ningún acorde: el audio parece vacío o no coincide con la secuencia.' }),
        el('div', { class: 'cf-actions' }, el('button', { class: 'cf-tb', type: 'button', onClick: () => { state.result = null; render(); } }, 'Volver')));
    }
    const total = result.bars.length;
    const lines = [];
    if (result.key) {
      const cents = Math.round((result.tuning || 0) * 100);
      lines.push(`Tono probable: ${result.key.text}${Math.abs(cents) >= 8 ? ` · la grabación está afinada ${cents > 0 ? '+' : ''}${cents} centésimas` : ''}`);
    }
    lines.push(`${total} compases, ${total - result.uncertain.length} claros.`);
    const notes = [];
    if (result.uncertain.length) notes.push(`Revisa los compases ${result.uncertain.slice(0, 24).join(', ')}${result.uncertain.length > 24 ? '…' : ''}: salieron menos claros.`);
    if (result.covered < 0.9) notes.push(`Solo se escuchó el ${Math.round(result.covered * 100)} % de la canción; el resto quedó vacío.`);
    const replacing = Boolean(cf.chartText?.().trim());
    return el('div', { class: 'cf-d-result' },
      el('p', { text: lines.join('\n'), style: 'white-space:pre-line' }),
      ...notes.map(text => el('p', { class: 'cf-d-warn', text })),
      el('p', { text: `Es un borrador automático. «${replacing ? 'Reemplazar' : 'Guardar'} y usar» lo pone ya en el panel y en los celulares; «Revisar en el editor» te deja corregirlo antes de guardarlo.${replacing ? ' Esta canción ya tiene un cifrado guardado: se reemplazaría.' : ''}` }),
      el('div', { class: 'cf-actions' },
        el('button', { class: 'cf-tb', type: 'button', onClick: () => { state.result = null; render(); } }, 'Volver'),
        el('button', { class: 'cf-tb', type: 'button', onClick: () => { const text = result.text; close(); cf.edit(text, { detected: true }); } }, 'Revisar en el editor'),
        el('button', { class: 'cf-tb primary', type: 'button', onClick: () => { const text = result.text; close(); cf.saveChart(text); cf.tell('Cifrado guardado: ya se ve en el panel', 'info'); } }, `${replacing ? 'Reemplazar' : 'Guardar'} y usar`)));
  }

  // ───────── Desde datos que ya están en memoria (pistas cargadas o archivos) ─────────
  async function runOffline() {
    const rows = state.rows[state.source].filter(row => row.include && row.readable !== false);
    if (!rows.length) { setProgress(0, 'Elige al menos una pista.'); return; }
    // Las pistas por bloques se leen del almacén local de Escena: con la canción sonando se pelearían con el reproductor.
    if (rows.some(row => row.track?.buffer?.stream) && player.state === 'playing') {
      setProgress(0, 'Pon la canción en pausa para leer sus pistas (o usa «Mientras suena»).');
      return;
    }
    state.busy = true;
    state.cancel = false;
    state.result = null;
    render();
    const cancelled = () => state.cancel;
    const moved = Math.round(player.pitchSemitones || 0);
    try {
      const groups = { harm: new PCMGroup(), bass: new PCMGroup() };
      const members = { harm: 0, bass: 0 };
      const transposed = { harm: 0, bass: 0 }; // pistas de cada grupo que suenan con el tono cambiado
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const role = row.role === 'bass' ? 'bass' : 'harm';
        const from = (i / rows.length) * 0.45;
        const span = 0.45 / rows.length;
        setProgress(from, `Leyendo «${row.name}»…`);
        await pause();
        let mono;
        try {
          if (!row.track) mono = await decodeToMono(row.file, { cancelled });
          else if (row.track.buffer.stream) {
            mono = await streamToMono(row.track.buffer, {
              cancelled: () => state.cancel || player.state === 'playing',
              onProgress: p => setProgress(from + p * span, `Leyendo «${row.name}»… ${Math.round(p * 100)} %`),
            });
            if (!mono && !state.cancel) throw new Error('la canción se puso a sonar mientras se leían las pistas; vuelve a intentarlo con la canción en pausa');
            if (row.track.def?.pitchEnabled !== false) transposed[role]++;
          } else {
            // Con el tono cambiado, el AudioBuffer de la pista ya viene transportado; el original está en originalBuffer.
            const original = row.track.originalBuffer;
            const source = original && !original.stream && typeof original.getChannelData === 'function' ? original : row.track.buffer;
            mono = await bufferToMono(source, { cancelled });
          }
        } catch (error) {
          if (error !== CANCEL && error && typeof error === 'object') error.message = `«${row.name}»: ${error.message}`;
          throw error;
        }
        if (!mono) throw CANCEL;
        groups[role].add(mono.data, mono.rate);
        members[role]++;
      }
      // Las pistas por bloques están ya preparadas en el tono actual: se deshace para que el cifrado quede en el original.
      for (const role of ['harm', 'bass']) groups[role].unshift = moved && transposed[role] * 2 > members[role] ? moved : 0;
      setProgress(0.45, 'Escuchando las notas…');
      const frames = await framesFromGroups(groups, { onProgress: p => setProgress(0.45 + p * 0.5), cancelled });
      if (!frames) throw CANCEL;
      setProgress(0.97, 'Armando el cifrado…');
      await pause();
      finish(frames, state.source === 'files' ? state.offset : 0);
      setProgress(1, 'Listo.');
    } catch (error) {
      if (error !== CANCEL) {
        console.error('Detectar acordes:', error);
        setProgress(0, `No se pudo leer el audio${error?.message ? `: ${error.message}` : ''}. Prueba con «Mientras suena».`);
      } else setProgress(0, 'Cancelado.');
    } finally {
      state.busy = false;
      if (!state.closed) render();
    }
  }

  // ───────── Mientras suena ─────────
  function startListening() {
    const chosen = state.rows.live.filter(row => row.include);
    if (!chosen.length) { setProgress(0, 'Elige al menos una pista.'); return; }
    const roles = new Map(chosen.map(row => [row.track, row.role]));
    state.result = null;
    state.loud = 0;
    state.frames = 0;
    const listener = new LiveListener(player, {
      tracks: chosen.map(row => row.track),
      roleOf: track => roles.get(track),
      onFrame: info => {
        state.frames++;
        if (info.energy > 0) state.loud++;
        const quiet = state.frames >= 60 && state.loud === 0;
        setProgress(info.total ? info.heard / info.total : 0, quiet
          ? 'No oigo nada en estas pistas. ¿Están silenciadas o sin volumen?'
          : `Escuchando… compás ${Math.max(1, info.bar)}, ${info.heard} de ${info.total} compases anotados.`);
      },
    });
    listener.start(songInfo(0));
    state.listener = listener;
    state.listening = true;
    state.offEnded = player.on('ended', () => stopListening());
    setProgress(0, player.state === 'playing' ? 'Escuchando…' : 'Listo: pulsa ▶ en Escena para que empiece a sonar.');
    render();
    document.activeElement?.blur?.();
  }

  async function stopListening() {
    const listener = state.listener;
    if (!listener) return;
    state.listener = null;
    state.listening = false;
    state.offEnded?.();
    state.offEnded = null;
    listener.stop();
    if (state.closed) return;
    if (listener.heard.size < 2 || listener.frames.count < 10) {
      setProgress(0, 'Escuché muy poco. Pulsa ▶ y deja correr la canción antes de terminar.');
      render();
      return;
    }
    state.busy = true;
    setProgress(0.6, 'Armando el cifrado…');
    render();
    await pause();
    try {
      finish(listener.frames, 0);
      setProgress(1, 'Listo.');
    } catch (error) {
      console.error('Detectar acordes:', error);
      setProgress(0, 'No se pudo armar el cifrado con lo que se escuchó.');
    } finally {
      state.busy = false;
      if (!state.closed) render();
    }
  }

  // ───────── Pantalla ─────────
  function rowView(row) {
    const check = isolate(el('input', { type: 'checkbox', checked: row.include && row.readable !== false, disabled: state.busy || state.listening || row.readable === false, 'aria-label': `Incluir ${row.name}`, onChange: event => { row.include = event.target.checked; render(); } }));
    const role = isolate(el('select', { 'aria-label': `Tipo de ${row.name}`, disabled: state.busy || state.listening || row.readable === false, onChange: event => { row.role = event.target.value; } },
      el('option', { value: 'harm', text: 'Armónica' }), el('option', { value: 'bass', text: 'Bajo' })));
    role.value = row.role;
    return el('div', { class: 'cf-d-row', 'data-off': String(!row.include || row.readable === false) },
      el('label', {}, check, el('span', { text: row.name, title: row.name })),
      row.readable === false ? el('small', { text: 'no se puede leer' }) : role);
  }

  function render() {
    if (state.closed) return;
    const locked = state.busy || state.listening;
    const rows = state.rows[state.source];
    const readableRows = rows.filter(row => row.readable !== false);
    const kids = [];
    kids.push(el('h2', { text: `Detectar acordes de «${cf.snapshot.title}»` }));
    kids.push(el('p', { text: 'Escena escucha las pistas y escribe el cifrado compás por compás. Es un borrador automático: lo revisas antes de guardarlo.' }));
    kids.push(el('div', { class: 'cf-d-tabs', role: 'group', 'aria-label': 'De dónde escuchar' },
      ...SOURCES.map(([id, label]) => el('button', { class: 'cf-tb', type: 'button', 'aria-pressed': String(state.source === id), disabled: locked, onClick: () => { state.source = id; state.result = null; setProgress(0, ''); render(); } }, label))));
    kids.push(el('p', { text: HELP[state.source] }));

    if (state.source === 'tracks' && rows.length && !readableRows.length) {
      kids.push(el('p', { class: 'cf-d-warn', text: 'No se pudo leer el audio de estas pistas desde aquí. Usa «Mientras suena» o «Archivos de audio».' }));
    }
    if (state.source === 'tracks' && !rows.length) kids.push(el('p', { class: 'cf-d-warn', text: 'Esta canción no tiene pistas de archivo cargadas.' }));
    if (state.source === 'files') {
      const input = el('input', { type: 'file', accept: 'audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac', multiple: true, 'aria-label': 'Elegir archivos de audio' });
      input.addEventListener('change', () => {
        state.rows.files = [...input.files].map((file, index) => {
          const kind = classifyTrack(file.name);
          return { id: `f${index}`, name: file.name, file, role: kind === 'bass' ? 'bass' : 'harm', include: kind !== 'skip' };
        });
        state.result = null;
        render();
      });
      kids.push(el('div', { class: 'cf-actions', style: 'justify-content:flex-start' },
        el('button', { class: 'cf-tb', type: 'button', disabled: locked, onClick: () => input.click() }, state.rows.files.length ? 'Elegir otros archivos…' : 'Elegir archivos…'), input));
      const offset = isolate(el('input', { type: 'number', step: '0.01', value: String(state.offset), 'aria-label': 'Desfase del audio en segundos', onChange: event => { state.offset = Number(event.target.value) || 0; } }));
      kids.push(el('details', {}, el('summary', { text: 'Si el audio no empieza donde la secuencia' }),
        el('p', { text: 'Normalmente 0. Si el audio trae silencio de más al principio, escribe cuántos segundos (por ejemplo 2). Si al audio le falta el comienzo de la secuencia, escribe los segundos con signo menos (por ejemplo -2).' }),
        el('label', { class: 'cf-d-offset' }, el('span', { text: 'Desfase (s)' }), offset)));
    }
    if (rows.length) kids.push(el('div', { class: 'cf-d-list' }, ...rows.map(rowView)));

    const extended = isolate(el('input', { type: 'checkbox', checked: state.opts.extended, disabled: locked, onChange: event => { state.opts.extended = event.target.checked; } }));
    const unify = isolate(el('input', { type: 'checkbox', checked: state.opts.unify, disabled: locked, onChange: event => { state.opts.unify = event.target.checked; } }));
    const slots = isolate(el('select', { 'aria-label': 'Partes iguales en que se divide cada compás', disabled: locked, onChange: event => { state.slots = event.target.value; } },
      el('option', { value: 'auto', text: `Automático (${state.guess})` }), ...[2, 3, 4, 6].map(n => el('option', { value: String(n), text: String(n) }))));
    slots.value = String(state.slots);
    kids.push(el('div', { class: 'cf-d-opts' },
      el('label', {}, extended, el('span', { text: 'Marcar también 7, m7, maj7 y sus4 (menos seguro)' })),
      el('label', {}, unify, el('span', { text: 'Apoyarse en las secciones que se repiten (Coro, Verso…)' })),
      el('label', {}, el('span', { text: 'Partes del compás' }), slots)));

    ui.fill = el('div', { class: 'cf-d-fill' });
    ui.status = el('p', { class: 'cf-d-status', role: 'status', 'aria-live': 'polite', text: state.message });
    ui.fill.style.width = `${Math.round(state.progress * 100)}%`;
    if (locked || state.message || state.progress) kids.push(el('div', { class: 'cf-d-bar', 'aria-hidden': 'true' }, ui.fill));
    kids.push(ui.status);

    const result = resultView();
    if (result) kids.push(result);

    const actions = [];
    if (state.listening) {
      actions.push(el('button', { class: 'cf-tb primary', type: 'button', onClick: () => stopListening() }, 'Terminar y armar el cifrado'));
      actions.push(el('button', { class: 'cf-tb', type: 'button', onClick: () => { const l = state.listener; state.listener = null; state.listening = false; state.offEnded?.(); l?.stop(); setProgress(0, 'Cancelado.'); render(); } }, 'Cancelar'));
    } else if (state.busy) {
      actions.push(el('button', { class: 'cf-tb', type: 'button', onClick: () => { state.cancel = true; } }, 'Cancelar'));
    } else {
      if (!state.result) {
        const label = state.source === 'live' ? 'Empezar a escuchar' : 'Detectar';
        const can = state.source === 'live' ? rows.some(row => row.include) : readableRows.some(row => row.include);
        actions.push(el('button', { class: 'cf-tb primary', type: 'button', disabled: !can, onClick: () => (state.source === 'live' ? startListening() : runOffline()) }, label));
      }
      actions.push(el('button', { class: 'cf-tb', type: 'button', onClick: close }, 'Cerrar'));
    }
    kids.push(el('div', { class: 'cf-actions' }, ...actions));
    root.replaceChildren(...kids.filter(Boolean));
  }

  (cf.panel || document.body).append(root);
  render();
  return { close, root };
}
