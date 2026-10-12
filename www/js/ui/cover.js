import { h } from '../util.js';
import { normalizeCover, prepareCover } from '../cover.js';

export function updateCover(el, song) {
  const image = normalizeCover(song?.cover);
  const title = song?.title || 'Escena';
  const key = image || title;
  if (el.__cover === key) return;
  el.__cover = key;
  const initial = title.split(/\s+/).filter(Boolean).slice(0, 2).map(word => Array.from(word)[0]).join('').toUpperCase();
  el.replaceChildren(image ? h('img', { src: image, alt: '', decoding: 'async', loading: 'lazy' }) : h('span', { text: initial }));
}

export function createCover(song, size = '') {
  const el = h('span', { class: `song-cover ${size}`, 'aria-hidden': 'true' });
  updateCover(el, song);
  return el;
}

export function createCoverPicker({ value = '', onChange, onBusy = () => {} }) {
  const preview = createCover({ title: 'Portada', cover: value }, 'cover-preview');
  const status = h('p', { class: 'field-hint', role: 'status', text: 'JPG, PNG o WebP. Se recorta al centro y se optimiza para guardar sin conexión.' });
  const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', class: 'file-hidden', 'aria-label': 'Elegir portada de la canción' });
  const choose = h('button', { type: 'button', class: 'btn', onClick: () => file.click() }, 'Elegir portada');
  const remove = h('button', { type: 'button', class: 'btn small', disabled: !value, onClick: async () => {
    value = ''; updateCover(preview, { title: 'Portada' }); remove.disabled = true; await onChange('');
  } }, 'Quitar');
  file.addEventListener('change', async () => {
    const picked = file.files?.[0];
    file.value = '';
    if (!picked) return;
    choose.disabled = remove.disabled = true;
    onBusy(true);
    status.textContent = 'Preparando portada…';
    try {
      value = await prepareCover(picked);
      await onChange(value);
      updateCover(preview, { title: 'Portada', cover: value });
      status.textContent = 'Portada lista';
    } catch (error) { status.textContent = error.message; }
    finally { choose.disabled = false; remove.disabled = !value; onBusy(false); }
  });
  return h('div', { class: 'cover-picker' }, preview,
    h('div', { class: 'cover-picker-actions' }, h('span', { class: 'field-label', text: 'Portada de la canción' }), h('div', { class: 'pitch-controls' }, choose, remove), status), file);
}
