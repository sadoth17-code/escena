// Los cifrados de cada canción viajan entre computadoras: en un archivo, o solos con un código de sincronización
// (mensajes guardados en los mismos servidores públicos que usa la transmisión en vivo).
//
// Cada cifrado se identifica por el NOMBRE de la canción, no por su número interno (que es distinto en cada equipo):
// «Somos - Majo & Dan» es la misma canción en todas las computadoras. Gana siempre la versión más reciente.
// Sin DOM: lo comparten la interfaz (ui/cifrado.js) y las pruebas.
import { MqttClient } from './mqtt-lite.js';
import { BROKERS } from './live.js';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin 0, 1, I, L, O: se confunden al dictarlos
export const CODE_LENGTH = 12;
export const MAX_TEXT = 60000; // un cifrado más largo que esto no es un cifrado
export const TOPIC = 'escena/cifrados/v1';
const FUTURE = 24 * 3600 * 1000; // una hora del reloj de otro equipo adelantada más de un día no se toma en serio

// ───────── Identidad de la canción ─────────
// Sin mayúsculas, acentos ni signos: «Somos - Majo & Dan» y «SOMOS (Majo y Dan)» no son iguales, pero «somos  majo & dan» sí.
export const normalizeTitle = title => String(title ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Huella corta (53 bits, en base 36) del nombre normalizado.
export function fingerprint(title) {
  const text = normalizeTitle(title);
  if (!text) return '';
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export const chartKey = fp => `fp:${fp}`;

// ───────── Unir cifrados ─────────
// Una entrada válida: { fp, title, text, updated }. `text` vacío es una baja (para que otras computadoras también lo quiten).
export function cleanEntry(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const fp = String(raw.fp ?? '');
  if (!/^[a-z0-9]{1,16}$/.test(fp)) return null;
  if (typeof raw.text !== 'string' || raw.text.length > MAX_TEXT) return null;
  const updated = Number(raw.updated);
  if (!Number.isFinite(updated) || updated <= 0) return null;
  return { fp, title: String(raw.title ?? '').slice(0, 200), text: raw.text, updated: Math.min(Math.round(updated), now + FUTURE) };
}

// `local`: { [clave]: entrada }. Devuelve { next, added, updated, kept, skipped }: gana la más reciente de cada canción.
export function mergeCharts(local, incoming, now = Date.now()) {
  const next = { ...local };
  const result = { next, added: 0, updated: 0, kept: 0, skipped: 0 };
  for (const raw of incoming || []) {
    const entry = cleanEntry(raw, now);
    if (!entry) { result.skipped++; continue; }
    const key = chartKey(entry.fp);
    const current = next[key];
    if (!current) {
      next[key] = entry;
      if (entry.text.trim()) result.added++; else result.kept++;
    } else if (entry.updated > (Number(current.updated) || 0)) {
      next[key] = entry;
      result.updated++;
    } else {
      result.kept++;
    }
  }
  return result;
}

// ───────── Archivo ─────────
export function chartsToFile(charts, now = Date.now()) {
  const list = Object.values(charts || {})
    .map(entry => cleanEntry(entry, now))
    .filter(entry => entry && entry.text.trim())
    .sort((a, b) => a.title.localeCompare(b.title));
  return JSON.stringify({ escena: 'cifrados', v: 1, saved: new Date(now).toISOString(), charts: list }, null, 1);
}

// Devuelve las entradas del archivo (o del texto pegado). Lanza un error legible si no es un archivo de cifrados.
export function chartsFromFile(text) {
  let data;
  try { data = JSON.parse(String(text || '').trim()); } catch { data = null; }
  if (!data || data.escena !== 'cifrados' || !Array.isArray(data.charts)) throw new Error('Esto no es un archivo de cifrados de Escena.');
  return data.charts;
}

// ───────── Código de sincronización ─────────
export function newCode(length = CODE_LENGTH) {
  const bytes = new Uint8Array(length);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join('');
}

// Tolera mayúsculas, espacios y guiones. Devuelve '' si no es un código completo.
export function cleanCode(value) {
  const code = String(value || '').toUpperCase().replace(/[\s-]+/g, '');
  return code.length === CODE_LENGTH && [...code].every(ch => ALPHABET.includes(ch)) ? code : '';
}
export const prettyCode = code => String(code || '').replace(/(.{4})(?=.)/g, '$1-');

// ───────── Sincronización por servidores ─────────
// Cada cifrado se guarda como un mensaje «retenido» en escena/cifrados/v1/<código>/<huella>: el servidor se lo entrega a
// cualquier computadora que se conecte después. Se escribe en todos los servidores y se lee de todos; si a un servidor le
// falta algo que esta computadora tiene más reciente, se lo vuelve a dejar.
export class ChartSync {
  // `getCharts()` devuelve los cifrados locales; `onChart(entrada)` recibe cada cifrado que llega.
  constructor({ code, brokers = BROKERS, connect, getCharts, onChart, onState, grace = 2500 }) {
    this.code = cleanCode(code);
    if (!this.code) throw new Error('El código de sincronización no es válido');
    Object.assign(this, { brokers, connect, getCharts, onChart, onState, grace });
    this.prefix = `${TOPIC}/${this.code}`;
    this.slots = [];
    this.running = false;
    this.received = 0; // versiones distintas recibidas (el mismo cifrado llega por cada servidor y se cuenta una vez)
    this.delivered = new Map();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.received = 0;
    this.delivered.clear();
    const id = newCode(6);
    this.brokers.forEach((url, index) => {
      const slot = { url, seen: new Map(), timer: 0, client: null };
      slot.client = new MqttClient({
        url,
        clientId: `escena-cf-${id}${index}`,
        connect: this.connect,
        onOpen: () => this._opened(slot),
        onState: () => this.onState?.(this.status),
        onMessage: (topic, bytes) => this._incoming(slot, topic, bytes),
      });
      slot.client.subscribe(`${this.prefix}/+`);
      this.slots.push(slot);
      slot.client.open();
    });
    this.onState?.(this.status);
  }

  stop() {
    this.running = false;
    for (const slot of this.slots) { clearTimeout(slot.timer); slot.client.close(); }
    this.slots = [];
    this.onState?.(this.status);
  }

  get status() {
    const count = state => this.slots.filter(slot => slot.client.state === state).length;
    // `waiting`: servidores a los que no se pudo llegar y que se reintentan solos.
    return { running: this.running, connected: count('open'), waiting: count('closed'), total: this.slots.length, received: this.received };
  }

  _message(entry) {
    return JSON.stringify({ v: 1, fp: entry.fp, title: entry.title, text: entry.text, updated: entry.updated });
  }

  // Deja (o cambia) un cifrado en todos los servidores conectados; a los que no lo estén se les deja al conectarse.
  push(entry) {
    const clean = cleanEntry(entry);
    if (!clean || !this.running) return;
    for (const slot of this.slots) slot.client.publish(`${this.prefix}/${clean.fp}`, this._message(clean), { retain: true });
  }

  _opened(slot) {
    slot.seen.clear();
    clearTimeout(slot.timer);
    // Se espera a que el servidor entregue lo que tiene guardado y luego se completa lo que le falte.
    slot.timer = setTimeout(() => this._complete(slot), this.grace);
    this.onState?.(this.status);
  }

  _complete(slot) {
    if (!this.running || slot.client.state !== 'open') return;
    const local = this.getCharts?.() || {};
    for (const raw of Object.values(local)) {
      const entry = cleanEntry(raw);
      if (!entry || (slot.seen.get(entry.fp) ?? 0) >= entry.updated) continue;
      // Una baja solo hace falta donde el servidor aún guarda una versión anterior de esa canción.
      if (!entry.text.trim() && !slot.seen.has(entry.fp)) continue;
      slot.client.publish(`${this.prefix}/${entry.fp}`, this._message(entry), { retain: true });
    }
  }

  _incoming(slot, topic, bytes) {
    if (!topic.startsWith(`${this.prefix}/`) || !bytes || !bytes.length) return;
    let entry = null;
    try { entry = cleanEntry(JSON.parse(new TextDecoder().decode(bytes))); } catch { /* mensaje ajeno o roto */ }
    if (!entry || topic !== `${this.prefix}/${entry.fp}`) return;
    slot.seen.set(entry.fp, Math.max(slot.seen.get(entry.fp) ?? 0, entry.updated));
    if (entry.updated <= (this.delivered.get(entry.fp) ?? 0)) return;
    this.delivered.set(entry.fp, entry.updated);
    this.received++;
    try { this.onChart?.(entry); } catch (error) { console.error(error); }
  }
}
