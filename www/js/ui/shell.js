import { h, $ } from '../util.js';
import { icon, iconButton } from './kit.js';
import { access } from '../access.js';
import { offline } from '../offline.js';
import { cloud } from '../cloud.js';

const MARK = `<svg viewBox="0 0 64 64" width="28" height="28" aria-hidden="true"><g stroke-linecap="round" stroke-width="5" fill="none"><path stroke="#35c9ff" d="M12 26v12M21 19v26M30 12v40M46 17v30M55 25v14"/><path stroke="#ffb020" d="M38 7v50"/></g></svg>`;

const TABS = [
  { id: 'play', label: 'Tocar', icon: 'wave' },
  { id: 'mix', label: 'Mezcla', icon: 'mixer' },
  { id: 'lib', label: 'Setlist', icon: 'list' },
  { id: 'dj', label: 'DJ', icon: 'disc' },
];

export function createShell({ onSettings, onStage, onAccess, onTab }) {
  // La hoja de estilos del DJ se pide desde el principio (es pequeña y queda guardada para usar sin internet):
  // así su pestaña y su botón se ven bien desde el primer toque, aunque el DJ se cargue después.
  if (!document.getElementById('dj-styles')) document.head.append(h('link', { id: 'dj-styles', rel: 'stylesheet', href: new URL('../../css/dj.css', import.meta.url).href }));
  const root = $('#app');
  root.replaceChildren();
  const mark = h('span', { class: 'brand-mark' });
  mark.innerHTML = MARK;
  const now = h('div', { class: 'now' });
  const network = h('span', { class: 'network-badge', role: 'status' });
  const accessButton = h('button', { type: 'button', class: 'btn small access-launcher', onClick: onAccess }, icon('shield', 16), h('span'));
  const refreshStatus = () => {
    const online = offline.online && !cloud.offline;
    network.textContent = online ? 'Con conexión' : 'Sin conexión';
    network.classList.toggle('is-offline', !online);
    const role = cloud.identity?.role;
    accessButton.querySelector('span:last-child').textContent = role === 'player' ? 'Músico' : access.canEdit ? role === 'owner' ? 'Propietario' : 'Editor' : 'Edición bloqueada';
    accessButton.title = `${cloud.identity?.name || 'Acceso'} · Controles de edición de este equipo`;
    document.body.dataset.access = access.canEdit ? 'master' : 'player';
  };
  access.on('change', refreshStatus);
  offline.on('network', refreshStatus);
  cloud.on('change', refreshStatus);
  refreshStatus();
  const topbar = h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'brand' }, mark, h('span', { class: 'brand-name', text: 'Escena' })),
    now,
    h('div', { class: 'top-actions' }, network, accessButton, iconButton({ name: 'stage', label: 'Modo escenario', onClick: onStage }), iconButton({ name: 'sliders', label: 'Ajustes', onClick: onSettings }))
  );
  const panels = {
    lib: h('aside', { class: 'panel panel-lib', 'aria-label': 'Setlist y biblioteca' }),
    play: h('section', { class: 'panel panel-play', 'aria-label': 'Reproducción' }),
    mix: h('section', { class: 'panel panel-mix', 'aria-label': 'Mezcla' }),
    dj: h('section', { class: 'panel panel-dj', 'aria-label': 'DJ' }),
  };
  const layout = h('main', { class: 'layout', dataset: { tab: 'play' } }, panels.lib, h('div', { class: 'stack' }, panels.play, panels.mix, panels.dj));
  const buttons = new Map();
  const tabbar = h(
    'nav',
    { class: 'tabbar', role: 'tablist', 'aria-label': 'Secciones' },
    TABS.map((tab) => {
      const button = h('button', { type: 'button', class: 'tab', role: 'tab', onClick: () => api.setTab(tab.id) }, icon(tab.icon, 22), h('span', { text: tab.label }));
      buttons.set(tab.id, button);
      return button;
    })
  );
  root.append(topbar, layout, tabbar);
  const media = window.matchMedia('(min-width: 960px)');
  const api = {
    root,
    panels,
    now,
    get tab() {
      return layout.dataset.tab;
    },
    get desktop() {
      return media.matches;
    },
    setTab(id) {
      const previous = layout.dataset.tab;
      layout.dataset.tab = id;
      root.dataset.tab = id;
      for (const [key, button] of buttons) {
        button.classList.toggle('active', key === id);
        button.setAttribute('aria-selected', key === id ? 'true' : 'false');
      }
      if (previous !== id && onTab) onTab(id, previous);
    },
    // Punto de aviso en una pestaña (por ejemplo, el DJ sigue sonando).
    setBadge(id, on) {
      const button = buttons.get(id);
      if (button) button.classList.toggle('has-badge', Boolean(on));
    },
    isVisible(name) {
      const tab = layout.dataset.tab;
      if (tab === 'dj') return name === 'dj';
      if (name === 'dj') return false;
      return media.matches ? name === 'lib' || (tab === 'mix' ? name === 'mix' : name === 'play') : tab === name;
    },
  };
  api.setTab('play');
  return api;
}
