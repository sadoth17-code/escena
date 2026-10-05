import { h, fmtBytes, fmtTime, clamp, uid } from '../util.js';
import { app } from '../app.js';
import { normalizeTempoEntries, tempoIsShaky, tempoWarning } from '../tempo.js';
import { bpmFromMark, findFirstHit, fitGridToAudio, snapToHit } from '../align.js';
import { SECTION_VOICES, VOICE_GROUPS, VOICE_CATALOG, SECTION_COLORS, voiceKeyForName } from '../voices.js';
import { CLICK_SOUNDS, CLICK_GROUPS } from '../synth.js';
import { gatherAudio, draftTracks, isClickName, songBytes, songDuration } from '../library.js';
import { icon, iconButton, openModal, confirmDialog, createSegmented, createSwitch, createSectionPicker, createGuideLanguageSelect, field, settingRow } from './kit.js';
import { createSectionMap, clockText } from './section-map.js';

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'align', label: 'Alinear' },
  { id: 'tempo', label: 'Tempo' },
  { id: 'sections', label: 'Secciones' },
  { id: 'tracks', label: 'Pistas' },
  { id: 'cues', label: 'Click y guía' },
];

const QUICK_SECTIONS = ['Intro', 'Verso', 'Pre-coro', 'Coro', 'Puente', 'Solo', 'Interludio', 'Instrumental', 'Estribillo', 'Break', 'Final', 'Tag'];

// El inicio del compás 1 admite décimas de milisegundo: la detección automática lo calcula con esa precisión.
const tenths = (value) => Math.max(0, Math.round(value * 10) / 10);

const yieldNow = () => new Promise((resolve) => setTimeout(resolve, 0));

function numberInput({ value, min, max, step = 1, label, onChange, disabled = false, className = '' }) {
  const input = h('input', {
    type: 'number',
    class: `input num ${className}`.trim(),
    min,
    max,
    step,
    value: String(value),
    inputmode: step === 'any' || step < 1 ? 'decimal' : 'numeric',
    'aria-label': label,
    disabled,
  });
  input.addEventListener('change', () => {
    const parsed = Number(input.value);
    if (!Number.isFinite(parsed)) {
      input.value = String(value);
      return;
    }
    onChange(parsed);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur();
  });
  return input;
}

