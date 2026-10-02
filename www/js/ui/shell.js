import { h, $ } from '../util.js';
import { icon, iconButton } from './kit.js';

const MARK = `<svg viewBox="0 0 64 64" width="28" height="28" aria-hidden="true"><g stroke-linecap="round" stroke-width="5" fill="none"><path stroke="#35c9ff" d="M12 26v12M21 19v26M30 12v40M46 17v30M55 25v14"/><path stroke="#ffb020" d="M38 7v50"/></g></svg>`;

const TABS = [
  { id: 'play', label: 'Tocar', icon: 'wave' },
  { id: 'mix', label: 'Mezcla', icon: 'mixer' },
  { id: 'lib', label: 'Setlist', icon: 'list' },
];

export function createShell({ onSettings, onStage }) {
  const root = $('#app');
  root.replaceChildren();
  const mark = h('span', { class: 'brand-mark' });
  mark.innerHTML = MARK;
  const now = h('div', { class: 'now' });
  const topbar = h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'brand' }, mark, h('span', { class: 'brand-name', text: 'Escena' })),
    now,
    h('div', { class: 'top-actions' }, iconButton({ name: 'stage', label: 'Modo escenario', onClick: onStage }), iconButton({ name: 'sliders', label: 'Ajustes', onClick: onSettings }))
  );
  const panels = {
    lib: h('aside', { class: 'panel panel-lib', 'aria-label': 'Setlist y biblioteca' }),
    play: h('section', { class: 'panel panel-play', 'aria-label': 'Reproducción' }),
    mix: h('section', { class: 'panel panel-mix', 'aria-label': 'Mezcla' }),
  };
  const layout = h('main', { class: 'layout', dataset: { tab: 'play' } }, panels.lib, h('div', { class: 'stack' }, panels.play, panels.mix));
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
      layout.dataset.tab = id;
      root.dataset.tab = id;
      for (const [key, button] of buttons) {
        button.classList.toggle('active', key === id);
        button.setAttribute('aria-selected', key === id ? 'true' : 'false');
      }
    },
    isVisible(name) {
      return media.matches || layout.dataset.tab === name;
    },
  };
  api.setTab('play');
  return api;
}
