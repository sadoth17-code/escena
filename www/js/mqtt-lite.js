// Cliente MQTT 3.1.1 mínimo sobre WebSocket: lo justo para publicar y escuchar los mensajes de una sala
// (CONNECT con testamento, SUBSCRIBE, PUBLISH sin confirmación, PING). Sin dependencias: Escena sigue
// funcionando sin internet y no se descarga nada de terceros. Solo QoS 0.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function remainingLength(n) {
  const out = [];
  do {
    let digit = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) digit |= 0x80;
    out.push(digit);
  } while (n > 0);
  return out;
}

function concat(...parts) {
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

export const toBytes = value => (typeof value === 'string' ? encoder.encode(value) : value);
const withLength = bytes => concat([bytes.length >> 8, bytes.length & 255], bytes);
const text = value => withLength(encoder.encode(value));
const packet = (first, ...body) => {
  const inner = concat(...body);
  return concat([first], remainingLength(inner.length), inner);
};

export function connectPacket({ clientId, keepAlive = 30, will = null }) {
  const flags = 0x02 | (will ? 0x04 | (will.retain ? 0x20 : 0) : 0);
  const parts = [text('MQTT'), [4, flags, keepAlive >> 8, keepAlive & 255], text(clientId)];
  if (will) parts.push(text(will.topic), withLength(toBytes(will.payload)));
  return packet(0x10, ...parts);
}

export const publishPacket = (topic, payload, retain = false) => packet(0x30 | (retain ? 1 : 0), text(topic), toBytes(payload));

export function subscribePacket(id, topics) {
  return packet(0x82, [id >> 8, id & 255], ...topics.flatMap(topic => [text(topic), [0]]));
}

export const PINGREQ = Uint8Array.of(0xc0, 0);
export const DISCONNECT = Uint8Array.of(0xe0, 0);

// Junta los trozos que llegan por el WebSocket y entrega paquetes completos: un mensaje del socket puede
// traer varios paquetes o solo la mitad de uno.
export class PacketReader {
  constructor() { this.buffer = new Uint8Array(0); }

  push(chunk) {
    this.buffer = this.buffer.length ? concat(this.buffer, chunk) : chunk;
    const out = [];
    for (;;) {
      const b = this.buffer;
      if (b.length < 2) break;
      let length = 0;
      let multiplier = 1;
      let i = 1;
      let done = false;
      while (i < b.length && i <= 4) {
        const digit = b[i++];
        length += (digit & 127) * multiplier;
        multiplier *= 128;
        if (!(digit & 128)) { done = true; break; }
      }
      if (!done) {
        if (i > 4) throw new Error('Paquete MQTT con longitud inválida');
        break;
      }
      if (b.length < i + length) break;
      out.push({ type: b[0] >> 4, flags: b[0] & 15, body: b.subarray(i, i + length) });
      this.buffer = b.subarray(i + length);
    }
    return out;
  }
}

export function decodePublish({ flags, body }) {
  const size = (body[0] << 8) | body[1];
  const topic = decoder.decode(body.subarray(2, 2 + size));
  const qos = (flags >> 1) & 3;
  const start = 2 + size + (qos ? 2 : 0);
  return { topic, payload: body.subarray(start), retain: Boolean(flags & 1) };
}

const defaultConnect = url => new WebSocket(url, 'mqtt');
const bytesOf = data => {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
};

export class MqttClient {
  constructor({ url, clientId, keepAlive = 30, will = null, connect = defaultConnect, onMessage = () => {}, onState = () => {}, onOpen = () => {} }) {
    Object.assign(this, { url, clientId, keepAlive, will, connect, onMessage, onState, onOpen });
    this.state = 'idle'; // idle · connecting · open · closed (esperando para reintentar)
    this.subs = new Set();
    this.wanted = false;
    this.attempt = 0;
    this.ws = null;
  }

  open() {
    this.wanted = true;
    this._dial();
  }

  close() {
    this.wanted = false;
    const ws = this.ws;
    this._clear();
    this.ws = null;
    if (ws) {
      try { if (this.state === 'open') ws.send(DISCONNECT); } catch { /* ya cerrado */ }
      try { ws.close(); } catch { /* ya cerrado */ }
    }
    this._set('idle');
  }

  subscribe(topic) {
    this.subs.add(topic);
    if (this.state === 'open') this._send(subscribePacket(this._id(), [topic]));
  }

  // Devuelve false si no hay conexión: quien publica guarda lo último y lo reenvía en onOpen.
  publish(topic, payload, { retain = false } = {}) {
    if (this.state !== 'open') return false;
    return this._send(publishPacket(topic, payload, retain));
  }

  _id() {
    this.packetId = ((this.packetId || 0) % 65535) + 1;
    return this.packetId;
  }

  _set(state) {
    if (this.state === state) return;
    this.state = state;
    try { this.onState(state); } catch (error) { console.error(error); }
  }

  _send(bytes) {
    try { this.ws.send(bytes); return true; } catch { return false; }
  }

  _clear() {
    clearTimeout(this.connectTimer);
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
  }

  _dial() {
    if (!this.wanted || this.ws) return;
    this._set('connecting');
    let ws;
    try { ws = this.connect(this.url); } catch { this._lost(null); return; }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.reader = new PacketReader();
    this.lastRx = Date.now();
    this.connectTimer = setTimeout(() => this._drop(ws), 9000);
    ws.onopen = () => {
      try { ws.send(connectPacket({ clientId: this.clientId, keepAlive: this.keepAlive, will: this.will })); } catch { this._drop(ws); }
    };
    ws.onmessage = event => this._data(ws, event.data);
    ws.onerror = () => this._drop(ws);
    ws.onclose = () => this._lost(ws);
  }

  _data(ws, data) {
    if (ws !== this.ws) return;
    const bytes = bytesOf(data);
    if (!bytes) return;
    this.lastRx = Date.now();
    let packets;
    try { packets = this.reader.push(bytes); } catch { this._drop(ws); return; }
    for (const p of packets) {
      if (p.type === 2) {
        if (p.body[1] !== 0) { this._drop(ws); return; }
        clearTimeout(this.connectTimer);
        this.attempt = 0;
        this._set('open');
        if (this.subs.size) this._send(subscribePacket(this._id(), [...this.subs]));
        this.pingTimer = setInterval(() => {
          if (Date.now() - this.lastRx > this.keepAlive * 1600) { this._drop(ws); return; }
          this._send(PINGREQ);
        }, this.keepAlive * 500);
        try { this.onOpen(); } catch (error) { console.error(error); }
      } else if (p.type === 3) {
        const message = decodePublish(p);
        try { this.onMessage(message.topic, message.payload, message.retain); } catch (error) { console.error(error); }
      }
    }
  }

  _drop(ws) {
    try { ws?.close(); } catch { /* ya cerrado */ }
    this._lost(ws);
  }

  _lost(ws) {
    if (ws && ws !== this.ws) return;
    this._clear();
    this.ws = null;
    if (!this.wanted) { this._set('idle'); return; }
    this._set('closed');
    const delay = Math.min(15000, 1000 * 2 ** Math.min(this.attempt++, 4)) * (0.7 + Math.random() * 0.6);
    this.retryTimer = setTimeout(() => this._dial(), delay);
  }
}
