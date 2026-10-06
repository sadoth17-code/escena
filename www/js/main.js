import { app } from './app.js';
import { store } from './store.js';
import { readDropped } from './library.js';
import { installPlatform, platform } from './platform.js';
import { controls } from './controls.js';
import { h } from './util.js';
import { showToast } from './ui/kit.js';
import { createShell } from './ui/shell.js';
import { createPlayerView } from './ui/player-view.js';
import { createMixer } from './ui/mixer.js';
import { createLibraryView } from './ui/library-view.js';
import { createStage } from './ui/stage.js';
import { openImport, importDemo } from './ui/import.js';
import { openEditor } from './ui/editor.js';
import { openSettings } from './ui/settings.js';

function showFatal(error) {
  const root = document.getElementById('app');
  root.replaceChildren(
    h(
      'div',
      { class: 'fatal' },
      h('h1', { text: 'Escena no pudo iniciar' }),
      h('p', { text: error && error.message ? error.message : 'Ocurrió un error inesperado.' }),
      h('p', { class: 'fatal-hint', text: 'Si estás en una ventana privada o de incógnito, ábrela en una ventana normal: la app necesita guardar tus canciones en el dispositivo.' }),
      h('button', { type: 'button', class: 'btn primary', onClick: () => location.reload() }, 'Reintentar')
    )
  );
}

async function boot() {
  try {
    await app.init();
  } catch (error) {
    console.error(error);
    showFatal(error);
    return;
  }

  let shell = null;
  let stage = null;
  let playerView = null;
  let mixer = null;

  const editSong = (song, tab) => openEditor(song, tab);
  const editCurrent = (tab) => {
    if (!app.current) {
      app.toast('Carga una canción para editarla', 'error');
      return;
    }
    openEditor(app.current.song, typeof tab === 'string' ? tab : 'general');
  };
  const startImport = (files) => openImport({ files, onEdit: editSong });
  const makeDemo = async () => {
    try {
      app.toast('Creando canción de prueba…');
      await importDemo();
    } catch (error) {
      app.toast(error.message || 'No se pudo crear la canción de prueba', 'error');
    }
  };
  const openStage = () => {
    if (!app.current) {
      app.toast('Carga una canción para usar el modo escenario', 'error');
      return;
    }
    stage.setEntry(app.current);
    stage.show();
  };

  shell = createShell({ onSettings: openSettings, onStage: openStage });
  stage = createStage();
  playerView = createPlayerView({ onEdit: editCurrent, onImport: () => startImport(null), onDemo: makeDemo });
  mixer = createMixer({ onEdit: editCurrent });
  const library = createLibraryView({ onImport: () => startImport(null), onEdit: editSong });
  shell.panels.lib.append(library.el);
  shell.panels.play.append(playerView.el);
  shell.panels.mix.append(mixer.el);
  document.body.append(stage.el);

  const dropzone = h('div', { class: 'dropzone', hidden: true }, h('div', { class: 'dropzone-card' }, h('b', { text: 'Suelta aquí tus pistas' }), h('span', { text: 'Archivos de audio, una carpeta o un ZIP' })));
  document.body.append(dropzone);
  let dragDepth = 0;
  const hasFiles = (event) => event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth++;
    dropzone.hidden = false;
  });
  window.addEventListener('dragover', (event) => {
    if (hasFiles(event)) event.preventDefault();
  });
  window.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropzone.hidden = true;
  });
  window.addEventListener('drop', async (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    dropzone.hidden = true;
    const entries = await readDropped(event.dataTransfer);
    if (entries.length) startImport(entries);
  });

  app.on('toast', showToast);
  app.on('loading', (state) => {
    if (state && !shell.desktop && shell.tab === 'lib') shell.setTab('play');
    stage.setLoading(state);
    // Si la carga falló y no queda ninguna canción, el modo escenario no tiene nada que mostrar.
    if (!state && !app.current && stage.open) stage.close();
  });
  app.on('song:loaded', (entry) => {
    shell.now.textContent = entry.song.title;
    playerView.setEntry(entry);
    mixer.setEntry(entry);
    stage.setEntry(entry);
    if (!shell.desktop && shell.tab === 'lib') shell.setTab('play');
  });
  app.on('song:unloaded', (info) => {
    shell.now.textContent = '';
    playerView.setEntry(null);
    mixer.setEntry(null);
    stage.setEntry(null);
    // Al cambiar a una canción que hay que cargar, el escenario sigue abierto con el avance de la carga.
    if (stage.open && !(info && info.loading)) stage.close();
  });
  app.on('song:refresh', (entry) => {
    playerView.refresh();
    mixer.setEntry(entry);
    stage.refresh();
    shell.now.textContent = entry.song.title;
  });
  app.on('song:updated', () => {
    playerView.refresh();
    stage.refresh();
  });

  platform.on('update', () =>
    showToast({ message: 'Hay una versión nueva de Escena', action: { label: 'Actualizar', onClick: () => platform.applyUpdate() }, duration: 30000 })
  );

  const frame = (time) => {
    requestAnimationFrame(frame);
    const snap = app.snapshot();
    if (stage.open) {
      stage.frame(snap);
      return;
    }
    if (shell.isVisible('play')) playerView.frame(snap, time);
    if (shell.isVisible('mix')) mixer.frame(snap, time);
  };
  requestAnimationFrame(frame);

  controls.init();
  installPlatform();
  app.startDevices();
  store.requestPersistence();

  window.addEventListener('unhandledrejection', (event) => {
    console.error(event.reason);
  });

  const last = await store.getMeta('last', null);
  if (last && app.songs.has(last.songId)) app.loadSong(last.songId);
  playerView.renderEmpty();

  if (platform.ios && !platform.installed && !(await store.getMeta('iosHint', false))) {
    store.setMeta('iosHint', true).catch(() => {});
    showToast({ message: 'Para usar Escena a pantalla completa: Compartir → Añadir a pantalla de inicio', duration: 9000 });
  }
}

boot();
