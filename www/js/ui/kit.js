import { h, clamp, faderToDb, gainToFader, fmtDb, fmtPan, FADER_DEFAULT } from '../util.js';
import { VOICE_GROUPS, VOICE_CATALOG, GUIDE_LANGUAGES } from '../voices.js';

const STROKE = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const SOLID = 'fill="currentColor" stroke="none"';

const PATHS = {
  cloud: [STROKE, '<path d="M7 18H6a4 4 0 0 1-.6-8A6.5 6.5 0 0 1 18 8.5 4.8 4.8 0 0 1 18 18h-1M12 12v9M9 15l3-3 3 3"/>'],
  play: [SOLID, '<path d="M7 4.5v15l12-7.5z"/>'],
  pause: [SOLID, '<rect x="6" y="4.5" width="4.2" height="15" rx="1.2"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1.2"/>'],
  stop: [SOLID, '<rect x="6" y="6" width="12" height="12" rx="2"/>'],
  skipNext: [SOLID, '<path d="M5.5 5.5v13l9-6.5z"/><rect x="16.5" y="5.5" width="2.6" height="13" rx="1.1"/>'],
  skipPrev: [SOLID, '<path d="M18.5 5.5v13l-9-6.5z"/><rect x="4.9" y="5.5" width="2.6" height="13" rx="1.1"/>'],
  sectionNext: [STROKE, '<path d="M6 6l6 6-6 6M13 6l6 6-6 6"/>'],
  sectionPrev: [STROKE, '<path d="M18 6l-6 6 6 6M11 6l-6 6 6 6"/>'],
  loop: [STROKE, '<path d="M17 2.5l3.5 3.5L17 9.5"/><path d="M3.5 11V9.5A3.5 3.5 0 0 1 7 6h13.5"/><path d="M7 21.5L3.5 18 7 14.5"/><path d="M20.5 13v1.5A3.5 3.5 0 0 1 17 18H3.5"/>'],
  click: [STROKE, '<path d="M8.2 21h7.6L13.9 4.5h-3.8z"/><path d="M12 15l4.2-8.5"/><circle cx="16.4" cy="6.3" r="0.8" fill="currentColor"/>'],
  guide: [STROKE, '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>'],
  sliders: [STROKE, '<path d="M4 6h8M18 6h2M4 12h2M12 12h8M4 18h10M20 18h0"/><circle cx="15" cy="6" r="2.2"/><circle cx="9" cy="12" r="2.2"/><circle cx="17" cy="18" r="2.2"/>'],
  stage: [STROKE, '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'],
  lock: [STROKE, '<rect x="5" y="11" width="14" height="10" rx="2.2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'],
  unlock: [STROKE, '<rect x="5" y="11" width="14" height="10" rx="2.2"/><path d="M8 11V8a4 4 0 0 1 7.4-2.1"/>'],
  plus: [STROKE, '<path d="M12 5v14M5 12h14"/>'],
  minus: [STROKE, '<path d="M5 12h14"/>'],
  trash: [STROKE, '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'],
  edit: [STROKE, '<path d="M4 20l1-4.2L16.2 4.6l3.2 3.2L8.2 19z"/><path d="M14 6.8l3.2 3.2"/>'],
  up: [STROKE, '<path d="M6 15l6-6 6 6"/>'],
  down: [STROKE, '<path d="M6 9l6 6 6-6"/>'],
  close: [STROKE, '<path d="M6 6l12 12M18 6L6 18"/>'],
  check: [STROKE, '<path d="M5 12.5l4.5 4.5L19 7.5"/>'],
  folder: [STROKE, '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.2h7.5A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>'],
  file: [STROKE, '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>'],
  music: [STROKE, '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>'],
  upload: [STROKE, '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>'],
  download: [STROKE, '<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>'],
  list: [STROKE, '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="0.9" fill="currentColor"/><circle cx="4" cy="12" r="0.9" fill="currentColor"/><circle cx="4" cy="18" r="0.9" fill="currentColor"/>'],
  mixer: [STROKE, '<path d="M6 4v16M12 4v16M18 4v16"/><circle cx="6" cy="14" r="2" fill="currentColor"/><circle cx="12" cy="8" r="2" fill="currentColor"/><circle cx="18" cy="16" r="2" fill="currentColor"/>'],
  wave: [STROKE, '<path d="M3 12h2.2l2-6 3.2 12 3-9 2 5 1.6-3H21"/>'],
  info: [STROKE, '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6h.01"/>'],
  target: [STROKE, '<circle cx="12" cy="12" r="3.2"/><path d="M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21"/>'],
  speaker: [STROKE, '<path d="M4 9.5v5h3.8L13 18.5v-13L7.8 9.5z"/><path d="M16.2 9.2a4 4 0 0 1 0 5.6M18.8 6.6a7.6 7.6 0 0 1 0 10.8"/>'],
  grip: [SOLID, '<circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/>'],
  more: [SOLID, '<circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/>'],
  keyboard: [STROKE, '<rect x="2.5" y="6" width="19" height="12" rx="2.2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'],
  pedal: [STROKE, '<path d="M5 19l2-9h10l2 9z"/><path d="M9 10V6.5a3 3 0 0 1 6 0V10"/>'],
  shield: [STROKE, '<path d="M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z"/><path d="M9 12l2.2 2.2L15.5 10"/>'],
  swap: [STROKE, '<path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5"/>'],
  share: [STROKE, '<path d="M12 15V4M8 8l4-4 4 4"/><path d="M5 13v6.5h14V13"/>'],
};

