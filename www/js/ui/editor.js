import { h, fmtBytes, fmtTime, clamp, uid } from '../util.js';
import { app } from '../app.js';
import { normalizeTempoEntries, tempoIsShaky, tempoWarning } from '../tempo.js';
import { SECTION_VOICES, VOICE_GROUPS, VOICE_CATALOG, SECTION_COLORS, voiceKeyForName } from '../voices.js';
import { CLICK_SOUNDS, CLICK_GROUPS } from '../synth.js';
import { gatherAudio, draftTracks, isClickName, songBytes, songDuration } from '../library.js';
import { icon, iconButton, openModal, confirmDialog, createSegmented, createSwitch, createSectionPicker, createGuideLanguageSelect, field, settingRow } from './kit.js';
import { createSectionMap } from './section-map.js';

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'tempo', label: 'Tempo' },
  { id: 'sections', label: 'Secciones' },
  { id: 'tracks', label: 'Pistas' },
  { id: 'cues', label: 'Click y guía' },
];

const QUICK_SECTIONS = ['Intro', 'Verso', 'Pre-coro', 'Coro', 'Puente', 'Solo', 'Interludio', 'Instrumental', 'Estribillo', 'Break', 'Final', 'Tag'];

function numberInput({ value, min, max, step = 1, label, onChange, disabled = false, className = '' }) {
  const input = h('input', {
    type: 'number',
    class: `input num ${className}`.trim(),
    min,
    max,
    step,
    value: String(value),
    inputmode: step < 1 ? 'decimal' : 'numeric',
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

  const destroyMap = () => {
    if (sectionMap) sectionMap.destroy();
    sectionMap = null;
    sectionTable = null;
  };

  const content = h('div', { class: 'editor-content' });
  const tabBar = h('div', { class: 'tabs', role: 'tablist' });
  const reopenSections = () => {
    if (active === 'sections') renderSections();
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
    // El inicio del compás 1 admite décimas de milisegundo: la detección automática lo calcula con esa precisión.
    const tenths = (value) => Math.max(0, Math.round(value * 10) / 10);
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
      h('p', { class: 'field-hint', text: 'Indica en qué milisegundo del audio empieza el primer tiempo del compás 1. Con ello el click, la guía y los saltos caen exactos sobre el audio.' }),
      h('div', { class: 'offset-row' }, offset, h('span', { class: 'unit', text: 'ms' }), nudge(-10), nudge(-1), nudge(1), nudge(10)),
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
      h('p', { class: 'field-hint', text: 'Tap tempo ajusta el BPM del primer tramo: toca el botón al ritmo de la canción, al menos 3 veces.' })
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

  const renderers = { general: renderGeneral, tempo: renderTempo, sections: renderSections, tracks: renderTracks, cues: renderCues };

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
