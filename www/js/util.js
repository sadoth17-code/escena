export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'style' && typeof value === 'object') {
      for (const [name, item] of Object.entries(value)) {
        if (name.startsWith('--')) el.style.setProperty(name, String(item));
        else el.style[name] = item;
      }
    }
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') el.value = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const lerp = (a, b, t) => a + (b - a) * t;
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function uid() {
  const random = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36).slice(-5);
  return `${time}${random}`;
}

export function createEmitter() {
  const map = new Map();
  return {
    on(name, fn) {
      if (!map.has(name)) map.set(name, new Set());
      map.get(name).add(fn);
      return () => map.get(name).delete(fn);
    },
    emit(name, ...args) {
      const set = map.get(name);
      if (!set) return;
      for (const fn of Array.from(set)) {
        try {
          fn(...args);
        } catch (error) {
          console.error(error);
        }
      }
    },
  };
}

export function debounce(fn, wait) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

export function fmtTime(seconds, decimals = 0) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = decimals > 0 ? seconds : Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const sec = decimals > 0 ? rest.toFixed(decimals).padStart(3 + decimals, '0') : String(Math.floor(rest)).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${sec}` : `${minutes}:${sec}`;
}

export function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function normalizeName(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

const FADER_UNITY = 0.78;
const FADER_FLOOR_DB = -60;
const FADER_MAX_DB = 6;

export function faderToDb(position) {
  if (position <= 0.008) return -Infinity;
  if (position <= FADER_UNITY) return (position / FADER_UNITY - 1) * -FADER_FLOOR_DB;
  return ((position - FADER_UNITY) / (1 - FADER_UNITY)) * FADER_MAX_DB;
}

export function faderToGain(position) {
  const db = faderToDb(position);
  return db === -Infinity ? 0 : Math.pow(10, db / 20);
}

export function gainToFader(gain) {
  if (gain <= 0.001) return 0;
  const db = 20 * Math.log10(gain);
  if (db <= 0) return clamp((db / -FADER_FLOOR_DB + 1) * FADER_UNITY, 0, FADER_UNITY);
  return clamp(FADER_UNITY + (db / FADER_MAX_DB) * (1 - FADER_UNITY), FADER_UNITY, 1);
}

export function fmtDb(position) {
  const db = faderToDb(position);
  if (db === -Infinity) return '-∞';
  return `${db > 0 ? '+' : ''}${db.toFixed(1)}`;
}

export function fmtPan(pan) {
  if (Math.abs(pan) < 0.02) return 'C';
  return pan < 0 ? `L${Math.round(-pan * 100)}` : `R${Math.round(pan * 100)}`;
}

export const FADER_DEFAULT = FADER_UNITY;

export const PALETTE = ['#35c9ff', '#ffb020', '#3ddc84', '#ff6b8b', '#a78bfa', '#f5e663', '#ff8a3d', '#5eead4', '#f472b6', '#94a3b8'];

export function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), 'es', { numeric: true, sensitivity: 'base' });
}

export function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

export function isNative() {
  return Boolean(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) || /Electron/i.test(navigator.userAgent);
}