export function icon(name, size = 20) {
  const span = document.createElement('span');
  span.className = 'ico';
  const entry = PATHS[name] || PATHS.info;
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false" ${entry[0]}>${entry[1]}</svg>`;
  return span;
}

export function iconButton({ name, label, onClick, size = 20, className = '' }) {
  return h('button', { type: 'button', class: `icon-btn ${className}`.trim(), 'aria-label': label, title: label, onClick }, icon(name, size));
}

let modalSeq = 0;

function focusables(root) {
  return Array.from(root.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter((el) => el.offsetParent !== null);
}

export function openModal({ title, body, actions = [], size = 'md', dismissible = true, onClose, className = '' }) {
  const previous = document.activeElement;
  const titleId = `modal-title-${++modalSeq}`;
  let closed = false;
  const bodyEl = h('div', { class: 'modal-body' }, body);
  const footEl = h('footer', { class: 'modal-foot' });
  const closeButton = dismissible ? iconButton({ name: 'close', label: 'Cerrar', onClick: () => api.close() }) : null;
  const dialog = h(
    'div',
    { class: `modal size-${size} ${className}`.trim(), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
    h('header', { class: 'modal-head' }, h('h2', { id: titleId, text: title }), closeButton),
    bodyEl,
    footEl
  );
  const layer = h('div', { class: 'modal-layer' }, dialog);
  const api = {
    el: dialog,
    body: bodyEl,
    footer: footEl,
    layer,
    setActions(list) {
      footEl.replaceChildren(
        ...list.map((action) =>
          h(
            'button',
            {
              type: 'button',
              class: `btn ${action.kind || ''}`.trim(),
              disabled: action.disabled,
              onClick: (event) => action.onClick(api, event),
            },
            action.icon ? icon(action.icon, 18) : null,
            action.label
          )
        )
      );
      footEl.hidden = !list.length;
    },
    close(result) {
      if (closed) return;
      closed = true;
      layer.remove();
      if (previous && previous.focus && document.contains(previous)) previous.focus({ preventScroll: true });
      if (onClose) onClose(result);
    },
  };
  api.setActions(actions);
  layer.addEventListener('pointerdown', (event) => {
    if (dismissible && event.target === layer) api.close();
  });
  layer.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && dismissible) {
      event.stopPropagation();
      api.close();
      return;
    }
    if (event.key === 'Tab') {
      const items = focusables(dialog);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  document.body.append(layer);
  dialog.focus({ preventScroll: true });
  return api;
}

export function confirmDialog({ title, message, confirm = 'Aceptar', cancel = 'Cancelar', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (value, modal) => {
      answered = true;
      resolve(value);
      modal.close();
    };
    openModal({
      title,
      size: 'sm',
      body: h('p', { class: 'modal-text', text: message }),
      actions: [
        { label: cancel, onClick: (modal) => answer(false, modal) },
        { label: confirm, kind: danger ? 'danger' : 'primary', onClick: (modal) => answer(true, modal) },
      ],
      onClose: () => {
        if (!answered) resolve(false);
      },
    });
  });
}

export function promptDialog({ title, label, value = '', confirm = 'Aceptar', placeholder = '' }) {
  return new Promise((resolve) => {
    let answered = false;
    const input = h('input', { type: 'text', class: 'input', value, placeholder, 'aria-label': label, autocomplete: 'off', maxlength: '80' });
    const submit = (modal) => {
      const text = input.value.trim();
      if (!text) {
        input.focus();
        return;
      }
      answered = true;
      resolve(text);
      modal.close();
    };
    const modal = openModal({
      title,
      size: 'sm',
      body: h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), input),
      actions: [
        {
          label: 'Cancelar',
          onClick: (api) => {
            answered = true;
            resolve(null);
            api.close();
          },
        },
        { label: confirm, kind: 'primary', onClick: submit },
      ],
      onClose: () => {
        if (!answered) resolve(null);
      },
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit(modal);
    });
    input.focus();
    input.select();
  });
}

