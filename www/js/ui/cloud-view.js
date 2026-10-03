import { h, fmtBytes } from '../util.js';
import { app } from '../app.js';
import { cloud } from '../cloud.js';
import { CLOUD_API_URL } from '../cloud-config.js';
import { icon, openModal, field, confirmDialog } from './kit.js';

const report = error => app.toast(error.message || 'No se pudo completar la operación', 'error');
const act = fn => async () => { try { await fn(); } catch (error) { report(error); } };
const button = (text, fn, kind = '', disabled = false) => h('button', { type: 'button', class: `btn small ${kind}`, disabled, onClick: act(fn) }, text);

export async function openCloudConnection() {
  await cloud.init();
  const address = h('input', { class: 'input', type: 'url', 'aria-label': 'Dirección de tu nube', value: cloud.api || CLOUD_API_URL, placeholder: 'https://escena-nube.tu-cuenta.workers.dev', autocomplete: 'url', spellcheck: 'false' });
  const key = h('input', { class: 'input', type: 'password', 'aria-label': 'Clave de acceso', autocomplete: 'current-password', placeholder: 'Tu clave privada de acceso', spellcheck: 'false' });
  const status = h('p', { class: 'cloud-error', role: 'alert' });
  const form = h('form', {},
    h('p', { class: 'modal-text', text: 'Conecta tu biblioteca privada para guardar y descargar canciones en tus equipos.' }),
    field('Dirección de tu nube', address), field('Clave de acceso', key),
    h('p', { class: 'field-hint', text: 'La clave se conserva durante esta sesión. Las canciones descargadas siguen disponibles al desconectarte.' }),
    !cloud.api ? h('p', { class: 'field-hint', text: 'La primera vez, sigue la guía ACTIVAR-NUBE.html incluida con el proyecto para obtener la dirección y la clave.' }) : null,
    status,
  );
  const modal = openModal({ title: 'Conectar mi nube', body: form });
  let busy = false;
  const submit = async () => {
    if (busy) return; busy = true; status.textContent = 'Conectando…';
    modal.setActions([{ label: 'Conectando…', disabled: true }]);
    try { await cloud.connect(address.value, key.value); key.value = ''; modal.close(); }
    catch (error) { status.textContent = error.message; }
    finally { busy = false; modal.setActions([{ label: 'Conectar', kind: 'primary', onClick: submit }]); }
  };
  form.addEventListener('submit', event => { event.preventDefault(); submit(); });
  modal.setActions([{ label: 'Conectar', kind: 'primary', onClick: submit }]);
  (cloud.api ? key : address).focus();
}

export async function openCloudUpload() {
  await cloud.init();
  if (!cloud.connected) { await openCloudConnection(); return; }
  if (cloud.active) throw new Error('Espera o pausa la transferencia actual');
  const songs = app.songList().sort((a, b) => a.title.localeCompare(b.title, 'es'));
  if (!songs.length) throw new Error('Primero importa una canción en la biblioteca de este dispositivo');
  const select = h('select', { class: 'select', 'aria-label': 'Canción que se subirá' }, songs.map(song => h('option', { value: song.id, text: song.title })));
  const asNew = h('input', { type: 'checkbox', class: 'check' });
  const message = h('p', { class: 'field-hint' });
  const updateMessage = () => {
    const song = app.songs.get(select.value);
    const linked = song?.cloud?.endpoint === cloud.api;
    message.textContent = linked && !asNew.checked ? 'Se publicarán tus ajustes actuales como nueva versión de esta canción. Las otras copias se actualizan al pulsar «Actualizar».' : 'Se creará una canción en tu biblioteca privada. Se incluyen todos los stems, mezcla, tempo, click, guía y secciones.';
  };
  select.addEventListener('change', updateMessage); asNew.addEventListener('change', updateMessage); updateMessage();
  const modal = openModal({ title: 'Subir canción a mi nube', body: h('div', {}, field('Canción del dispositivo', select),
    h('label', { class: 'cloud-checkbox' }, asNew, 'Subir como nueva canción'), message,
    h('p', { class: 'field-hint', text: 'Mantén Escena abierta durante la transferencia. Puedes pausarla y retomarla. Si ya hay una subida pendiente, se reanudará su versión guardada.' })),
    actions: [{ label: 'Subir canción', kind: 'primary', icon: 'upload', onClick: () => {
      const song = app.songs.get(select.value), separate = asNew.checked; modal.close();
      cloud.upload(song, { asNew: separate }).catch(report);
    } }],
  });
}

