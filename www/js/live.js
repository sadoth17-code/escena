// Transmisión en vivo: la laptop (director) publica la estructura, el cifrado y el avance de la canción;
// los celulares (visores) solo escuchan. No hay ningún camino de vuelta hacia Escena: el director no
// lee órdenes de nadie, así que un visor no puede parar, saltar ni cambiar nada.
//
// Transporte: servidores MQTT públicos por WebSocket seguro. No hace falta cuenta, clave ni servidor
// propio. El director se conecta a todos a la vez y los visores también; basta con que uno funcione.

import { MqttClient } from './mqtt-lite.js';

// Servidores públicos gratuitos (sin garantía de servicio). Si alguno deja de existir, se cambia aquí.
export const BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081',
  'wss://mqtt.eclipseprojects.io:443/mqtt',
];

// Dirección pública de Escena, para armar el enlace de los celulares cuando la app corre instalada
// (Windows, Mac, Android) o en localhost, donde los celulares no pueden entrar.
export const PUBLIC_BASE = 'https://ingvelarde.com/';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const decoder = new TextDecoder();

function randomBytes(n) {
  const out = new Uint8Array(n);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(out);
  else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

export function newRoom(length = 8) {
  return Array.from(randomBytes(length), byte => ALPHABET[byte % ALPHABET.length]).join('');
}

// Acepta el código con guion, espacios o minúsculas. Devuelve '' si no parece un código.
export function cleanRoom(value) {
  const room = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return room.length >= 6 && room.length <= 16 && [...room].every(ch => ALPHABET.includes(ch)) ? room : '';
}

export const prettyRoom = room => (room.length === 8 ? `${room.slice(0, 4)}-${room.slice(4)}` : room);

export const topicsFor = room => ({
  song: `escena/v1/${room}/song`,
  st: `escena/v1/${room}/st`,
  hello: `escena/v1/${room}/hello`,
  reply: id => `escena/v1/${room}/r/${id}`,
});

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|.*\.local$|\[)/;

// Carpeta pública desde la que los celulares abren ver.html.
export function publicBase(loc = globalThis.location) {
  if (!loc || !/^https?:$/.test(loc.protocol) || PRIVATE_HOST.test(loc.hostname)) return PUBLIC_BASE;
  return new URL('./', loc.href).href;
}

export function viewerUrl(room, base = publicBase()) {
  return `${base.endsWith('/') ? base : `${base}/`}ver.html#${room}`;
}

const json = value => JSON.stringify(value);
function parse(bytes) {
  try {
    const message = JSON.parse(decoder.decode(bytes));
    return message && message.v === 1 ? message : null;
  } catch {
    return null;
  }
}

class Emitter {
  constructor() { this.listeners = new Map(); }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type).delete(fn);
  }

  emit(type, ...args) {
    for (const fn of Array.from(this.listeners.get(type) || [])) {
      try { fn(...args); } catch (error) { console.error(error); }
    }
  }
}

export class LiveHost extends Emitter {
  constructor({ room, brokers = BROKERS, connect, now = () => Date.now() }) {
    super();
    this.room = room;
    this.topics = topicsFor(room);
    this.brokers = brokers;
    this.connect = connect;
    this.now = now;
    this.sid = Array.from(randomBytes(5), byte => ALPHABET[byte % ALPHABET.length]).join('');
    this.seq = 0;
    this.rev = 0;
    this.songMessage = null;
    this.stateMessage = null;
    this.clients = [];
    this.seen = new Map();
  }

  start() {
    if (this.clients.length) return;
    this.brokers.forEach((url, index) => {
      const client = new MqttClient({
        url,
        clientId: `escena-${this.sid}-${index}`,
        connect: this.connect,
        // Si la laptop se apaga o pierde la red, el servidor avisa solo a los visores.
        will: { topic: this.topics.st, payload: json({ v: 1, kind: 'bye', sid: this.sid }), retain: true },
        onState: () => this.emit('status', this.status()),
        onOpen: () => { this._flush(client); this.emit('status', this.status()); },
        onMessage: (topic, bytes) => this._incoming(client, topic, bytes),
      });
      client.subscribe(this.topics.hello);
      this.clients.push(client);
      client.open();
    });
    this.timer = setInterval(() => this.emit('status', this.status()), 5000);
  }

  stop() {
    clearInterval(this.timer);
    const clients = this.clients;
    this.clients = [];
    const bye = json({ v: 1, kind: 'bye', sid: this.sid });
    for (const client of clients) {
      client.publish(this.topics.st, bye, { retain: true });
      // Al despedirse no se deja nada guardado en los servidores públicos: un mensaje retenido vacío lo borra.
      client.publish(this.topics.st, '', { retain: true });
      client.publish(this.topics.song, '', { retain: true });
    }
    // Margen para que el mensaje de despedida salga antes de cerrar.
    setTimeout(() => clients.forEach(client => client.close()), 250);
    this.emit('status', { room: this.room, brokers: [], connected: 0, viewers: 0 });
  }

  setSong(song) {
    this.songMessage = json({ v: 1, kind: 'song', sid: this.sid, rev: ++this.rev, t: this.now(), ...song });
    this._publish(this.topics.song, this.songMessage);
  }

  setState(state) {
    this.stateMessage = json({ v: 1, kind: 'st', sid: this.sid, seq: ++this.seq, t: this.now(), live: true, ...state });
    this._publish(this.topics.st, this.stateMessage);
  }

  _publish(topic, message) {
    for (const client of this.clients) client.publish(topic, message, { retain: true });
  }