let toastHost = null;

export function showToast({ message, kind = 'info', action, duration }) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', 'aria-live': 'polite', role: 'status' });
    document.body.append(toastHost);
  }
  const toast = h('div', { class: `toast ${kind}${action ? ' has-action' : ''}` }, h('span', { class: 'toast-text', text: message }));
  const remove = () => toast.remove();
  toast.addEventListener('click', remove);
  if (action) {
    toast.append(
      h('button', {
        type: 'button',
        class: 'toast-action',
        text: action.label,
        onClick: () => {
          action.onClick();
          remove();
        },
      })
    );
  }
  toastHost.append(toast);
  while (toastHost.children.length > 3) toastHost.firstChild.remove();
  window.setTimeout(remove, duration || (kind === 'error' ? 7000 : action ? 12000 : 3600));
  return remove;
}

const FADER_TICKS = [6, 0, -6, -12, -24, -48].map((db) => gainToFader(Math.pow(10, db / 20)));

function attachDoubleTap(el, onDouble, accepts = () => true) {
  let last = null;
  let start = null;
  el.addEventListener('pointerdown', (event) => {
    if (!accepts(event)) { start = null; last = null; return; }
    start = { x: event.clientX, y: event.clientY, time: performance.now() };
  });
  el.addEventListener('pointerup', (event) => {
    if (!start) return;
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    const now = performance.now();
    if (moved < 8 && now - start.time < 350) {
      if (last && now - last < 380) {
        last = null;
        onDouble();
      } else {
        last = now;
      }
    }
    start = null;
  });
  el.addEventListener('pointercancel', () => { start = null; last = null; });
}

export function createFader({ value = FADER_DEFAULT, onInput, label = '' } = {}) {
  const thumb = h('div', { class: 'fader-thumb', title: 'Arrastra esta perilla para ajustar el volumen' });
  const ticks = h(
    'div',
    { class: 'fader-ticks' },
    FADER_TICKS.map((position, index) => h('i', { class: index === 1 ? 'zero' : '', style: { '--p': String(position) } }))
  );
  const el = h(
    'div',
    {
      class: 'fader',
      role: 'slider',
      tabindex: '0',
      'aria-orientation': 'vertical',
      'aria-label': label,
      'aria-valuemin': '0',
      'aria-valuemax': '100',
    },
    h('div', { class: 'fader-rail' }),
    ticks,
    thumb
  );
  let current = value;
  let dragging = false;
  let grab = 0;
  let pointer = null;
  const thumbHeight = () => thumb.offsetHeight || 28;
  const render = () => {
    el.style.setProperty('--v', String(current));
    el.setAttribute('aria-valuenow', String(Math.round(current * 100)));
    el.setAttribute('aria-valuetext', `${fmtDb(current)} dB`);
  };
  const apply = (next, silent = false) => {
    current = clamp(next, 0, 1);
    if (Math.abs(current - FADER_DEFAULT) < 0.012) current = FADER_DEFAULT;
    render();
    if (!silent && onInput) onInput(current);
  };
  const fromPointer = (clientY) => {
    const rect = el.getBoundingClientRect();
    const size = thumbHeight();
    const usable = Math.max(1, rect.height - size);
    return (rect.bottom - size / 2 - clientY) / usable;
  };
  el.addEventListener('pointerdown', (event) => {
    if (pointer || (event.button !== undefined && event.button > 0)) return;
    const touch = event.pointerType === 'touch' || event.pointerType === 'pen';
    // The rail is a scrolling surface on touchscreens, never a jump-to-volume.
    if (touch && !thumb.contains(event.target)) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, touch };
    const rect = el.getBoundingClientRect();
    const size = thumbHeight();
    const center = rect.bottom - size / 2 - (rect.height - size) * current;
    const onThumb = Math.abs(event.clientY - center) <= size * 0.8;
    grab = onThumb ? event.clientY - center : 0;
    dragging = !touch;
    if (!touch) {
      el.setPointerCapture(event.pointerId);
      el.classList.add('active');
    }
    if (!onThumb) apply(fromPointer(event.clientY));
    if (!touch) event.preventDefault();
  });
  el.addEventListener('pointermove', (event) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    if (!dragging) {
      const dx = Math.abs(event.clientX - pointer.x);
      const dy = Math.abs(event.clientY - pointer.y);
      if (dx > 6 && dx >= dy) { pointer = null; return; }
      if (dy < 6 || dy <= dx * 1.2) return;
      dragging = true;
      el.setPointerCapture(event.pointerId);
      el.classList.add('active');
    }
    if (dragging) apply(fromPointer(event.clientY - grab));
  });
  const end = (event) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    pointer = null;
    dragging = false;
    if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
    el.classList.remove('active');
    el.blur();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('lostpointercapture', (event) => {
    // Touch initially captures the thumb. Ignore its bubbled capture transfer.
    if (event.target === el) end(event);
  });
  attachDoubleTap(el, () => apply(FADER_DEFAULT), (event) => event.pointerType === 'mouse');
  el.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 0.05 : 0.01;
    let next = null;
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') next = current + step;
    else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') next = current - step;
    else if (event.key === 'PageUp') next = current + 0.1;
    else if (event.key === 'PageDown') next = current - 0.1;
    else if (event.key === 'Home') next = FADER_DEFAULT;
    else if (event.key === 'End') next = 1;
    if (next === null) return;
    event.preventDefault();
    apply(next);
  });
  render();
  return {
    el,
    get value() {
      return current;
    },
    set(next) {
      if (dragging) return;
      current = clamp(next, 0, 1);
      render();
    },
  };
}

