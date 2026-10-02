import { h, fmtTime, fmtBytes, naturalCompare } from '../util.js';
import { app } from '../app.js';
import { songDuration, songBytes } from '../library.js';
import { icon, iconButton, createSegmented, confirmDialog, promptDialog } from './kit.js';

function songMeta(song) {
  const first = song.tempoMap[0];
  const tempo = `${Number(first.bpm.toFixed(1))} BPM${song.tempoMap.length > 1 ? ' +' : ''}`;
  const duration = songDuration(song);
  return [tempo, `${first.num}/${first.den}`, duration > 0 ? fmtTime(duration) : null, `${song.tracks.length} pistas`, fmtBytes(songBytes(song))].filter(Boolean).join(' · ');
}

export function createLibraryView({ onImport, onEdit }) {
  let mode = 'setlist';
  let ordering = false;
  let query = '';

  const modeSwitch = createSegmented({
    options: [
      { value: 'setlist', label: 'Setlist', icon: 'list' },
      { value: 'library', label: 'Biblioteca', icon: 'music' },
    ],
    value: mode,
    label: 'Vista',
    onChange: (value) => {
      mode = value;
      ordering = false;
      render();
    },
  });

  const select = h('select', { class: 'select', 'aria-label': 'Setlist activo', onChange: () => app.setActiveSetlist(select.value) });
  const addList = iconButton({
    name: 'plus',
    label: 'Nueva setlist',
    onClick: async () => {
      const name = await promptDialog({ title: 'Nueva setlist', label: 'Nombre', value: `Setlist ${app.setlists.length + 1}`, confirm: 'Crear' });
      if (name) await app.createSetlist(name);
    },
  });
  const renameList = iconButton({
    name: 'edit',
    label: 'Renombrar setlist',
    onClick: async () => {
      const current = app.activeSetlist();
      const name = await promptDialog({ title: 'Renombrar setlist', label: 'Nombre', value: current.name });
      if (name) await app.renameSetlist(current.id, name);
    },
  });
  const deleteList = iconButton({
    name: 'trash',
    label: 'Eliminar setlist',
    onClick: async () => {
      const current = app.activeSetlist();
      const ok = await confirmDialog({
        title: 'Eliminar setlist',
        message: `Se eliminará «${current.name}». Las canciones seguirán en la biblioteca.`,
        confirm: 'Eliminar',
        danger: true,
      });
      if (ok) await app.deleteSetlist(current.id);
    },
  });
  const orderButton = h('button', { type: 'button', class: 'btn small', 'aria-pressed': 'false', onClick: () => {
    ordering = !ordering;
    render();
  } }, icon('swap', 16), 'Ordenar');
  const countText = h('span', { class: 'lib-count' });
  const setlistBar = h('div', { class: 'lib-bar column' }, h('div', { class: 'lib-select' }, select, addList, renameList, deleteList), h('div', { class: 'lib-sub' }, countText, orderButton));

  const search = h('input', {
    type: 'search',
    class: 'input',
    placeholder: 'Buscar canción…',
    'aria-label': 'Buscar canción',
    onInput: () => {
      query = search.value.trim().toLowerCase();
      render();
    },
  });
  const searchBar = h('div', { class: 'lib-bar' }, search);

  const list = h('div', { class: 'song-list', role: 'list' });
  const importButton = h('button', { type: 'button', class: 'btn primary block', onClick: onImport }, icon('upload', 18), 'Importar canciones');
  const el = h('div', { class: 'lib' }, h('div', { class: 'lib-head' }, modeSwitch.el), setlistBar, searchBar, list, h('div', { class: 'lib-foot' }, importButton));

  const rowFor = (song, { index, inSetlist }) => {
    const current = app.current && app.current.song.id === song.id;
    const row = h('div', { class: 'song-row', role: 'listitem', tabindex: '0', dataset: { id: song.id } });
    const open = () => app.loadSong(song.id);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        open();
      }
    });
    const stop = (fn) => (event) => {
      event.stopPropagation();
      fn();
    };
    const lead = h('span', { class: 'song-num' }, inSetlist ? String(index + 1).padStart(2, '0') : icon('music', 16), h('i', { class: 'eq' }, h('s'), h('s'), h('s')));
    const main = h('div', { class: 'song-main' }, h('b', { class: 'song-title', text: song.title }), h('span', { class: 'song-meta', text: songMeta(song) }));
    const actions = h('div', { class: 'song-actions' });
    if (mode === 'setlist' && ordering) {
      const ids = app.activeSetlist().songIds;
      actions.append(
        iconButton({ name: 'up', label: 'Subir', onClick: stop(() => app.moveInSetlist(index, index - 1)), className: index === 0 ? 'disabled' : '' }),
        iconButton({ name: 'down', label: 'Bajar', onClick: stop(() => app.moveInSetlist(index, index + 1)), className: index === ids.length - 1 ? 'disabled' : '' }),
        iconButton({ name: 'close', label: 'Quitar del setlist', onClick: stop(() => app.removeFromSetlist(index)) })
      );
    } else if (mode === 'library') {
      const already = app.activeSetlist().songIds.includes(song.id);
      actions.append(
        iconButton({
          name: already ? 'check' : 'plus',
          label: already ? 'Ya está en el setlist' : 'Añadir al setlist',
          onClick: stop(() => (already ? app.toast('Ya está en el setlist') : app.addToSetlist([song.id]))),
          className: already ? 'on' : '',
        }),
        iconButton({ name: 'edit', label: 'Editar canción', onClick: stop(() => onEdit(song)) })
      );
    } else {
      actions.append(iconButton({ name: 'edit', label: 'Editar canción', onClick: stop(() => onEdit(song)) }));
    }
    row.append(lead, main, actions);
    if (current) row.classList.add('current');
    return row;
  };

  const openLibrary = () => {
    mode = 'library';
    modeSwitch.set('library');
    ordering = false;
    render();
  };

  const emptyBlock = (title, text, button) => h('div', { class: 'lib-empty' }, h('b', { text: title }), h('p', { text }), button);

  const render = () => {
    const setlists = app.setlists;
    select.replaceChildren(...setlists.map((setlist) => h('option', { value: setlist.id, text: setlist.name })));
    select.value = app.activeSetlistId;
    deleteList.disabled = setlists.length <= 1;
    setlistBar.hidden = mode !== 'setlist';
    searchBar.hidden = mode !== 'library';
    const songsInList = app.setlistSongs();
    const total = songsInList.reduce((sum, song) => sum + songDuration(song), 0);
    countText.textContent = songsInList.length ? `${songsInList.length} ${songsInList.length === 1 ? 'canción' : 'canciones'}${total > 0 ? ` · ${fmtTime(total)}` : ''}` : 'Sin canciones';
    orderButton.classList.toggle('active', ordering);
    orderButton.setAttribute('aria-pressed', ordering ? 'true' : 'false');
    list.replaceChildren();
    if (mode === 'setlist') {
      const songs = app.setlistSongs();
      if (!songs.length) {
        list.append(
          emptyBlock(
            'Setlist vacío',
            app.songs.size ? 'Añade canciones desde la biblioteca.' : 'Importa tus primeras canciones para armar el show.',
            app.songs.size ? h('button', { type: 'button', class: 'btn', onClick: openLibrary }, 'Abrir biblioteca') : null
          )
        );
        return;
      }
      songs.forEach((song, index) => list.append(rowFor(song, { index, inSetlist: true })));
    } else {
      const songs = app
        .songList()
        .filter((song) => !query || `${song.title} ${song.artist}`.toLowerCase().includes(query))
        .sort((a, b) => naturalCompare(a.title, b.title));
      if (!songs.length) {
        list.append(emptyBlock(app.songs.size ? 'Sin resultados' : 'Biblioteca vacía', app.songs.size ? 'Prueba con otra búsqueda.' : 'Aquí aparecerán todas las canciones que importes.', null));
        return;
      }
      songs.forEach((song, index) => list.append(rowFor(song, { index, inSetlist: false })));
    }
    updateStates();
  };

  const updateStates = () => {
    const currentId = app.current ? app.current.song.id : null;
    const loadingId = app.loading ? app.loading.song.id : null;
    const playing = app.player && app.player.state === 'playing';
    for (const row of list.querySelectorAll('.song-row')) {
      const id = row.dataset.id;
      row.classList.toggle('current', id === currentId);
      row.classList.toggle('playing', id === currentId && Boolean(playing));
      row.classList.toggle('loading', id === loadingId);
    }
  };

  app.on('songs', render);
  app.on('setlists', render);
  app.on('song:loaded', updateStates);
  app.on('song:unloaded', updateStates);
  app.on('loading', updateStates);
  app.on('transport', updateStates);
  render();

  return { el, render };
}