export function createCloudView() {
  const header = h('div', { class: 'cloud-heading' }, h('div', {}, h('b', { text: 'Tu música, en tus equipos' }), h('p', { text: 'Descarga solo las canciones que vas a usar.' })));
  const tools = h('div', { class: 'cloud-tools' });
  const connection = h('div', { class: 'cloud-connection' });
  const transfers = h('div', { class: 'cloud-transfers', 'aria-live': 'polite' });
  const search = h('input', { type: 'search', class: 'input', placeholder: 'Buscar en la nube…', 'aria-label': 'Buscar en la nube' });
  const count = h('p', { class: 'field-hint' });
  const songs = h('div', { class: 'cloud-songs' });
  const el = h('div', { class: 'cloud-view' }, header, tools, connection, transfers, search, count, songs);
  let seq = 0;
  const render = async () => {
    const current = ++seq;
    if (!cloud.ready) { connection.textContent = 'Preparando biblioteca…'; return; }
    tools.replaceChildren(button('Subir canción', openCloudUpload, 'primary', !!cloud.active),
      button('Actualizar lista', () => cloud.refresh(), '', !cloud.connected || cloud.loading),
      button(cloud.connected ? 'Desconectar' : 'Conectar', () => cloud.connected ? cloud.disconnect() : openCloudConnection()));
    connection.replaceChildren(h('span', { class: `cloud-dot ${cloud.connected ? 'on' : ''}` }),
      h('span', { text: cloud.connected ? (navigator.onLine ? 'Nube privada conectada' : 'Sin conexión a internet') : 'Conecta tu nube para subir o descargar' }));
    const progress = cloud.progress;
    transfers.replaceChildren();
    if (progress) {
      const pct = progress.total ? Math.min(100, Math.floor(progress.done / progress.total * 100)) : 0;
      transfers.append(h('div', { class: 'cloud-job active' },
        h('b', { text: `${progress.kind === 'upload' ? 'Subiendo' : 'Descargando'} · ${progress.title}` }),
        h('progress', { max: 100, value: pct, 'aria-label': 'Progreso de transferencia' }),
        h('span', { class: 'field-hint', text: `${pct}% · ${fmtBytes(progress.done)} de ${fmtBytes(progress.total)}` }),
        h('span', { class: 'field-hint', text: progress.label }),
        cloud.retry ? h('p', { class: 'cloud-error', role: 'status', text: cloud.retry.delay
          ? `Conexión interrumpida${cloud.retry.status ? ` (HTTP ${cloud.retry.status})` : ''}. Reintento automático ${cloud.retry.attempt}/${cloud.retry.maxAttempts} en ${Math.ceil(cloud.retry.delay / 1000)} s. Avance guardado.`
          : `Reconectando… Intento ${cloud.retry.attempt}/${cloud.retry.maxAttempts}. Avance guardado.` }) : null,
        button('Pausar', () => cloud.pause())));
    }
    const pending = await cloud.pending().catch(() => []);
    if (current !== seq) return;
    for (const job of pending.filter(item => item.id !== cloud.active?.id)) {
      const done = cloud.completedBytes(job), pct = job.total ? Math.min(100, Math.floor(done / job.total * 100)) : 0;
      transfers.append(h('div', { class: 'cloud-job' },
        h('b', { text: `${job.kind === 'upload' ? 'Subida' : 'Descarga'} pendiente · ${job.title}` }),
        h('span', { class: 'field-hint', text: `${pct}% · ${fmtBytes(done)} de ${fmtBytes(job.total)} guardados` }),
        job.lastError ? h('div', {},
          h('p', { class: 'cloud-error', role: 'alert', text: job.lastError.message }),
          h('span', { class: 'field-hint', text: [job.lastError.status ? `HTTP ${job.lastError.status}` : '', job.lastError.code ? `Código ${job.lastError.code}` : '', job.lastError.attempts > 1 ? `${job.lastError.attempts} intentos` : '', job.lastError.label].filter(Boolean).join(' · ') })) : null,
        h('div', { class: 'cloud-tools' },
          button('Reanudar', () => cloud.resume(job), 'primary', !!cloud.active || !cloud.connected),
          button('Descartar', async () => {
            const ok = await confirmDialog({ title: 'Descartar transferencia', message: 'Se eliminará el avance de esta transferencia. Las canciones completas del dispositivo y las versiones publicadas se conservan.', confirm: 'Descartar', danger: true });
            if (ok) await cloud.discard(job);
          }, '', !!cloud.active || (job.kind === 'upload' && !cloud.connected)))));
    }
    const query = search.value.trim().toLowerCase();
    const visible = cloud.catalog.filter(song => `${song.title} ${song.artist}`.toLowerCase().includes(query));
    const bytes = cloud.catalog.reduce((sum, song) => sum + song.size, 0);
    count.textContent = cloud.loading ? 'Consultando nube…' : `${cloud.catalog.length} ${cloud.catalog.length === 1 ? 'canción' : 'canciones'} · ${fmtBytes(bytes)} en la nube${!cloud.connected && cloud.catalog.length ? ' · última lista guardada' : ''}`;
    songs.replaceChildren();
    if (!visible.length) songs.append(h('div', { class: 'cloud-empty' }, icon('cloud', 36), h('b', { text: query ? 'No hay coincidencias' : 'Tu biblioteca en la nube' }),
      h('p', { text: query ? 'Prueba con otro nombre.' : cloud.connected ? 'Sube una canción de tu biblioteca. Aparecerá aquí para descargarla en tus otros equipos.' : 'Conecta tu nube privada. Aquí aparecerán las canciones que hayas subido.' })));
    for (const remote of visible) {
      const local = cloud.local(remote.id), update = local && local.cloud.revision !== remote.revision;
      const pendingSong = pending.some(job => job.kind === 'download' && job.manifest.id === remote.id);
      const state = local ? update ? 'Hay una versión nueva' : 'En este dispositivo' : pendingSong ? 'Descarga pendiente' : 'Disponible en la nube';
      const actions = h('div', { class: 'cloud-tools' });
      if (local) {
        actions.append(button('Abrir', () => app.loadSong(local.id)), button('Al setlist', () => app.addToSetlist([local.id])));
        if (update) actions.append(button('Actualizar', async () => {
          if (await confirmDialog({ title: 'Actualizar canción', message: 'Se sustituirán los audios y ajustes de esta copia por la versión de la nube. Guarda primero en la nube cualquier cambio local que quieras conservar.', confirm: 'Actualizar' })) await cloud.download(remote.id);
        }, 'primary', !!cloud.active || !cloud.connected || pendingSong));
        actions.append(button('Quitar del dispositivo', async () => {
          if (await confirmDialog({ title: 'Liberar espacio', message: `Se quitará «${local.title}» de este dispositivo y sus setlists. La copia de la nube se conserva para descargarla de nuevo.`, confirm: 'Quitar', danger: true })) await app.deleteSong(local.id);
        }, '', !!cloud.active));
      } else actions.append(button('Descargar', () => cloud.download(remote.id), 'primary', !!cloud.active || !cloud.connected || pendingSong));
      songs.append(h('article', { class: 'cloud-card' }, h('b', { text: remote.title }),
        remote.artist ? h('span', { class: 'field-hint', text: remote.artist }) : null,
        h('span', { class: 'field-hint', text: `${remote.tracks} pistas · ${fmtBytes(remote.size)}${remote.bpm ? ` · ${remote.bpm} BPM` : ''}` }),
        h('span', { class: `cloud-badge ${local ? 'downloaded' : ''}`, text: state }), actions));
    }
  };
  const refresh = () => render().catch(report);
  search.addEventListener('input', refresh);
  cloud.on('change', refresh); app.on('songs', refresh);
  window.addEventListener('online', refresh); window.addEventListener('offline', refresh);
  cloud.init().then(refresh).catch(report);
  let entered = false;
  return { el, async show() { await cloud.init(); refresh(); if (cloud.connected && !entered) { entered = true; cloud.refresh().catch(report); } } };
}