export function createPan({ value = 0, onInput, label = 'Paneo' } = {}) {
  const thumb = h('div', { class: 'pan-thumb' });
  const el = h(
    'div',
    { class: 'pan', role: 'slider', tabindex: '0', 'aria-label': label, 'aria-valuemin': '-100', 'aria-valuemax': '100' },
    h('div', { class: 'pan-rail' }),
    h('i', { class: 'pan-center' }),
    thumb
  );
  let current = value;
  let dragging = false;
  let grab = 0;
  const thumbWidth = () => thumb.offsetWidth || 16;
  const render = () => {
    el.style.setProperty('--v', String((current + 1) / 2));
    el.setAttribute('aria-valuenow', String(Math.round(current * 100)));
    el.setAttribute('aria-valuetext', fmtPan(current));
  };
  const apply = (next, silent = false) => {
    current = clamp(next, -1, 1);
    if (Math.abs(current) < 0.06) current = 0;
    else current = Math.round(current * 100) / 100;
    render();
    if (!silent && onInput) onInput(current);
  };
  const fromPointer = (clientX) => {
    const rect = el.getBoundingClientRect();
    const size = thumbWidth();
    const usable = Math.max(1, rect.width - size);
    return ((clientX - rect.left - size / 2) / usable) * 2 - 1;
  };
  el.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button > 0) return;
    el.setPointerCapture(event.pointerId);
    const rect = el.getBoundingClientRect();
    const size = thumbWidth();
    const center = rect.left + size / 2 + (rect.width - size) * ((current + 1) / 2);
    const onThumb = Math.abs(event.clientX - center) <= size * 0.9;
    grab = onThumb ? event.clientX - center : 0;
    dragging = true;
    el.classList.add('active');
    if (!onThumb) apply(fromPointer(event.clientX));
    event.preventDefault();
  });
  el.addEventListener('pointermove', (event) => {
    if (dragging) apply(fromPointer(event.clientX - grab));
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('active');
    el.blur();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  attachDoubleTap(el, () => apply(0));
  el.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 0.1 : 0.02;
    let next = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = current + step;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = current - step;
    else if (event.key === 'Home') next = 0;
    if (next === null) return;
    event.preventDefault();
    apply(next);
  });
  render();
  return {
    el,
    get value() {
      return current;
    },
    set(next) {
      if (dragging) return;
      current = clamp(next, -1, 1);
      render();
    },
  };
}

export function createMeterBar() {
  const fill = h('div', { class: 'meter-fill' });
  const peak = h('div', { class: 'meter-peak' });
  const el = h('div', { class: 'meter', 'aria-hidden': 'true' }, fill, peak);
  let held = 0;
  let heldAt = 0;
  let shown = -1;
  return {
    el,
    set(level, now) {
      const position = level > 0.00099 ? clamp((20 * Math.log10(level) + 60) / 60, 0, 1) : 0;
      if (position >= held || now - heldAt > 900) {
        held = position;
        heldAt = now;
      }
      const key = Math.round(position * 200) * 1000 + Math.round(held * 200);
      if (key === shown) return;
      shown = key;
      fill.style.clipPath = `inset(${((1 - position) * 100).toFixed(1)}% 0 0 0)`;
      peak.style.bottom = `${held * 100}%`;
      peak.style.opacity = held > 0.01 ? '1' : '0';
      el.classList.toggle('hot', position > 0.97);
    },
  };
}

