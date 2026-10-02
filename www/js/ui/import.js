import { h, fmtBytes } from '../util.js';
import { app } from '../app.js';
import { store } from '../store.js';
import { gatherAudio, groupItems, draftTracks, AUDIO_PATTERN } from '../library.js';
import { buildDemo } from '../demo.js';
import { icon, openModal, field } from './kit.js';

const MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

export async function importDemo() {
  const demo = await buildDemo();
  const song = await app.importSong(demo.title, demo.drafts, null, { tempo: demo.tempo, markers: demo.markers });
  await app.addToSetlist([song.id]);
  await app.loadSong(song.id);
  return song;
}

function detectLabel(state) {
  if (state.detect === 'running') return 'Detectando tempo desde la pista de click…';
  if (state.detect === 'done') return `Tempo detectado desde «${state.detectSource}»: ${state.tempo.bpm} BPM${state.detectMeter ? `, compás de ${state.tempo.num} tiempos` : ''}`;
  if (state.detect === 'none') return 'No se pudo detectar el tempo automáticamente. Escríbelo a mano';
  return 'Si conoces el tempo, escríbelo. Luego podrás afinarlo en Editar → Tempo';
}

export function openImport({ files = null, onEdit } = {}) {
  const state = {
    stage: 'pick',
    items: [],
    skipped: [],
    groups: [],
    title: '',
    drafts: [],
    tempo: { bpm: 120, num: 4, den: 4, offsetMs: 0 },
    tempoTouched: false,
    detect: 'idle',
    detectMeter: false,
    detectSource: '',
    busy: false,
    cancelled: false,
  };

  const modal = openModal({
    title: 'Importar canciones',
    size: 'lg',
    body: h('div'),
    actions: [],
    onClose: () => {
      state.cancelled = true;
    },
  });

  const setBody = (...nodes) => modal.body.replaceChildren(...nodes);

  const filePicker = (attrs, handler) => {
    const input = h('input', { type: 'file', class: 'file-hidden', multiple: true, ...attrs });
    input.addEventListener('change', () => {
      const list = Array.from(input.files || []);
      input.value = '';
      if (list.length) handler(list);
    });
    return input;
  };

  const showPick = () => {
    state.stage = 'pick';
    const audioInput = filePicker({ accept: 'audio/*,.wav,.mp3,.m4a,.aac,.flac,.ogg,.opus,.aif,.aiff,.caf,.zip,application/zip' }, (list) => analyze(list));
    const folderInput = filePicker({ webkitdirectory: true, directory: true }, (list) => analyze(list));
    const choice = (iconName, title, text, onClick, primary) =>
      h('button', { type: 'button', class: `choice ${primary ? 'primary' : ''}`, onClick }, h('span', { class: 'choice-icon' }, icon(iconName, 26)), h('span', { class: 'choice-text' }, h('b', { text: title }), h('span', { text })));
    const choices = [
      choice('file', 'Archivos de audio o ZIP', 'Una pista por archivo (WAV, MP3, FLAC, M4A…). Un ZIP con las pistas también sirve.', () => audioInput.click(), true),
    ];
    if (!MOBILE) choices.push(choice('folder', 'Carpeta', 'Elige la carpeta de una canción, o una carpeta con una subcarpeta por canción.', () => folderInput.click()));
    choices.push(
      choice('music', 'Canción de prueba', 'Crea una canción de ejemplo para comprobar la salida dividida (click a un lado, pistas al otro).', async () => {
        modal.close();
        try {
          await importDemo();
          app.toast('Canción de prueba lista. Pulsa ▶ para escucharla');
        } catch (error) {
          app.toast(error.message || 'No se pudo crear la canción de prueba', 'error');
        }
      })
    );
    setBody(
      h('p', { class: 'modal-text', text: 'Cada pista (batería, bajo, teclados, click, guías…) debe ser un archivo de audio independiente y todas con el mismo inicio.' }),
      h('div', { class: 'choices' }, choices),
      MOBILE ? null : h('p', { class: 'field-hint center', text: 'En PC también puedes arrastrar archivos o carpetas sobre la ventana.' }),
      audioInput,
      folderInput
    );
    modal.setActions([{ label: 'Cancelar', onClick: (api) => api.close() }]);
  };

  const showWorking = (text, detail) => {
    state.stage = 'working';
    setBody(h('div', { class: 'working' }, h('div', { class: 'spinner' }), h('b', { text }), h('span', { class: 'working-detail', text: detail || '' }), h('div', { class: 'progress' }, h('i', { class: 'work-bar' }))));
    modal.setActions([]);
  };

  const setProgress = (done, total, detail) => {
    const bar = modal.body.querySelector('.work-bar');
    const text = modal.body.querySelector('.working-detail');
    if (bar) bar.style.width = `${total ? (done / total) * 100 : 5}%`;
    if (text && detail !== undefined) text.textContent = detail;
  };

  const analyze = async (list) => {
    showWorking('Leyendo archivos…', '');
    try {
      const result = await gatherAudio(list, (index, total, name) => setProgress(index - 1, total, name));
      if (state.cancelled) return;
      state.items = result.items;
      state.skipped = result.skipped;
      if (!result.items.length) {
        showEmpty(result.skipped);
        return;
      }
      state.groups = groupItems(result.items).map((group) => ({ ...group, keep: true }));
      if (state.groups.length === 1) {
        state.title = state.groups[0].title;
        state.drafts = draftTracks(state.groups[0].items);
        showSingle();
        startDetection();
      } else {
        showMulti();
      }
    } catch (error) {
      showError(error.message || 'No se pudieron leer los archivos');
    }
  };

  const showEmpty = (skipped) => {
    setBody(
      h('div', { class: 'notice warn' }, icon('info', 20), h('div', {}, h('b', { text: 'No se encontraron archivos de audio' }), h('p', { text: skipped.length ? `Se ignoraron ${skipped.length} archivo(s) que no son audio.` : 'Elige archivos WAV, MP3, FLAC, M4A, OGG o AIFF, o un ZIP que los contenga.' })))
    );
    modal.setActions([{ label: 'Volver', onClick: showPick }, { label: 'Cerrar', onClick: (api) => api.close() }]);
  };

  const showError = (message) => {
    setBody(h('div', { class: 'notice error' }, icon('info', 20), h('div', {}, h('b', { text: 'No se pudo importar' }), h('p', { text: message }))));
    modal.setActions([{ label: 'Volver', onClick: showPick }, { label: 'Cerrar', onClick: (api) => api.close() }]);
  };

  const startDetection = async () => {
    const clickDraft = state.drafts.find((draft) => draft.click && draft.keep);
    if (!clickDraft) return;
    state.detect = 'running';
    refreshDetect();
    try {
      const result = await app.analyzeBlob(clickDraft.item.blob);
      if (state.cancelled || state.stage !== 'single') return;
      if (result && !state.tempoTouched) {
        state.tempo.bpm = result.bpm;
        state.tempo.offsetMs = result.offsetMs;
        if (result.num) state.tempo.num = result.num;
        state.detectMeter = Boolean(result.num);
        state.detect = 'done';
        state.detectSource = clickDraft.name;
        syncTempoInputs();
      } else {
        state.detect = result ? 'done' : 'none';
        state.detectSource = clickDraft.name;
      }
    } catch (error) {
      state.detect = 'none';
    }
    refreshDetect();
  };

  let detectEl = null;
  let tempoInputs = null;

  const refreshDetect = () => {
    if (detectEl) {
      detectEl.textContent = detectLabel(state);
      detectEl.classList.toggle('ok', state.detect === 'done');
    }
  };

  const syncTempoInputs = () => {
    if (!tempoInputs) return;
    tempoInputs.bpm.value = String(state.tempo.bpm);
    tempoInputs.offset.value = String(state.tempo.offsetMs);
    tempoInputs.num.value = String(state.tempo.num);
  };

  const totalSize = (drafts) => drafts.filter((draft) => draft.keep).reduce((sum, draft) => sum + draft.item.blob.size, 0);

  const showSingle = async () => {
    state.stage = 'single';
    const title = h('input', { type: 'text', class: 'input', value: state.title, 'aria-label': 'Título', maxlength: '80', onInput: () => (state.title = title.value) });
    const bpm = h('input', {
      type: 'number',
      class: 'input num',
      min: '20',
      max: '400',
      step: '0.01',
      inputmode: 'decimal',
      value: String(state.tempo.bpm),
      'aria-label': 'BPM',
      onInput: () => {
        state.tempo.bpm = Number(bpm.value) || 120;
        state.tempoTouched = true;
      },
    });
    const num = h('input', {
      type: 'number',
      class: 'input num',
      min: '1',
      max: '32',
      step: '1',
      inputmode: 'numeric',
      value: String(state.tempo.num),
      'aria-label': 'Tiempos por compás',
      onInput: () => {
        state.tempo.num = Math.max(1, Math.min(32, Math.round(Number(num.value) || 4)));
        state.tempoTouched = true;
      },
    });
    const den = h('select', { class: 'select', 'aria-label': 'Figura del compás', onChange: () => (state.tempo.den = Number(den.value)) }, [2, 4, 8, 16].map((value) => h('option', { value: String(value), text: String(value), selected: value === state.tempo.den })));
    const offset = h('input', {
      type: 'number',
      class: 'input num',
      step: '1',
      inputmode: 'numeric',
      value: String(state.tempo.offsetMs),
      'aria-label': 'Inicio del compás 1 en milisegundos',
      onInput: () => {
        state.tempo.offsetMs = Math.max(0, Number(offset.value) || 0);
        state.tempoTouched = true;
      },
    });
    tempoInputs = { bpm, offset, num };
    detectEl = h('p', { class: 'field-hint detect' });
    const sizeLine = h('p', { class: 'field-hint' });
    const list = h('div', { class: 'draft-list' });
    const updateSize = async () => {
      const total = totalSize(state.drafts);
      const estimate = await store.usage().catch(() => ({ used: 0, quota: 0 }));
      const low = estimate.quota && total > estimate.quota - estimate.used;
      sizeLine.textContent = `${state.drafts.filter((draft) => draft.keep).length} pistas · ${fmtBytes(total)}${low ? ' · Puede que no haya espacio suficiente en este dispositivo' : ''}`;
      sizeLine.classList.toggle('bad', Boolean(low));
    };
    for (const draft of state.drafts) {
      const keep = h('input', { type: 'checkbox', class: 'check', checked: draft.keep, 'aria-label': `Incluir ${draft.name}`, onChange: () => {
        draft.keep = keep.checked;
        row.classList.toggle('off', !draft.keep);
        updateSize();
      } });
      const name = h('input', { type: 'text', class: 'input', value: draft.name, 'aria-label': 'Nombre de la pista', maxlength: '60', onInput: () => (draft.name = name.value) });
      const dest = h('button', { type: 'button', class: `dest ${draft.dest === 'cue' ? 'cue' : ''}`, title: 'Destino de la pista: Sala (público) o Cue (músicos)', text: draft.dest === 'cue' ? 'CUE' : 'SALA', onClick: () => {
        draft.dest = draft.dest === 'cue' ? 'main' : 'cue';
        dest.textContent = draft.dest === 'cue' ? 'CUE' : 'SALA';
        dest.classList.toggle('cue', draft.dest === 'cue');
      } });
      const mono = h('label', { class: 'check-label', title: 'Mezcla la pista a mono para ahorrar memoria' }, h('input', { type: 'checkbox', class: 'check', checked: draft.mono, onChange: (event) => (draft.mono = event.target.checked) }), 'Mono');
      const row = h('div', { class: 'draft' }, keep, name, dest, mono, h('span', { class: 'draft-size', text: fmtBytes(draft.item.blob.size) }));
      list.append(row);
    }
    setBody(
      field('Título de la canción', title),
      h('div', { class: 'tempo-grid' }, field('BPM', bpm), field('Compás', h('div', { class: 'sig' }, num, h('span', { text: '/' }), den)), field('Inicio del compás 1 (ms)', offset)),
      detectEl,
      h('h3', { class: 'sub', text: 'Pistas' }),
      list,
      sizeLine,
      state.skipped.length ? h('p', { class: 'field-hint', text: `Se ignoraron ${state.skipped.length} archivo(s) que no son audio.` }) : null
    );
    refreshDetect();
    updateSize();
    modal.setActions([
      { label: 'Volver', onClick: showPick },
      { label: 'Importar', kind: 'primary', icon: 'upload', onClick: () => runImport() },
    ]);
  };

  const showMulti = () => {
    state.stage = 'multi';
    const list = h('div', { class: 'draft-list' });
    for (const group of state.groups) {
      const keep = h('input', { type: 'checkbox', class: 'check', checked: group.keep, 'aria-label': `Importar ${group.title}`, onChange: () => (group.keep = keep.checked) });
      const title = h('input', { type: 'text', class: 'input', value: group.title, 'aria-label': 'Título', maxlength: '80', onInput: () => (group.title = title.value) });
      const size = group.items.reduce((sum, item) => sum + item.blob.size, 0);
      list.append(h('div', { class: 'draft group' }, keep, title, h('span', { class: 'draft-size', text: `${group.items.length} pistas · ${fmtBytes(size)}` })));
    }
    setBody(
      h('p', { class: 'modal-text', text: `Se encontraron ${state.groups.length} carpetas con audio. Cada una se importará como una canción.` }),
      list,
      h('p', { class: 'field-hint', text: 'Los destinos Sala/Cue se asignan por el nombre (click, guía, cue → Cue). Si hay una pista de click, el tempo se detecta solo. Podrás revisar todo en Editar canción.' })
    );
    modal.setActions([
      { label: 'Volver', onClick: showPick },
      { label: 'Importar todas', kind: 'primary', icon: 'upload', onClick: () => runImport() },
    ]);
  };

  const runImport = async () => {
    const groups = state.stage === 'single' ? [{ title: state.title, drafts: state.drafts, tempo: state.tempo, keep: true }] : state.groups.filter((group) => group.keep).map((group) => ({ title: group.title, drafts: draftTracks(group.items), tempo: null, keep: true }));
    const chosen = groups.filter((group) => group.drafts.some((draft) => draft.keep));
    if (!chosen.length) {
      app.toast('Elige al menos una pista', 'error');
      return;
    }
    showWorking('Importando…', '');
    const songs = [];
    try {
      for (let g = 0; g < chosen.length; g++) {
        const group = chosen[g];
        const prefix = chosen.length > 1 ? `(${g + 1}/${chosen.length}) ${group.title} · ` : '';
        let tempo = group.tempo;
        if (!tempo) {
          const clickDraft = group.drafts.find((draft) => draft.click && draft.keep);
          if (clickDraft) {
            setProgress(0, 1, `${prefix}Detectando tempo…`);
            const result = await app.analyzeBlob(clickDraft.item.blob).catch(() => null);
            if (result) tempo = { bpm: result.bpm, num: result.num || 4, den: 4, offsetMs: result.offsetMs };
          }
        }
        const song = await app.importSong(
          group.title,
          group.drafts,
          (done, total, name) => setProgress(done, total, `${prefix}${name}`),
          { tempo }
        );
        songs.push(song);
      }
    } catch (error) {
      for (const song of songs) await app.deleteSong(song.id).catch(() => {});
      showError(error.message || 'No se pudo guardar');
      return;
    }
    await app.addToSetlist(songs.map((song) => song.id));
    modal.close();
    app.loadSong(songs[0].id);
    if (songs.length === 1 && onEdit) {
      app.emit('toast', { message: 'Canción importada. Añade secciones para tener guía de voz', kind: 'info', action: { label: 'Editar', onClick: () => onEdit(songs[0], 'sections') } });
    } else {
      app.toast(songs.length > 1 ? `${songs.length} canciones importadas` : 'Canción importada', 'info');
    }
  };

  if (files && files.length) analyze(files);
  else showPick();
  return modal;
}

export function looksLikeAudio(file) {
  return AUDIO_PATTERN.test(file.name) || /\.zip$/i.test(file.name);
}