  _flush(client) {
    if (this.songMessage) client.publish(this.topics.song, this.songMessage, { retain: true });
    if (this.stateMessage) client.publish(this.topics.st, this.stateMessage, { retain: true });
  }

  _incoming(client, topic, bytes) {
    if (topic !== this.topics.hello) return;
    const message = parse(bytes);
    if (!message || typeof message.id !== 'string' || message.id.length > 40) return;
    this.seen.set(message.id, this.now());
    // Eco para que el visor mida cuánto tarda la red y compense ese retraso.
    client.publish(this.topics.reply(message.id), json({ v: 1, ts: message.ts }));
    this.emit('status', this.status());
  }

  viewers() {
    const limit = this.now() - 25000;
    for (const [id, at] of this.seen) if (at < limit) this.seen.delete(id);
    return this.seen.size;
  }

  status() {
    return {
      room: this.room,
      brokers: this.clients.map(client => ({ url: client.url, state: client.state })),
      connected: this.clients.filter(client => client.state === 'open').length,
      viewers: this.viewers(),
    };
  }
}

// Fases que ve el músico: conectando · esperando · envivo · sinsenal · fuera
export class LiveViewer extends Emitter {
  constructor({ room, brokers = BROKERS, connect, now = () => Date.now(), perf = () => globalThis.performance.now(), id = null }) {
    super();
    this.room = room;
    this.topics = topicsFor(room);
    this.brokers = brokers;
    this.connect = connect;
    this.now = now;
    this.perf = perf;
    this.id = id || Array.from(randomBytes(6), byte => ALPHABET[byte % ALPHABET.length]).join('');
    this.clients = [];
    this.song = null;
    this.live = null;
    this.sid = null;
    this.seq = -1;
    this.t = 0;
    this.songSid = null;
    this.songRev = -1;
    this.songT = 0;
    this.samples = [];
    this.oneWay = 0;
    this.phase = 'conectando';
    this.lastFresh = 0;
  }

  start() {
    if (this.clients.length) return;
    this.brokers.forEach((url, index) => {
      const client = new MqttClient({
        url,
        clientId: `escena-v-${this.id}-${index}`,
        connect: this.connect,
        onState: () => this._phase(),
        onOpen: () => { this._hello(client); this._phase(); },
        onMessage: (topic, bytes, retain) => this._incoming(topic, bytes, retain),
      });
      client.subscribe(this.topics.song);
      client.subscribe(this.topics.st);
      client.subscribe(this.topics.reply(this.id));
      this.clients.push(client);
      client.open();
    });
    this.helloTimer = setInterval(() => this.clients.forEach(client => this._hello(client)), 8000);
    this.watchdog = setInterval(() => this._watch(), 1000);
  }

  stop() {
    clearInterval(this.helloTimer);
    clearInterval(this.watchdog);
    this.clients.forEach(client => client.close());
    this.clients = [];
  }

  connected() {
    return this.clients.filter(client => client.state === 'open').length;
  }

  _hello(client) {
    client.publish(this.topics.hello, json({ v: 1, id: this.id, ts: this.perf() }));
  }

  _incoming(topic, bytes, retain) {
    const message = parse(bytes);
    if (!message) return;
    if (topic === this.topics.song) this._song(message);
    else if (topic === this.topics.st) this._state(message, retain);
    else if (topic === this.topics.reply(this.id)) this._pong(message);
  }

  _song(message) {
    if (message.kind !== 'song') return;
    const same = message.sid === this.songSid;
    if (same ? message.rev <= this.songRev : message.t < this.songT) return;
    this.songSid = message.sid;
    this.songRev = message.rev;
    this.songT = message.t;
    this.song = message;
    this.emit('song', message);
  }

  _state(message, retain) {
    if (message.kind === 'bye') {
      if (message.sid !== this.sid && this.sid !== null) return;
      this.live = this.live ? { ...this.live, state: 'paused', fresh: false, live: false } : null;
      this.phase = 'fuera';
      this.emit('state', this.live);
      this.emit('status', this._status());
      return;
    }
    if (message.kind !== 'st') return;
    const same = message.sid === this.sid;
    if (same ? message.seq <= this.seq : message.t < this.t) return;
    this.sid = message.sid;
    this.seq = message.seq;
    this.t = message.t;
    // Un mensaje retenido es la última foto guardada en el servidor, no una señal en directo.
    const fresh = !retain;
    if (fresh) this.lastFresh = this.now();
    this.live = { ...message, fresh, at: this.perf() };
    this.emit('state', this.live);
    this._phase();
  }

  _pong(message) {
    const rtt = this.perf() - message.ts;
    if (!(rtt >= 0 && rtt < 5000)) return;
    this.samples.push(rtt);
    if (this.samples.length > 5) this.samples.shift();
    this.oneWay = Math.min(1.5, Math.min(...this.samples) / 2000);
  }

  _watch() {
    if (this.live?.fresh && this.now() - this.lastFresh > 7000) {
      this.live = { ...this.live, fresh: false };
      this.emit('state', this.live);
    }
    this._phase();
  }

  _status() {
    return { phase: this.phase, connected: this.connected(), total: this.clients.length };
  }

  _phase() {
    let phase;
    if (!this.connected()) phase = 'conectando';
    else if (this.live?.fresh && this.live.live !== false) phase = 'envivo';
    else if (this.live && this.lastFresh && this.phase !== 'fuera') phase = 'sinsenal';
    else phase = this.phase === 'fuera' ? 'fuera' : 'esperando';
    this.phase = phase;
    this.emit('status', this._status());
  }
}
