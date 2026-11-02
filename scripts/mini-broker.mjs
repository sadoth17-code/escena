// Servidor MQTT mínimo (3.1.1, QoS 0) para las pruebas de la transmisión en vivo.
// `Broker` no sabe nada de redes: recibe bytes y devuelve bytes. `listen()` lo pone detrás de un
// WebSocket real para probar con un navegador. Está escrito aparte de www/js/mqtt-lite.js a propósito,
// para que las pruebas no comparen el cliente consigo mismo.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const utf8 = new TextDecoder();
const bytesOf = (...parts) => Uint8Array.from(parts.flat());
const lengthBytes = n => { const out = []; do { let d = n % 128; n = Math.floor(n / 128); if (n) d |= 128; out.push(d); } while (n); return out; };

function matches(filter, topic) {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

export class Broker {
  constructor() {
    this.connections = new Set();
    this.retained = new Map();
    this.log = [];
  }

  // `send(bytes)` entrega bytes al cliente. Devuelve { receive(bytes), end(abrupt) }.
  connect(send) {
    const conn = { filters: [], will: null, clean: false, buffer: new Uint8Array(0), alive: true };
    const deliver = (topic, payload, retain) => {
      const topicBytes = new TextEncoder().encode(topic);
      const body = [topicBytes.length >> 8, topicBytes.length & 255, ...topicBytes, ...payload];
      send(bytesOf(0x30 | (retain ? 1 : 0), lengthBytes(body.length), body));
    };
    const publish = (topic, payload, retain) => {
      if (retain) {
        if (payload.length) this.retained.set(topic, payload); else this.retained.delete(topic);
      }
      this.log.push(topic);
      for (const other of this.connections) {
        if (other.filters.some(filter => matches(filter, topic))) other.deliver(topic, payload, false);
      }
    };
    conn.deliver = deliver;
    this.connections.add(conn);
    const handle = (type, flags, body) => {
      if (type === 1) {
        let i = 2 + ((body[0] << 8) | body[1]); // «MQTT»
        i += 1; // nivel
        const connectFlags = body[i++];
        i += 2; // keepalive
        const readString = () => { const n = (body[i] << 8) | body[i + 1]; const out = body.subarray(i + 2, i + 2 + n); i += 2 + n; return out; };
        readString(); // clientId
        if (connectFlags & 0x04) conn.will = { topic: utf8.decode(readString()), payload: readString(), retain: Boolean(connectFlags & 0x20) };
        send(bytesOf(0x20, 2, 0, 0));
      } else if (type === 8) {
        const id = [body[0], body[1]];
        let i = 2;
        const codes = [];
        const added = [];
        while (i < body.length) {
          const n = (body[i] << 8) | body[i + 1];
          added.push(utf8.decode(body.subarray(i + 2, i + 2 + n)));
          i += 2 + n + 1;
          codes.push(0);
        }
        conn.filters.push(...added);
        send(bytesOf(0x90, lengthBytes(2 + codes.length), id, codes));
        for (const [topic, payload] of this.retained) if (added.some(filter => matches(filter, topic))) deliver(topic, payload, true);
      } else if (type === 3) {
        const n = (body[0] << 8) | body[1];
        publish(utf8.decode(body.subarray(2, 2 + n)), body.subarray(2 + n), Boolean(flags & 1));
      } else if (type === 12) {
        send(bytesOf(0xd0, 0));
      } else if (type === 14) {
        conn.will = null;
        conn.clean = true;
      }
    };
    return {
      receive: chunk => {
        const joined = new Uint8Array(conn.buffer.length + chunk.length);
        joined.set(conn.buffer);
        joined.set(chunk, conn.buffer.length);
        let buf = joined;
        for (;;) {
          if (buf.length < 2) break;
          let length = 0;
          let mul = 1;
          let i = 1;
          let done = false;
          while (i < buf.length && i <= 4) { const d = buf[i++]; length += (d & 127) * mul; mul *= 128; if (!(d & 128)) { done = true; break; } }
          if (!done || buf.length < i + length) break;
          handle(buf[0] >> 4, buf[0] & 15, buf.subarray(i, i + length));
          buf = buf.subarray(i + length);
        }
        conn.buffer = buf;
      },
      end: (abrupt = true) => {
        if (!conn.alive) return;
        conn.alive = false;
        this.connections.delete(conn);
        if (abrupt && conn.will) publish(conn.will.topic, conn.will.payload, conn.will.retain);
      },
    };
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

// Pone el servidor detrás de un WebSocket real (subprotocolo «mqtt»). Con `root` también sirve archivos.
export function listen(broker, { port = 0, root = null } = {}) {
  const server = createServer(async (req, res) => {
    if (!root) { res.writeHead(404).end(); return; }
    try {
      const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
      const body = await readFile(join(root, path === '/' ? 'index.html' : path));
      res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404).end('no encontrado'); }
  });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || !String(req.headers['sec-websocket-protocol'] || '').includes('mqtt')) { socket.destroy(); return; }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: mqtt\r\n\r\n`);
    const frame = bytes => {
      const n = bytes.length;
      const head = n < 126 ? [0x82, n] : n < 65536 ? [0x82, 126, n >> 8, n & 255] : [0x82, 127, 0, 0, 0, 0, (n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
      socket.write(Buffer.concat([Buffer.from(head), Buffer.from(bytes)]));
    };
    const conn = broker.connect(bytes => { if (!socket.destroyed) frame(bytes); });
    let pending = Buffer.alloc(0);
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        if (pending.length < 2) return;
        const opcode = pending[0] & 15;
        let length = pending[1] & 127;
        let at = 2;
        if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); at = 4; }
        else if (length === 127) { if (pending.length < 10) return; length = Number(pending.readBigUInt64BE(2)); at = 10; }
        const masked = Boolean(pending[1] & 128);
        const total = at + (masked ? 4 : 0) + length;
        if (pending.length < total) return;
        const payload = Buffer.from(pending.subarray(at + (masked ? 4 : 0), total));
        if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= pending[at + (i % 4)];
        pending = pending.subarray(total);
        if (opcode === 8) { socket.end(); return; }
        if (opcode === 9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
        if (opcode === 2 || opcode === 0) conn.receive(new Uint8Array(payload));
      }
    });
    const gone = () => conn.end(true);
    socket.on('close', gone);
    socket.on('error', gone);
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, close: () => new Promise(done => { server.closeAllConnections?.(); server.close(done); }) })));
}