export function createSegmented({ options, value, onChange, label = '', className = '' }) {
  const buttons = new Map();
  const el = h('div', { class: `segmented ${className}`.trim(), role: 'radiogroup', 'aria-label': label });
  let current = value;
  const render = () => {
    for (const [key, button] of buttons) {
      const active = key === current;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', active ? 'true' : 'false');
    }
  };
  for (const option of options) {
    const button = h(
      'button',
      {
        type: 'button',
        class: 'seg',
        role: 'radio',
        onClick: () => {
          if (current === option.value) return;
          current = option.value;
          render();
          onChange(option.value);
        },
      },
      option.icon ? icon(option.icon, 16) : null,
      option.label
    );
    buttons.set(option.value, button);
    el.append(button);
  }
  render();
  return {
    el,
    set(next) {
      current = next;
      render();
    },
  };
}

export function createSwitch({ value = false, onChange, label = '' }) {
  let current = value;
  const el = h('button', {
    type: 'button',
    class: 'switch',
    role: 'switch',
    'aria-label': label,
    'aria-checked': current ? 'true' : 'false',
    onClick: () => {
      current = !current;
      render();
      onChange(current);
    },
  }, h('i'));
  const render = () => {
    el.classList.toggle('on', current);
    el.setAttribute('aria-checked', current ? 'true' : 'false');
  };
  render();
  return {
    el,
    set(next) {
      current = Boolean(next);
      render();
    },
  };
}

export function createRange({ min, max, step = 1, value, onInput, format = (v) => String(v), label = '' }) {
  const input = h('input', { type: 'range', class: 'range', min, max, step, value, 'aria-label': label });
  const out = h('output', { class: 'range-value', text: format(Number(value)) });
  const paint = () => {
    const ratio = (Number(input.value) - Number(min)) / (Number(max) - Number(min));
    input.style.setProperty('--fill', `${clamp(ratio, 0, 1) * 100}%`);
    out.textContent = format(Number(input.value));
  };
  input.addEventListener('input', () => {
    paint();
    onInput(Number(input.value));
  });
  input.addEventListener('pointerup', () => input.blur());
  paint();
  const el = h('div', { class: 'range-wrap' }, input, out);
  return {
    el,
    input,
    set(next) {
      input.value = String(next);
      paint();
    },
  };
}

// Lista desplegable con todas las voces de sección e indicación. Al elegir una llama a onPick(nombre)
// y vuelve al texto inicial, para poder elegir la misma otra vez.
export function createSectionPicker({ onPick, placeholder = 'Más secciones…' }) {
  const groups = VOICE_GROUPS.map((group) =>
    h('optgroup', { label: group.label }, VOICE_CATALOG.filter((voice) => voice.group === group.id).map((voice) => h('option', { value: voice.label, text: voice.label })))
  );
  const select = h('select', { class: 'select section-picker', 'aria-label': 'Añadir otra sección o indicación' }, h('option', { value: '', text: placeholder }), groups);
  select.addEventListener('change', () => {
    const label = select.value;
    select.value = '';
    if (label) onPick(label);
  });
  return select;
}

// Lista de idiomas de la guía de voz. Se aplica a todas las canciones del dispositivo.
export function createGuideLanguageSelect({ value, onChange }) {
  const select = h(
    'select',
    { class: 'select', 'aria-label': 'Idioma de la guía de voz' },
    GUIDE_LANGUAGES.map((language) => h('option', { value: language.id, text: language.name, selected: language.id === value }))
  );
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

export function field(label, control, hint) {
  return h('div', { class: 'field' }, h('span', { class: 'field-label', text: label }), control, hint ? h('span', { class: 'field-hint', text: hint }) : null);
}

export function settingRow(title, detail, control) {
  return h('div', { class: 'setting-row' }, h('div', { class: 'setting-text' }, h('strong', { text: title }), detail ? h('span', { text: detail }) : null), h('div', { class: 'setting-control' }, control));
}

export function dbLabel(position) {
  return faderToDb(position) === -Infinity ? '-∞' : fmtDb(position);
}

export const setText = (node, value) => {
  if (node.__v !== value) {
    node.__v = value;
    node.textContent = value;
  }
};

export const setClass = (node, name, on) => {
  const key = `__c_${name}`;
  if (node[key] !== on) {
    node[key] = on;
    node.classList.toggle(name, on);
  }
};