export function openEditor(song, tab = 'general') {
  const entry = () => (app.current && app.current.song === song ? app.current : null);
  let active = TABS.some((item) => item.id === tab) ? tab : 'general';
  let dirty = false;
  let sectionMap = null;
  let sectionTable = null;
  let selectedMarkerId = null;
  let magnet = true;
  const history = [];
  // Mensajes y campos de la pestaña Alinear: solo existen mientras esa pestaña está abierta.
  let say = () => {};
  let syncAlignFields = () => {};

  const destroyMap = () => {
    if (sectionMap) sectionMap.destroy();
    sectionMap = null;
    sectionTable = null;
    say = () => {};
    syncAlignFields = () => {};
  };

  const content = h('div', { class: 'editor-content' });
  const tabBar = h('div', { class: 'tabs', role: 'tablist' });
  const reopenSections = () => {
    if (active === 'sections' || active === 'align') renderers[active]();
  };
  const offLoaded = app.on('song:loaded', reopenSections);
  const offUnloaded = app.on('song:unloaded', reopenSections);
  const modal = openModal({
    title: song.title,
    size: 'xl',
    className: 'editor',
    body: h('div', { class: 'editor-body' }, tabBar, content),
    actions: [{ label: 'Listo', kind: 'primary', icon: 'check', onClick: (api) => api.close() }],
    onClose: () => {
      destroyMap();
      offLoaded();
      offUnloaded();
      const current = entry();
      if (current && dirty) app.emit('song:refresh', current);
    },
  });
  const titleEl = modal.el.querySelector('.modal-head h2');

  const changed = (kind) => {
    dirty = true;
    app.updateSong(song, kind);
  };

  const tempoEntries = () => song.tempoMap;
  const commitTempo = () => {
    song.tempoMap = normalizeTempoEntries(song.tempoMap);
    changed('tempo');
  };

  // ---- Alinear: colocar el compás 1 y afinar el tempo mirando la onda ----------------------------------
  const stateNow = () => ({ offsetMs: song.offsetMs, tempoMap: song.tempoMap.map((item) => ({ ...item })) });
  const remember = (before = stateNow()) => {
    history.push(before);
    if (history.length > 40) history.shift();
    syncAlignFields();
  };
  const refreshAfterTempo = () => {
    if (sectionMap) sectionMap.refresh();
    syncAlignFields();
  };
  const offsetLimit = () => {
    const current = entry();
    return current ? Math.max(0, current.player.duration * 1000 - 50) : Infinity;
  };
  const setOffsetMs = (ms) => {
    const next = Math.min(offsetLimit(), tenths(ms));
    if (next === song.offsetMs) {
      syncAlignFields();
      return false;
    }
    song.offsetMs = next;
    changed('tempo');
    refreshAfterTempo();
    return true;
  };
  const nudgeOffset = (delta) => {
    const before = stateNow();
    if (setOffsetMs((Number(song.offsetMs) || 0) + delta)) remember(before);
  };
  const undoLast = () => {
    const state = history.pop();
    if (!state) return;
    song.offsetMs = state.offsetMs;
    song.tempoMap = state.tempoMap;
    commitTempo();
    refreshAfterTempo();
    say('Se deshizo el último cambio.');
  };

  // Marca de tempo: el golpe tocado debería caer justo al inicio de un compás. Con el compás 1 fijo, eso da el BPM exacto.
  const applyTempoMark = (time) => {
    const current = entry();
    if (!current) return;
    const player = current.player;
    const segment = player.tempo.segments[0];
    const bar = Math.round((time - player.offset) / segment.barDur) + 1;
    if (segment.endBar !== Infinity && bar >= segment.endBar) {
      say('Ese punto queda después de un cambio de tempo. Ajusta el tempo de ese tramo en la pestaña Tempo.', 'warn');
      return;
    }
    if (bar < 2) {
      say('Toca más lejos del compás 1, hacia el final de la canción: así el tempo queda más exacto.', 'warn');
      return;
    }
    const first = song.tempoMap[0];
    const bpm = bpmFromMark({ offset: player.offset, markTime: time, bars: bar - 1, beatsPerBar: first.num });
    const change = bpm ? Math.abs(bpm / first.bpm - 1) : 1;
    if (!bpm || change > 0.05) {
      say(`Ese golpe no cae cerca de un inicio de compás (el tempo tendría que cambiar un ${(change * 100).toFixed(1)} %). Acerca la vista y toca el golpe más cercano a una línea de compás.`, 'warn');
      return;
    }
    const before = stateNow();
    const previous = first.bpm;
    first.bpm = Math.round(bpm * 1000) / 1000;
    commitTempo();
    remember(before);
    refreshAfterTempo();
    say(`Tempo ajustado a ${song.tempoMap[0].bpm} BPM (antes ${previous}). El compás ${bar} cae ahora en el golpe que tocaste.`, 'ok');
  };

  const alignApi = {
    setOffset: (ms, snapped) => {
      const before = stateNow();
      if (!setOffsetMs(ms)) return;
      remember(before);
      say(`Compás 1 en ${song.offsetMs} ms${snapped ? ', pegado al golpe' : ''}.`, 'ok');
    },
    nudge: nudgeOffset,
    magnet: () => magnet,
    mark: (time) => applyTempoMark(time),
  };

  const renderGeneral = () => {
    const title = h('input', { type: 'text', class: 'input', value: song.title, maxlength: '80', 'aria-label': 'Título' });
    title.addEventListener('change', () => {
      song.title = title.value.trim() || 'Sin título';
      titleEl.textContent = song.title;
      changed('meta');
    });
    const artist = h('input', { type: 'text', class: 'input', value: song.artist, maxlength: '80', 'aria-label': 'Artista' });
    artist.addEventListener('change', () => {
      song.artist = artist.value.trim();
      changed('meta');
    });
    const key = h('input', { type: 'text', class: 'input', value: song.key, maxlength: '12', placeholder: 'Ej. Am', 'aria-label': 'Tono' });
    key.addEventListener('change', () => {
      song.key = key.value.trim();
      changed('meta');
    });
    const offset = numberInput({
      value: song.offsetMs,
      min: 0,
      step: 0.1,
      label: 'Inicio del compás 1 en milisegundos',
      onChange: (value) => {
        song.offsetMs = tenths(value);
        offset.value = String(song.offsetMs);
        changed('tempo');
      },
    });
    const nudge = (delta) =>
      h('button', {
        type: 'button',
        class: 'btn small',
        text: `${delta > 0 ? '+' : '−'}${Math.abs(delta)}`,
        onClick: () => {
          song.offsetMs = tenths((Number(song.offsetMs) || 0) + delta);
          offset.value = String(song.offsetMs);
          changed('tempo');
        },
      });
    const sources = song.tracks;
    const select = h('select', { class: 'select', 'aria-label': 'Pista para detectar el tempo' }, sources.map((track) => h('option', { value: track.id, text: track.name, selected: track.id === (sources.find((item) => isClickName(item.name)) || sources[0] || {}).id })));
    const result = h('p', { class: 'field-hint detect' });
    const detect = h('button', {
      type: 'button',
      class: 'btn',
      onClick: async () => {
        result.textContent = 'Analizando…';
        result.classList.remove('ok', 'bad', 'warn');
        try {
          const found = await app.analyzeTrack(song, select.value);
          if (!found) {
            result.textContent = 'No se encontró un pulso regular en esta pista. Prueba con la pista de click o escribe el tempo a mano.';
            result.classList.add('bad');
            return;
          }
          song.tempoMap[0].bpm = found.bpm;
          if (found.num) song.tempoMap[0].num = found.num;
          song.offsetMs = found.offsetMs;
          offset.value = String(song.offsetMs);
          commitTempo();
          result.textContent = `Detectado: ${found.bpm} BPM${found.num ? `, compás de ${found.num} tiempos` : ''}, compás 1 en ${found.offsetMs} ms. Ya está aplicado.${tempoWarning(found)}`;
          result.classList.add(tempoIsShaky(found) ? 'warn' : 'ok');
        } catch (error) {
          result.textContent = error.message || 'No se pudo analizar la pista';
          result.classList.add('bad');
        }
      },
    }, icon('target', 18), 'Detectar tempo');
    const remove = h('button', {
      type: 'button',
      class: 'btn danger',
      onClick: async () => {
        const ok = await confirmDialog({ title: 'Eliminar canción', message: `Se eliminará «${song.title}» y sus pistas guardadas en este dispositivo.`, confirm: 'Eliminar', danger: true });
        if (!ok) return;
        modal.close();
        await app.deleteSong(song.id);
        app.toast('Canción eliminada');
      },
    }, icon('trash', 18), 'Eliminar canción');
    const duration = songDuration(song);
    content.replaceChildren(
      field('Título', title),
      h('div', { class: 'grid-2' }, field('Artista', artist), field('Tono', key)),
      h('h3', { class: 'sub', text: 'Alineación del compás 1' }),
      h('p', { class: 'field-hint', text: 'Indica en qué milisegundo del audio empieza el primer tiempo del compás 1. Con ello el click, la guía y los saltos caen exactos sobre el audio. Si prefieres verlo sobre la onda y colocarlo con un toque, usa la pestaña Alinear.' }),
      h('div', { class: 'offset-row' }, offset, h('span', { class: 'unit', text: 'ms' }), nudge(-10), nudge(-1), nudge(1), nudge(10)),
      h('div', { class: 'offset-row' }, h('button', { type: 'button', class: 'btn small', onClick: () => showTab('align') }, icon('flag', 16), 'Alinear sobre la onda')),
      h('h3', { class: 'sub', text: 'Detectar tempo desde una pista de click' }),
      h('div', { class: 'detect-row' }, select, detect),
      result,
      h('h3', { class: 'sub', text: 'Información' }),
      h('p', { class: 'field-hint', text: `${song.tracks.length} pistas · ${fmtBytes(songBytes(song))}${duration ? ` · ${fmtTime(duration)}` : ''}` }),
      h('div', { class: 'danger-zone' }, remove)
    );
  };

  const renderTempo = () => {
    const rows = h('div', { class: 'table tempo-table' });
    const header = h('div', { class: 'trow thead' }, h('span', { text: 'Desde compás' }), h('span', { text: 'BPM' }), h('span', { text: 'Tiempos' }), h('span', { text: 'Figura' }), h('span'));
    rows.append(header);
    tempoEntries().forEach((item, index) => {
      const first = index === 0;
      const bar = numberInput({ value: item.bar, min: 1, step: 1, disabled: first, label: 'Compás de inicio', onChange: (value) => { item.bar = Math.max(1, Math.round(value)); commitTempo(); renderTempo(); } });
      const bpm = numberInput({ value: item.bpm, min: 20, max: 400, step: 0.01, label: 'BPM', onChange: (value) => { item.bpm = clamp(value, 20, 400); commitTempo(); renderTempo(); } });
      const num = numberInput({ value: item.num, min: 1, max: 32, step: 1, label: 'Tiempos por compás', onChange: (value) => { item.num = clamp(Math.round(value), 1, 32); commitTempo(); renderTempo(); } });
      const den = h('select', { class: 'select', 'aria-label': 'Figura', onChange: () => { item.den = Number(den.value); commitTempo(); renderTempo(); } }, [2, 4, 8, 16].map((value) => h('option', { value: String(value), text: String(value), selected: value === item.den })));
      const del = first ? h('span') : iconButton({ name: 'trash', label: 'Quitar cambio', onClick: () => { song.tempoMap.splice(index, 1); commitTempo(); renderTempo(); } });
      rows.append(h('div', { class: 'trow' }, bar, bpm, num, den, del));
    });
    const add = h('button', {
      type: 'button',
      class: 'btn',
      onClick: () => {
        const last = song.tempoMap[song.tempoMap.length - 1];
        song.tempoMap.push({ ...last, bar: last.bar + 8 });
        commitTempo();
        renderTempo();
      },
    }, icon('plus', 18), 'Añadir cambio de tempo o compás');
    let taps = [];
    const tap = h('button', {
      type: 'button',
      class: 'btn tap',
      onClick: () => {
        const now = performance.now();
        if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
        taps.push(now);
        taps = taps.slice(-8);
        if (taps.length >= 3) {
          const average = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
          song.tempoMap[0].bpm = clamp(Math.round((60000 / average) * 10) / 10, 20, 400);
          tapOut.textContent = `${song.tempoMap[0].bpm} BPM`;
          window.clearTimeout(tap.__t);
          tap.__t = window.setTimeout(() => {
            commitTempo();
            renderTempo();
          }, 700);
        } else {
          tapOut.textContent = '…';
        }
      },
    }, 'Tap tempo');
    const tapOut = h('span', { class: 'tap-out', text: '' });
    content.replaceChildren(
      h('p', { class: 'field-hint', text: 'El tempo y el compás cambian a partir del compás indicado. En compases como 6/8 o 12/8 el BPM cuenta corcheas y el click acentúa cada 3.' }),
      rows,
      h('div', { class: 'row-actions' }, add, h('div', { class: 'tap-box' }, tap, tapOut)),
      h('p', { class: 'field-hint', text: 'Tap tempo ajusta el BPM del primer tramo: toca el botón al ritmo de la canción, al menos 3 veces. Para afinarlo viendo la onda, usa la pestaña Alinear.' })
    );
  };

  const markerById = (id) => song.markers.find((marker) => marker.id === id) || null;
  const markerAtBar = (bar, except = null) => song.markers.find((marker) => marker !== except && marker.bar === bar) || null;
  const sortMarkers = () => song.markers.sort((a, b) => a.bar - b.bar);
  const duplicateToast = (bar, other) => app.toast(`Ya hay una sección en el compás ${bar}: ${other.name}`, 'error');

  const nextSectionBar = () => {
    const last = song.markers[song.markers.length - 1];
    return last ? last.bar + 8 : 1;
  };

  const markSelectedRow = () => {
    if (!sectionTable) return;
    for (const row of sectionTable.querySelectorAll('.trow[data-id]')) row.classList.toggle('sel', row.dataset.id === selectedMarkerId);
  };

  const pickMarker = (marker) => {
    const id = marker ? marker.id : null;
    if (id === selectedMarkerId) return;
    selectedMarkerId = id;
    markSelectedRow();
    if (sectionMap) sectionMap.select(id);
  };

  const refreshSections = () => {
    if (active !== 'sections' || !sectionTable) return;
    renderSectionTable();
    if (sectionMap) sectionMap.refresh();
  };

  const moveMarker = (marker, bar) => {
    if (!marker) return false;
    const next = Math.max(1, Math.round(bar));
    if (next === marker.bar) {
      refreshSections();
      return true;
    }
    const other = markerAtBar(next, marker);
    if (other) {
      duplicateToast(next, other);
      refreshSections();
      return false;
    }
    marker.bar = next;
    sortMarkers();
    changed('markers');
    refreshSections();
    return true;
  };

  const slotAfterLast = () => {
    const current = entry();
    let bar = nextSectionBar();
    if (current) bar = Math.min(bar, current.player.tempo.barCount(current.player.duration - current.player.offset));
    return markerAtBar(bar) ? null : bar;
  };

  const addMarker = (label, wanted) => {
    const other = markerAtBar(wanted);
    const bar = other ? slotAfterLast() : wanted;
    if (!bar) {
      duplicateToast(wanted, other);
      return null;
    }
    const key = voiceKeyForName(label);
    const marker = { id: uid(), name: label, bar, voice: key, color: SECTION_COLORS[key] || '#35c9ff' };
    song.markers.push(marker);
    sortMarkers();
    changed('markers');
    refreshSections();
    if (other) app.toast(`El compás ${wanted} ya tiene «${other.name}». «${label}» se añadió en el compás ${bar}: arrastra su banderín o cambia su compás.`);
    return marker;
  };

  const removeMarker = (marker) => {
    const index = song.markers.indexOf(marker);
    if (index < 0) return;
    song.markers.splice(index, 1);
    if (selectedMarkerId === marker.id) selectedMarkerId = null;
    changed('markers');
    refreshSections();
  };

  // Lista de voces agrupada. Las que el idioma de guía elegido no trae se marcan para que no
  // se esperen en vano; la que ya tiene el marcador siempre queda visible.
  const voiceSelect = (marker) => {
    const option = (item) => {
      const missing = !app.voiceAvailable(item.key);
      return h('option', { value: item.key, text: missing ? `${item.label} · sin audio en esta guía` : item.label, selected: item.key === marker.voice });
    };
    const groups = VOICE_GROUPS.map((group) => h('optgroup', { label: group.label }, VOICE_CATALOG.filter((item) => item.group === group.id).map(option)));
    const unknown = marker.voice && !VOICE_CATALOG.some((item) => item.key === marker.voice) ? h('option', { value: marker.voice, text: marker.voice, selected: true }) : null;
    return h('select', { class: 'select', 'aria-label': 'Voz de guía' }, h('option', { value: '', text: 'Sin voz', selected: !marker.voice }), unknown, groups);
  };

  const renderSectionTable = () => {
    const rows = h('div', { class: 'table section-table' });
    rows.append(h('div', { class: 'trow thead' }, h('span', { text: 'Nombre' }), h('span', { text: 'Compás' }), h('span', { text: 'Voz de guía' }), h('span', { text: 'Color' }), h('span')));
    const datalistId = `sections-${uid()}`;
    const list = h('datalist', { id: datalistId }, SECTION_VOICES.map((voice) => h('option', { value: voice.label })));
    for (const marker of song.markers) {
      const name = h('input', { type: 'text', class: 'input', value: marker.name, maxlength: '30', list: datalistId, 'aria-label': 'Nombre de la sección' });
      const voice = voiceSelect(marker);
      const preview = iconButton({ name: 'speaker', label: 'Escuchar voz', onClick: () => marker.voice && app.previewVoice(marker.voice) });
      const color = h('input', { type: 'color', class: 'color', value: marker.color, 'aria-label': 'Color de la sección' });
      const bar = numberInput({
        value: marker.bar,
        min: 1,
        step: 1,
        label: 'Compás de la sección',
        onChange: (value) => moveMarker(marker, value),
      });
      name.addEventListener('change', () => {
        const before = voiceKeyForName(marker.name);
        marker.name = name.value.trim() || 'Sección';
        name.value = marker.name;
        const found = voiceKeyForName(marker.name);
        if (!marker.voice || marker.voice === before) {
          marker.voice = found;
          if (found && SECTION_COLORS[found]) marker.color = SECTION_COLORS[found];
          voice.value = marker.voice;
          color.value = marker.color;
        }
        changed('markers');
        if (sectionMap) sectionMap.refresh();
      });
      voice.addEventListener('change', () => {
        marker.voice = voice.value;
        changed('markers');
        if (marker.voice) app.previewVoice(marker.voice);
      });
      color.addEventListener('change', () => {
        marker.color = color.value;
        changed('markers');
        if (sectionMap) sectionMap.refresh();
      });
      const del = iconButton({ name: 'trash', label: 'Quitar sección', onClick: () => removeMarker(marker) });
      const row = h('div', { class: marker.id === selectedMarkerId ? 'trow sel' : 'trow', dataset: { id: marker.id } }, name, bar, h('div', { class: 'voice-cell' }, voice, preview), color, del);
      row.addEventListener('focusin', () => pickMarker(marker));
      rows.append(row);
    }
    if (!song.markers.length) rows.append(h('div', { class: 'table-empty', text: 'Aún no hay secciones. Añade Intro, Verso, Coro… con el compás donde empiezan.' }));
    sectionTable.replaceChildren(rows, list);
  };

  const renderSections = () => {
    destroyMap();
    const current = entry();
    const intro = h('p', { class: 'field-hint sections-intro', text: 'Cada sección tiene un compás de inicio. La guía de voz anuncia la sección con anticipación, y puedes saltar entre secciones al tocar.' });
    const heading = h('h3', { class: 'sub', text: 'Todas las secciones' });
    sectionTable = h('div', { class: 'section-host' });
    if (selectedMarkerId && !markerById(selectedMarkerId)) selectedMarkerId = null;
    renderSectionTable();
    if (current) {
      sectionMap = createSectionMap({
        song,
        entry: current,
        quick: QUICK_SECTIONS,
        addMarker,
        moveMarker,
        removeMarker,
        selectMarker: pickMarker,
        align: alignApi,
      });
      if (selectedMarkerId) sectionMap.select(selectedMarkerId);
      content.replaceChildren(intro, sectionMap.el, heading, sectionTable);
      return;
    }
    const load = h('button', { type: 'button', class: 'btn small', onClick: () => app.loadSong(song.id) }, icon('play', 16), 'Cargar canción');
    const notice = h('div', { class: 'notice info smap-notice' }, icon('info', 20), h('div', {}, h('b', { text: 'Carga la canción para ver su onda' }), h('p', { text: 'Con la canción cargada verás la forma de onda con zoom y podrás colocar las secciones escuchando. Al cargarla se detiene la que esté sonando.' }), load));
    const quick = h('div', { class: 'quick-add' }, QUICK_SECTIONS.map((label) => h('button', { type: 'button', class: 'chip small', onClick: () => addMarker(label, nextSectionBar()) }, label)), createSectionPicker({ onPick: (label) => addMarker(label, nextSectionBar()) }));
    content.replaceChildren(
      intro,
      notice,
      heading,
      sectionTable,
      h('h3', { class: 'sub', text: 'Añadir sección' }),
      quick,
      h('p', { class: 'field-hint', text: 'Se añade 8 compases después de la última sección; cambia el compás en la tabla.' })
    );
  };

  const buildAlignPanel = () => {
    const message = h('p', { class: 'field-hint detect align-message', role: 'status' });
    say = (text, tone = '') => {
      message.textContent = text;
      message.classList.remove('ok', 'warn', 'bad');
      if (tone) message.classList.add(tone);
    };
    // Los análisis tardan: el botón queda desactivado mientras trabaja y cualquier fallo se cuenta en pantalla.
    const busy = (button, work) => async () => {
      if (button.disabled) return;
      button.disabled = true;
      try {
        await work();
      } catch (error) {
        say(error && error.message ? error.message : 'No se pudo analizar el audio', 'bad');
      } finally {
        button.disabled = false;
      }
    };
    const offsetField = numberInput({
      value: song.offsetMs,
      min: 0,
      step: 0.1,
      label: 'Inicio del compás 1 en milisegundos',
      onChange: (value) => {
        const before = stateNow();
        if (setOffsetMs(value)) {
          remember(before);
          say(`Compás 1 en ${song.offsetMs} ms.`, 'ok');
        } else {
          offsetField.value = String(song.offsetMs);
        }
      },
    });
    const nudgeButton = (delta) =>
      h('button', {
        type: 'button',
        class: 'btn small',
        text: `${delta > 0 ? '+' : '−'}${Math.abs(delta)}`,
        title: `Mover el compás 1 ${Math.abs(delta)} ms ${delta > 0 ? 'después' : 'antes'}`,
        onClick: () => nudgeOffset(delta),
      });

    const firstHitButton = h('button', { type: 'button', class: 'btn' }, icon('target', 18), 'Buscar el primer golpe');
    firstHitButton.addEventListener('click', busy(firstHitButton, async () => {
      const current = entry();
      if (!current) return;
      say('Buscando el primer golpe…');
      const wave = await current.player.prepareWaveform();
      if (!wave) return;
      const hit = findFirstHit(wave.channels, wave.rate, { top: wave.top });
      if (!hit) {
        say('No encontré un golpe claro al inicio de la canción. Toca en la onda el golpe donde cae el primer tiempo del compás 1.', 'warn');
        return;
      }
      const before = stateNow();
      if (setOffsetMs(hit.time * 1000)) remember(before);
      if (sectionMap) sectionMap.focusOn(hit.time);
      say(`Primer golpe encontrado en ${song.offsetMs} ms: ahí queda el compás 1. Si el compás 1 de la música cae en otro golpe, arrastra la bandera hasta él.`, 'ok');
    }));

    const cursorButton = h('button', { type: 'button', class: 'btn' }, icon('flag', 18), 'Poner en el cursor');
    cursorButton.addEventListener('click', busy(cursorButton, async () => {
      const current = entry();
      if (!current) return;
      const player = current.player;
      let time = player.position();
      let snapped = false;
      if (magnet) {
        const wave = await player.prepareWaveform();
        const hit = wave ? snapToHit(wave.channels, wave.rate, time, { radius: 0.12 }) : null;
        if (hit) {
          time = hit.time;
          snapped = true;
        }
      }
      const before = stateNow();
      if (setOffsetMs(time * 1000)) remember(before);
      if (sectionMap) sectionMap.focusOn(time);
      say(`Compás 1 puesto en el cursor (${clockText(time, 3)})${snapped ? ', pegado al golpe más cercano' : ''}.`, 'ok');
    }));

    const listenButton = h('button', { type: 'button', class: 'btn' }, icon('play', 18), 'Escuchar desde el compás 1');
    listenButton.addEventListener('click', async () => {
      const current = entry();
      if (!current) return;
      const player = current.player;
      const lead = Math.min(player.offset, player.tempo.segmentAtBar(1).barDur);
      app.seekExact(player.offset - lead);
      try {
        await player.play({ countIn: false });
      } catch (error) {
        app.toast(error.message || 'No se pudo activar el audio. Toca Escuchar de nuevo.', 'error');
      }
    });

    const magnetSwitch = createSwitch({ value: magnet, label: 'Imán al golpe', onChange: (value) => { magnet = value; } });
    const clickSwitch = createSwitch({
      value: !song.click.mute,
      label: 'Oír el click de Escena',
      onChange: (value) => {
        song.click.mute = !value;
        changed('click');
      },
    });

    const bpmField = numberInput({
      value: song.tempoMap[0].bpm,
      min: 20,
      max: 400,
      step: 'any',
      label: 'BPM del primer tramo',
      onChange: (value) => {
        const before = stateNow();
        song.tempoMap[0].bpm = clamp(value, 20, 400);
        commitTempo();
        remember(before);
        refreshAfterTempo();
        say(`Tempo en ${song.tempoMap[0].bpm} BPM.`, 'ok');
      },
    });
    const numField = numberInput({
      value: song.tempoMap[0].num,
      min: 1,
      max: 32,
      step: 1,
      label: 'Tiempos por compás',
      onChange: (value) => {
        const before = stateNow();
        song.tempoMap[0].num = clamp(Math.round(value), 1, 32);
        commitTempo();
        remember(before);
        refreshAfterTempo();
        say(`${song.tempoMap[0].num} tiempos por compás.`, 'ok');
      },
    });

    const fineButton = h('button', { type: 'button', class: 'btn' }, icon('wave', 18), 'Afinar con toda la canción');
    fineButton.addEventListener('click', busy(fineButton, async () => {
      const current = entry();
      if (!current) return;
      const player = current.player;
      const first = song.tempoMap[0];
      say('Analizando toda la canción… puede tardar unos segundos.');
      const wave = await player.prepareWaveform();
      if (!wave) return;
      const segment = player.tempo.segments[0];
      const until = segment.endBar === Infinity ? Infinity : player.offset + (segment.endBar - segment.startBar) * segment.barDur;
      const result = await fitGridToAudio(wave.channels, wave.rate, { bpm: first.bpm, offset: player.offset, duration: player.duration, until, pause: yieldNow });
      if (!result) {
        say('No encontré suficientes golpes para afinar. Usa «Ajustar con un compás lejano» o escribe el BPM.', 'warn');
        return;
      }
      const share = Math.round(result.coverage * 100);
      const far = Math.abs(result.bpm / first.bpm - 1) > 0.03;
      if (!result.reliable || far) {
        const spread = result.sigmaMs > 6 ? ` y se separan unos ${result.sigmaMs} ms de un pulso fijo` : '';
        say(`No pude afinarlo con seguridad: solo ${result.used} de ${result.beats} tiempos (${share} %) caen sobre un golpe claro${spread}. Revisa que el BPM esté cerca del real, o usa «Ajustar con un compás lejano».`, 'warn');
        return;
      }
      const before = stateNow();
      const previous = first.bpm;
      first.bpm = result.bpm;
      song.offsetMs = Math.min(offsetLimit(), tenths(result.offsetMs));
      commitTempo();
      remember(before);
      refreshAfterTempo();
      say(`Afinado: ${song.tempoMap[0].bpm} BPM (antes ${previous}) y compás 1 en ${song.offsetMs} ms. ${result.used} de ${result.beats} tiempos (${share} %) caen sobre un golpe, con una desviación típica de ${result.sigmaMs} ms.`, 'ok');
    }));

    const markButton = h('button', { type: 'button', class: 'btn' }, icon('flag', 18), 'Ajustar con un compás lejano');
    markButton.addEventListener('click', () => {
      if (!sectionMap) return;
      sectionMap.arm('mark');
      sectionMap.focusEnd();
      say('Estás al final de la canción. Toca el golpe que cae justo al inicio de un compás; si no lo ves, acerca o aleja con la rueda del mouse o pellizcando.');
    });

    const undoButton = h('button', { type: 'button', class: 'btn', disabled: true, onClick: () => undoLast() }, icon('swap', 18), 'Deshacer');

    syncAlignFields = () => {
      offsetField.value = String(song.offsetMs);
      bpmField.value = String(song.tempoMap[0].bpm);
      numField.value = String(song.tempoMap[0].num);
      undoButton.disabled = history.length === 0;
    };
    syncAlignFields();

    const hasOwnClick = song.tracks.some((track) => isClickName(track.name));
    const toggle = (label, hint, control) => h('div', { class: 'align-toggle', title: hint }, h('span', { text: label }), control);
    return h(
      'div',
      { class: 'align-panel' },
      message,
      h(
        'div',
        { class: 'align-group' },
        h('div', { class: 'align-line' }, h('strong', { class: 'align-title', text: 'Compás 1' }), offsetField, h('span', { class: 'unit', text: 'ms' }), nudgeButton(-10), nudgeButton(-1), nudgeButton(-0.1), nudgeButton(0.1), nudgeButton(1), nudgeButton(10)),
        h('div', { class: 'align-actions' }, firstHitButton, cursorButton, listenButton),
        h(
          'div',
          { class: 'align-toggles' },
          toggle('Imán al golpe', 'La bandera se pega sola al golpe más cercano. Mantén Alt al arrastrar para soltarla.', magnetSwitch.el),
          toggle('Click de Escena', hasOwnClick ? 'Esta canción trae su propia pista de click: apágalo para no oír dos.' : 'Así oyes la cuadrícula contra la música al pulsar Escuchar.', clickSwitch.el)
        )
      ),
      h(
        'div',
        { class: 'align-group' },
        h('div', { class: 'align-line' }, h('strong', { class: 'align-title', text: 'Tempo' }), bpmField, h('span', { class: 'unit', text: 'BPM' }), numField, h('span', { class: 'unit', text: 'tiempos por compás' })),
        h('div', { class: 'align-actions' }, fineButton, markButton, undoButton),
        h('p', { class: 'field-hint', text: 'Afinar corrige pequeñas diferencias de BPM con todos los golpes de la canción. Si hacia el final la cuadrícula se separa de la música, usa «Ajustar con un compás lejano»: ve al final, toca el golpe que cae en un inicio de compás y el tempo se calcula solo. Los cambios de tempo se hacen en la pestaña Tempo.' })
      )
    );
  };

  const renderAlign = () => {
    destroyMap();
    const current = entry();
    const intro = h('p', { class: 'field-hint sections-intro', text: 'Coloca el compás 1 justo en el golpe donde empieza la música. Así el click, la guía de voz y los saltos de sección caen sobre la canción, aunque tenga un silencio al principio.' });
    if (!current) {
      const load = h('button', { type: 'button', class: 'btn small', onClick: () => app.loadSong(song.id) }, icon('play', 16), 'Cargar canción');
      const notice = h('div', { class: 'notice info smap-notice' }, icon('info', 20), h('div', {}, h('b', { text: 'Carga la canción para ver su onda' }), h('p', { text: 'Con la canción cargada verás su onda y la cuadrícula de compases, y podrás colocar el compás 1 sobre el primer golpe. Al cargarla se detiene la que esté sonando.' }), load));
      content.replaceChildren(intro, notice);
      return;
    }
    const panel = buildAlignPanel();
    sectionMap = createSectionMap({
      song,
      entry: current,
      mode: 'align',
      align: alignApi,
      addMarker,
      moveMarker,
      removeMarker,
      selectMarker: pickMarker,
    });
    content.replaceChildren(sectionMap.el, sectionMap.info, panel);
  };

  const renderTracks = () => {
    const list = h('div', { class: 'table track-table' });
    song.tracks.forEach((track, index) => {
      const name = h('input', { type: 'text', class: 'input', value: track.name, maxlength: '60', 'aria-label': 'Nombre de la pista' });
      name.addEventListener('change', () => {
        track.name = name.value.trim() || `Pista ${index + 1}`;
        changed('meta');
      });
      const dest = h('button', {
        type: 'button',
        class: `dest ${track.dest === 'cue' ? 'cue' : ''}`,
        text: track.dest === 'cue' ? 'CUE' : 'SALA',
        title: 'Destino: Sala (público) o Cue (músicos)',
        onClick: () => {
          track.dest = track.dest === 'cue' ? 'main' : 'cue';
          dest.textContent = track.dest === 'cue' ? 'CUE' : 'SALA';
          dest.classList.toggle('cue', track.dest === 'cue');
          changed('routing');
        },
      });
      const mono = h('label', { class: 'check-label', title: 'Mezcla la pista a mono para ahorrar memoria (se recarga la canción)' }, h('input', {
        type: 'checkbox',
        class: 'check',
        checked: track.mono,
        onChange: async (event) => {
          track.mono = event.target.checked;
          dirty = true;
          await app.saveSong(song, true);
          await app.reloadIfCurrent(song.id);
        },
      }), 'Mono');
      const up = iconButton({ name: 'up', label: 'Subir', className: index === 0 ? 'disabled' : '', onClick: () => move(index, -1) });
      const down = iconButton({ name: 'down', label: 'Bajar', className: index === song.tracks.length - 1 ? 'disabled' : '', onClick: () => move(index, 1) });
      const del = iconButton({
        name: 'trash',
        label: 'Quitar pista',
        onClick: async () => {
          const ok = await confirmDialog({ title: 'Quitar pista', message: `Se quitará «${track.name}» de esta canción.`, confirm: 'Quitar', danger: true });
          if (!ok) return;
          dirty = true;
          await app.removeTrack(song, track.id);
          renderTracks();
        },
      });
      list.append(h('div', { class: 'trow track-row' }, h('i', { class: 'swatch', style: { background: track.color } }), name, dest, mono, h('span', { class: 'draft-size', text: fmtBytes(track.bytes) }), h('div', { class: 'row-buttons' }, up, down, del)));
    });
    const move = (index, delta) => {
      const target = index + delta;
      if (target < 0 || target >= song.tracks.length) return;
      const [item] = song.tracks.splice(index, 1);
      song.tracks.splice(target, 0, item);
      const current = entry();
      if (current) current.player.fileTracks.sort((a, b) => song.tracks.indexOf(a.def) - song.tracks.indexOf(b.def));
      dirty = true;
      app.saveSong(song, true);
      renderTracks();
    };
    const picker = h('input', { type: 'file', class: 'file-hidden', multiple: true, accept: 'audio/*,.wav,.mp3,.m4a,.aac,.flac,.ogg,.opus,.aif,.aiff,.caf,.zip' });
    picker.addEventListener('change', async () => {
      const files = Array.from(picker.files || []);
      picker.value = '';
      if (!files.length) return;
      try {
        const result = await gatherAudio(files);
        if (!result.items.length) {
          app.toast('No se encontraron archivos de audio', 'error');
          return;
        }
        app.toast('Añadiendo pistas…');
        dirty = true;
        await app.addTracks(song, draftTracks(result.items));
        renderTracks();
      } catch (error) {
        app.toast(error.message || 'No se pudieron añadir las pistas', 'error');
      }
    });
    const add = h('button', { type: 'button', class: 'btn', onClick: () => picker.click() }, icon('plus', 18), 'Añadir pistas');
    content.replaceChildren(
      h('p', { class: 'field-hint', text: 'Sala = lo que oye el público. Cue = lo que oyen los músicos (click, guías). El orden de aquí es el de la mezcla.' }),
      list,
      h('div', { class: 'row-actions' }, add),
      picker
    );
  };

  const renderCues = () => {
    const click = song.click;
    const guide = song.guide;
    const soundOption = (sound) => h('option', { value: sound.id, text: sound.name, selected: sound.id === click.sound });
    const soundSelect = h(
      'select',
      { class: 'select', 'aria-label': 'Sonido del click' },
      CLICK_GROUPS.map((group) => h('optgroup', { label: group.label }, CLICK_SOUNDS.filter((sound) => sound.group === group.id).map(soundOption)))
    );
    soundSelect.addEventListener('change', async () => {
      const value = soundSelect.value;
      // Los sonidos de muestra se cargan antes de usarlos para que el click no suene como otro.
      await app.ensureClickSound(value);
      click.sound = value;
      changed('click');
      app.previewSound(value);
    });
    const preview = h('button', { type: 'button', class: 'btn small', onClick: () => app.previewSound(click.sound) }, icon('speaker', 16), 'Escuchar');
    const subdivision = createSegmented({
      options: [
        { value: 1, label: 'Tiempos' },
        { value: 2, label: 'Corcheas' },
        { value: 3, label: 'Tresillos' },
        { value: 4, label: 'Semicorcheas' },
      ],
      value: click.subdivision,
      label: 'Subdivisión del click',
      onChange: (value) => {
        click.subdivision = value;
        changed('click');
      },
    });
    const countIn = createSegmented({
      options: [0, 1, 2, 3, 4].map((value) => ({ value, label: value === 0 ? 'Ninguno' : `${value} comp.` })),
      value: click.countIn,
      label: 'Compases de pre-conteo',
      onChange: (value) => {
        click.countIn = value;
        changed('meta');
      },
    });
    const clickOn = createSwitch({ value: !click.mute, label: 'Click durante la canción', onChange: (value) => { click.mute = !value; changed('click'); } });
    const guideOn = createSwitch({ value: !guide.mute, label: 'Guía durante la canción', onChange: (value) => { guide.mute = !value; changed('guide'); } });
    const counting = createSwitch({ value: guide.counting, label: 'Contar tiempos tras la sección', onChange: (value) => { guide.counting = value; changed('guide'); } });
    const lead = createSegmented({
      options: [0, 1, 2].map((value) => ({ value, label: value === 0 ? 'En la sección' : `${value} comp. antes` })),
      value: guide.leadBars,
      label: 'Anticipación de la guía',
      onChange: (value) => {
        guide.leadBars = value;
        changed('guide');
      },
    });
    const languageSelect = createGuideLanguageSelect({
      value: app.settings.guideLang,
      onChange: async (value) => {
        await app.setGuideLanguage(value);
        app.previewVoice('coro');
      },
    });
    const hasOwnClick = song.tracks.some((track) => isClickName(track.name));
    const ownClickNotice = h('div', { class: 'notice info' }, icon('info', 20), h('div', {}, h('b', { text: 'Esta canción trae su propia pista de click' }), h('p', { text: 'El click de Escena está silenciado durante la canción para no duplicarlo; el pre-conteo sí suena.' })));
    content.replaceChildren(
      ...(hasOwnClick ? [ownClickNotice] : []),
      h('h3', { class: 'sub', text: 'Click' }),
      settingRow('Click durante la canción', 'Metrónomo generado desde el mapa de tempo', clickOn.el),
      field('Sonido', h('div', { class: 'inline' }, soundSelect, preview)),
      field('Subdivisión', subdivision.el),
      field('Pre-conteo al iniciar desde el principio', countIn.el),
      h('h3', { class: 'sub', text: 'Guía de voz' }),
      settingRow('Guía durante la canción', 'Dice el nombre de cada sección antes de que llegue', guideOn.el),
      field('Idioma de la voz', languageSelect, 'Se aplica a todas las canciones de este dispositivo. También está en Ajustes.'),
      field('Anticipación', lead.el),
      settingRow('Contar tiempos', 'Tras el nombre, cuenta 2, 3, 4…', counting.el)
    );
  };

  const renderers = { general: renderGeneral, align: renderAlign, tempo: renderTempo, sections: renderSections, tracks: renderTracks, cues: renderCues };

  const showTab = (id) => {
    active = id;
    destroyMap();
    for (const button of tabBar.children) {
      const on = button.dataset.tab === id;
      button.classList.toggle('active', on);
      button.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    renderers[id]();
    content.scrollTop = 0;
  };

  for (const item of TABS) {
    tabBar.append(h('button', { type: 'button', class: 'tab-btn', role: 'tab', dataset: { tab: item.id }, onClick: () => showTab(item.id) }, item.label));
  }
  showTab(active);
  return modal;
}
