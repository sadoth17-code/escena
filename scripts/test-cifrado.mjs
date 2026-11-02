// Cifrado y transmisión en vivo: lectura del cifrado, transposición, ubicación en el tiempo, paquetes MQTT
// y el recorrido completo director → servidor → visor con un servidor MQTT de memoria.
// Ejecutar: node --test scripts/test-cifrado.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Broker } from './mini-broker.mjs';

const urls = new Map();
async function moduleURL(name) {
  if (urls.has(name)) return urls.get(name);
  let source = await readFile(new URL(`../www/js/${name}`, import.meta.url), 'utf8');
  for (const dependency of [...source.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)]) {
    source = source.replace(dependency[0], `from ${JSON.stringify(await moduleURL(dependency[1]))}`);
  }
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  urls.set(name, url);
  return url;
}
const chart = await import(await moduleURL('chart.js'));
const mqtt = await import(await moduleURL('mqtt-lite.js'));
const live = await import(await moduleURL('live.js'));
const sync = await import(await moduleURL('sync.js'));

const wait = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
const hex = bytes => [...bytes];

// ───────────── Paquetes MQTT (vectores escritos a mano según la especificación 3.1.1) ─────────────

test('los paquetes MQTT salen byte a byte como pide la especificación', () => {
  assert.deepEqual(hex(mqtt.connectPacket({ clientId: 'a', keepAlive: 30 })), [0x10, 0x0d, 0, 4, 0x4d, 0x51, 0x54, 0x54, 4, 2, 0, 0x1e, 0, 1, 0x61]);
  assert.deepEqual(hex(mqtt.connectPacket({ clientId: 'a', keepAlive: 30, will: { topic: 't', payload: 'x', retain: true } })),
    [0x10, 0x13, 0, 4, 0x4d, 0x51, 0x54, 0x54, 4, 0x26, 0, 0x1e, 0, 1, 0x61, 0, 1, 0x74, 0, 1, 0x78]);
  assert.deepEqual(hex(mqtt.subscribePacket(1, ['a/b'])), [0x82, 8, 0, 1, 0, 3, 0x61, 0x2f, 0x62, 0]);
  assert.deepEqual(hex(mqtt.publishPacket('a/b', 'hi')), [0x30, 7, 0, 3, 0x61, 0x2f, 0x62, 0x68, 0x69]);
  assert.equal(mqtt.publishPacket('a/b', 'hi', true)[0], 0x31);
  assert.deepEqual(hex(mqtt.PINGREQ), [0xc0, 0]);
  assert.deepEqual(hex(mqtt.DISCONNECT), [0xe0, 0]);
});

test('la longitud restante usa 1 a 4 bytes como en la especificación', () => {
  for (const [n, bytes] of [[0, [0]], [127, [127]], [128, [0x80, 1]], [321, [0xc1, 2]], [16383, [0xff, 0x7f]], [16384, [0x80, 0x80, 1]]]) {
    assert.deepEqual(mqtt.remainingLength(n), bytes);
  }
});

test('el lector junta paquetes partidos y separa paquetes pegados', () => {
  const big = mqtt.publishPacket('s/t', 'x'.repeat(300), true); // longitud de dos bytes
  const small = mqtt.publishPacket('a', 'b');
  const reader = new mqtt.PacketReader();
  assert.equal(reader.push(big.subarray(0, 1)).length, 0);
  assert.equal(reader.push(big.subarray(1, 100)).length, 0);
  const [first] = reader.push(big.subarray(100));
  assert.deepEqual([first.type, first.flags & 1], [3, 1]);
  assert.equal(mqtt.decodePublish(first).payload.length, 300);
  const both = new Uint8Array(big.length + small.length);
  both.set(big);
  both.set(small, big.length);
  assert.equal(new mqtt.PacketReader().push(both).length, 2);
  assert.throws(() => new mqtt.PacketReader().push(Uint8Array.of(0x30, 0xff, 0xff, 0xff, 0xff, 1)), /longitud/);
});

// ───────────── Cifrado ─────────────

const fmt = (text, opts) => chart.formatChord(chart.parseChord(text), opts);

test('reconoce acordes en letras y en nombres, y descarta palabras', () => {
  for (const ok of ['G', 'Am7/G', 'C#m', 'Bb', 'F#m7b5', 'Dsus4', 'Cmaj7', 'Fadd9', 'Do', 'Lam', 'Sol7', 'Sib', 'Re/Fa#', 'C°', 'E5']) {
    assert.ok(chart.parseChord(ok), ok);
  }
  for (const no of ['Hello', 'Dios', 'Add9', 'H', 'x2', '12', 'Cm/Z', '']) assert.equal(chart.parseChord(no), null, no);
  assert.deepEqual(chart.parseChord('Fadd9'), { nat: 5, acc: '', q: 'add9', bass: null });
  assert.equal(chart.parseChord('Lam').nat, 9);
});

test('transpone y cambia de notación sin perder la calidad ni el bajo', () => {
  assert.equal(fmt('G', { shift: 2 }), 'A');
  assert.equal(fmt('Em7', { shift: 2 }), 'F#m7');
  assert.equal(fmt('Em7', { shift: 2, flats: true }), 'Gbm7');
  assert.equal(fmt('D/F#', { shift: 2 }), 'E/G#');
  assert.equal(fmt('C', { shift: -1 }), 'B');
  assert.equal(fmt('C', { shift: 12 }), 'C');
  assert.equal(fmt('Bb', { notation: 'latino' }), 'Sib');
  assert.equal(fmt('C#m7', { notation: 'latino' }), 'Do#m7');
  assert.equal(fmt('Sol/Si', { notation: 'abc' }), 'G/B');
  assert.equal(fmt('Am7/G', { shift: 3, notation: 'latino', flats: true }), 'Dom7/Sib');
  assert.equal(fmt('Eb', { shift: 0 }), 'Eb', 'sin transponer se respeta cómo lo escribió el músico');
});

test('elige bemoles o sostenidos según el tono, o según los acordes si no hay tono', () => {
  assert.equal(chart.prefersFlats('F', 0), true);
  assert.equal(chart.prefersFlats('G', 1), true); // G + 1 = Ab
  assert.equal(chart.prefersFlats('Em', 3), true); // Gm
  assert.equal(chart.prefersFlats('G', 0), false);
  assert.equal(chart.prefersFlats('', 0, [chart.parseChord('Bb'), chart.parseChord('Eb')]), true);
  assert.equal(chart.prefersFlats('', 0, [chart.parseChord('F#'), chart.parseChord('C#m')]), false);
  assert.equal(chart.formatKey('G', { shift: 2 }), 'A');
  assert.equal(chart.formatKey('G', { shift: 1 }), 'Ab');
});

const TEXT = `Tono: G
[Intro]
| G | D/F# | Em7 | C . . D |
[Verso 1]
| G | D | Em | C |
Todo lo que soy
| G | % | Am7 | |
[Coro]
G D Em C
| C | G | x2
Letra del coro`;

test('lee secciones, compases, repeticiones, texto y el tono', () => {
  const parsed = chart.parseChart(TEXT);
  assert.equal(parsed.key, 'G');
  assert.deepEqual(parsed.sections.map(s => [s.name, s.bars.length]), [['Intro', 4], ['Verso 1', 8], ['Coro', 8]]);
  const intro = parsed.sections[0];
  assert.deepEqual(intro.bars[3].chords.map(c => c.raw), ['C', '.', '.', 'D']);
  const verse = parsed.sections[1];
  assert.deepEqual(verse.rows.map(r => r.type), ['bars', 'text', 'bars']);
  assert.equal(verse.rows[1].text, 'Todo lo que soy');
  assert.deepEqual(verse.bars[5].chords.map(c => c.raw), ['%']);
  assert.deepEqual(verse.bars[7].chords, [], 'un compás vacío sostiene el acorde');
  const chorus = parsed.sections[2];
  assert.equal(chorus.rows[0].count, 4, 'una línea de solo acordes es un compás por acorde');
  assert.equal(chorus.rows[1].count, 4, '«x2» repite la línea completa');
  assert.equal(chorus.rows[2].type, 'text');
  // Nunca falla con basura.
  assert.doesNotThrow(() => chart.parseChart('|||\n[]\n#\n| x99 |\n\u0000'));
  assert.deepEqual(chart.parseChart('').sections, []);
});

// Canción de ejemplo: 4/4 a 120 bpm (compás = 2 s), 22 compases.
const BARS = Array.from({ length: 22 }, (_, i) => i * 2);
const SONG = {
  duration: 44,
  bars: BARS,
  sections: [
    { n: 'Intro', c: '#35c9ff', b: 1, s: 0, e: 8 },
    { n: 'Verso 1', c: '#ffb020', b: 5, s: 8, e: 24 },
    { n: 'Coro', c: '#ff5a7a', b: 13, s: 24, e: 32 },
    { n: 'Verso 2', c: '#ffb020', b: 17, s: 32, e: 40 },
    { n: 'Coro', c: '#ff5a7a', b: 21, s: 40, e: 44 },
  ],
};

test('une el cifrado con la estructura: por nombre, con repeticiones y secciones sin cifrado', () => {
  const layout = chart.buildLayout(SONG, chart.parseChart(TEXT));
  assert.deepEqual(layout.items.map(i => i.name), ['Intro', 'Verso 1', 'Coro', 'Verso 2', 'Coro']);
  assert.equal(layout.items[1].bars.length, 8);
  assert.equal(layout.items[3].bars.length, 8, '«Verso 2» usa el bloque «Verso 1» (mismo nombre base)');
  assert.equal(layout.items[4].bars.length, 8, 'el segundo «Coro» reutiliza el bloque escrito una vez');
  assert.equal(layout.items[1].span, 8);
  assert.equal(layout.items[4].span, 2, 'solo cuenta lo que cabe en la sección: la última tiene 2 compases');
  assert.equal(layout.hasChords, true);
  const sinCifrado = chart.buildLayout(SONG, chart.parseChart('[Intro]\n| G | D |'));
  assert.equal(sinCifrado.items[1].bars.length, 0);
  assert.equal(chart.buildLayout(SONG, chart.parseChart('')).hasChords, false);
});

test('sin encabezados, el cifrado corre desde el compás 1 de toda la canción', () => {
  const layout = chart.buildLayout(SONG, chart.parseChart('| G | D | Em | C |\n| G | D | Em | C |'));
  assert.equal(layout.items.length, 1);
  assert.equal(chart.barAt(layout, 6).bar.slots[0].raw, 'D');
  assert.equal(chart.barAt(layout, 9), null);
});

test('resuelve «%», «.» y compases vacíos a los acordes que de verdad suenan', () => {
  const layout = chart.buildLayout(SONG, chart.parseChart(TEXT));
  const verse = layout.items[1];
  assert.deepEqual(verse.bars[5].slots.map(c => c.raw), ['G'], '«%» repite el compás anterior');
  assert.deepEqual(verse.bars[7].slots.map(c => c.raw), ['Am7'], 'el compás vacío sostiene');
  const hold = layout.items[0].bars[3];
  assert.deepEqual(hold.slots.map(c => c.raw), ['C', 'C', 'C', 'D'], '«C . . D» son cuatro tiempos: C, C, C, D');
  assert.deepEqual(hold.src, [0, 0, 0, 3]);
  assert.deepEqual(hold.show.map(c => c.raw), ['C', '.', '.', 'D']);
});

test('ubica el compás, la sección y el acorde en cada instante', () => {
  assert.deepEqual(chart.locate(SONG, 0), { bar: 1, frac: 0, section: 0 });
  const mid = chart.locate(SONG, 9);
  assert.deepEqual([mid.bar, mid.section], [5, 1]);
  assert.ok(Math.abs(mid.frac - 0.5) < 1e-9);
  assert.equal(chart.locate(SONG, 43.9).bar, 22);
  assert.equal(chart.locate({ bars: [1, 3], sections: [], duration: 5 }, 0.2).bar, 0, 'antes del compás 1');
  const layout = chart.buildLayout(SONG, chart.parseChart(TEXT));
  // Compás 4 de la intro: «C . . D» → C en los tres primeros tiempos, D en el cuarto; luego sigue el verso.
  assert.deepEqual(chart.chordNow(layout, 4, 0.1, {}), { now: 'C', next: 'D', index: 0 });
  assert.deepEqual(chart.chordNow(layout, 4, 0.6, {}), { now: 'C', next: 'D', index: 0 });
  assert.deepEqual(chart.chordNow(layout, 4, 0.9, {}), { now: 'D', next: 'G', index: 3 });
  assert.deepEqual(chart.chordNow(layout, 4, 0.1, { shift: 2 }), { now: 'D', next: 'E', index: 0 });
  assert.deepEqual(chart.chordNow(layout, 4, 0.1, { notation: 'latino' }), { now: 'Do', next: 'Re', index: 0 });
  assert.deepEqual(chart.chordNow(layout, 99, 0, {}), { now: '', next: '', index: -1 });
});

test('calcula la posición entre mensajes: pre-conteo, pausa, repetición y final', () => {
  const at = 1000;
  assert.equal(chart.extrapolate({ state: 'paused', pos: 7, at }, at + 5000), 7);
  assert.equal(chart.extrapolate({ state: 'playing', pos: 10, at, fresh: false }, at + 5000), 10, 'un mensaje retenido no avanza');
  assert.equal(chart.extrapolate({ state: 'playing', pos: 10, at }, at + 2000), 12);
  assert.equal(chart.extrapolate({ state: 'playing', pos: 10, at }, at + 2000, 0.25), 12.25, 'suma el retraso de la red');
  assert.equal(chart.extrapolate({ state: 'playing', pos: 0, wait: 3, at }, at + 2000), 0, 'durante el pre-conteo no avanza');
  assert.equal(chart.extrapolate({ state: 'playing', pos: 0, wait: 3, at }, at + 4000), 1);
  const loop = { state: 'playing', pos: 15, loop: { a: 8, b: 16 }, at };
  assert.equal(chart.extrapolate(loop, at + 3000), 10, 'al pasar el final de la repetición vuelve al inicio');
  assert.equal(chart.extrapolate({ state: 'playing', pos: 43, duration: 44, at }, at + 9000), 44);
  assert.equal(chart.extrapolate(null, at), 0);
  assert.equal(chart.fmtTime(125.9), '2:05');
});

test('la plantilla trae cada sección con su número exacto de compases', () => {
  const template = chart.templateFor(SONG);
  assert.match(template, /^\[Intro\]\n\|( {5}\|){4}\n\n\[Verso 1\]/);
  const layout = chart.buildLayout(SONG, chart.parseChart(template));
  assert.deepEqual(layout.items.map(i => i.bars.length), [4, 8, 4, 4, 2]);
  assert.equal(chart.parseChart(template).sections[0].bars.length, 4);
});

// ───────────── Salas y enlaces ─────────────

test('el código de sala es legible, tolera guiones y el enlace apunta al visor', () => {
  const room = live.newRoom();
  assert.match(room, /^[A-HJKMNP-Z2-9]{8}$/);
  assert.equal(live.cleanRoom(` ${live.prettyRoom(room).toLowerCase()} `), room);
  assert.equal(live.cleanRoom('abc'), '');
  assert.equal(live.cleanRoom('OOOOOOOO'), '', 'sin O, 0, I, 1, L: se confunden');
  assert.equal(live.viewerUrl('K7P3QX9M', 'https://ingvelarde.com/'), 'https://ingvelarde.com/ver.html#K7P3QX9M');
  assert.equal(live.publicBase({ protocol: 'https:', hostname: 'ingvelarde.com', href: 'https://ingvelarde.com/app/index.html' }), 'https://ingvelarde.com/app/');
  for (const hostname of ['localhost', '127.0.0.1', '192.168.1.5', '10.0.0.2', 'laptop.local']) {
    assert.equal(live.publicBase({ protocol: 'https:', hostname, href: `https://${hostname}/` }), live.PUBLIC_BASE, hostname);
  }
  assert.equal(live.publicBase({ protocol: 'tauri:', hostname: 'localhost', href: 'tauri://localhost/' }), live.PUBLIC_BASE);
});

// ───────────── Director → servidor → visor ─────────────

function memorySocket(broker) {
  const ws = { binaryType: '', readyState: 0 };
  const conn = broker.connect(bytes => queueMicrotask(() => ws.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })));
  ws.send = bytes => { if (ws.readyState === 1) conn.receive(Uint8Array.from(bytes)); };
  ws.close = () => { if (ws.readyState === 3) return; ws.readyState = 3; conn.end(true); queueMicrotask(() => ws.onclose?.()); };
  ws.kill = () => { conn.end(true); ws.readyState = 3; queueMicrotask(() => ws.onclose?.()); }; // se cae la red sin despedirse
  queueMicrotask(() => { ws.readyState = 1; ws.onopen?.(); });
  return ws;
}

function network(urls) {
  const brokers = new Map(urls.map(url => [url, new Broker()]));
  const sockets = [];
  const down = new Set();
  const connect = url => {
    if (down.has(url)) { const dead = { send() {}, close() {} }; return dead; } // nunca abre: el servidor no responde
    const ws = memorySocket(brokers.get(url));
    sockets.push(ws);
    return ws;
  };
  return { brokers, connect, sockets, down };
}

const URLS = ['wss://a.test/mqtt', 'wss://b.test/mqtt'];
const STATE = { song: 'cancion-1', state: 'playing', pos: 12.5, wait: 0, counting: false, loop: null, pitch: 0, duration: 44 };
const SONG_MSG = { id: 'cancion-1', title: 'Eres Fiel', duration: 44, bars: BARS, sections: SONG.sections, chart: TEXT, key: 'G' };

test('el visor recibe la canción y el estado, una sola vez aunque lleguen por dos servidores', async t => {
  const net = network(URLS);
  const host = new live.LiveHost({ room: 'K7P3QX9M', brokers: URLS, connect: net.connect });
  const viewer = new live.LiveViewer({ room: 'K7P3QX9M', brokers: URLS, connect: net.connect });
  t.after(async () => { viewer.stop(); host.stop(); await wait(300); });
  const songs = [];
  const states = [];
  viewer.on('song', song => songs.push(song));
  viewer.on('state', state => states.push(state));
  host.start();
  viewer.start();
  await wait();
  host.setSong(SONG_MSG);
  host.setState(STATE);
  await wait();
  assert.equal(songs.length, 1, 'el mismo mensaje por dos servidores se cuenta una vez');
  assert.equal(songs[0].title, 'Eres Fiel');
  assert.deepEqual(songs[0].bars, BARS);
  assert.equal(states.length, 1);
  assert.equal(states[0].fresh, true, 'un mensaje en directo no es una foto retenida');
  assert.equal(states[0].pos, 12.5);
  assert.equal(viewer.phase, 'envivo');
  host.setState({ ...STATE, pos: 14.5 });
  await wait();
  assert.equal(viewer.live.pos, 14.5);
  assert.equal(states.length, 2);
});

test('quien llega tarde recibe la última foto, pero no la toma por señal en directo', async t => {
  const net = network(URLS);
  const host = new live.LiveHost({ room: 'ROOM2345', brokers: URLS, connect: net.connect });
  const late = new live.LiveViewer({ room: 'ROOM2345', brokers: URLS, connect: net.connect });
  t.after(async () => { late.stop(); host.stop(); await wait(300); });
  host.start();
  await wait();
  host.setSong(SONG_MSG);
  host.setState(STATE);
  await wait();
  late.start();
  await wait();
  assert.equal(late.song.title, 'Eres Fiel');
  assert.equal(late.live.fresh, false);
  assert.equal(late.phase, 'esperando');
  assert.equal(chart.extrapolate({ ...late.live }, late.live.at + 5000), 12.5, 'la foto retenida no avanza sola');
  host.setState({ ...STATE, pos: 20 });
  await wait();
  assert.equal(late.phase, 'envivo');
  assert.equal(late.live.pos, 20);
});

test('si la laptop se cae o se despide, el visor lo sabe; al volver, recupera la señal', async t => {
  const net = network(URLS);
  const host = new live.LiveHost({ room: 'ROOM2345', brokers: URLS, connect: net.connect });
  const viewer = new live.LiveViewer({ room: 'ROOM2345', brokers: URLS, connect: net.connect });
  t.after(async () => { viewer.stop(); host.stop(); await wait(300); });
  host.start();
  viewer.start();
  await wait();
  host.setSong(SONG_MSG);
  host.setState(STATE);
  await wait();
  assert.equal(viewer.phase, 'envivo');
  // Corte brusco: los servidores publican el testamento.
  for (const client of host.clients) client.ws.kill();
  await wait();
  assert.equal(viewer.phase, 'fuera');
  assert.equal(viewer.live.state, 'paused');
  // Los clientes del director reintentan solos y vuelven a publicar lo último.
  await wait(1700);
  host.setState({ ...STATE, pos: 30 });
  await wait();
  assert.equal(viewer.phase, 'envivo');
  assert.equal(viewer.live.pos, 30);
  // Despedida limpia.
  host.stop();
  await wait();
  assert.equal(viewer.phase, 'fuera');
});

test('al despedirse no queda nada guardado en el servidor: quien llega después encuentra la sala vacía', async t => {
  const net = network(URLS);
  const host = new live.LiveHost({ room: 'ROOM2345', brokers: URLS, connect: net.connect });
  const late = new live.LiveViewer({ room: 'ROOM2345', brokers: URLS, connect: net.connect });
  t.after(async () => { late.stop(); host.stop(); await wait(300); });
  host.start();
  await wait();
  host.setSong(SONG_MSG);
  host.setState(STATE);
  await wait();
  for (const broker of net.brokers.values()) assert.equal(broker.retained.size, 2);
  host.stop();
  await wait();
  for (const broker of net.brokers.values()) assert.equal(broker.retained.size, 0);
  late.start();
  await wait();
  assert.equal(late.song, null);
  assert.equal(late.live, null);
  assert.equal(late.phase, 'esperando');
});

test('basta con que funcione un servidor, y el director cuenta a los músicos conectados', async t => {
  const net = network(URLS);
  net.down.add(URLS[0]);
  const host = new live.LiveHost({ room: 'ROOM2345', brokers: URLS, connect: net.connect });
  const one = new live.LiveViewer({ room: 'ROOM2345', brokers: URLS, connect: net.connect, id: 'AAAA1111' });
  const two = new live.LiveViewer({ room: 'ROOM2345', brokers: URLS, connect: net.connect, id: 'BBBB2222' });
  t.after(async () => { one.stop(); two.stop(); host.stop(); await wait(300); });
  host.start();
  one.start();
  two.start();
  await wait();
  assert.equal(host.status().connected, 1);
  assert.equal(host.status().brokers.length, 2);
  host.setSong(SONG_MSG);
  host.setState(STATE);
  await wait();
  assert.equal(one.phase, 'envivo');
  assert.equal(two.phase, 'envivo');
  assert.equal(host.viewers(), 2, 'cada músico se cuenta una vez, sin importar por cuántos servidores llegue');
  assert.ok(one.oneWay >= 0 && one.oneWay < 0.1, 'mide el retraso de la red con el eco del director');
});

test('el director solo escucha saludos de visores: no hay canal para mandarle órdenes', async t => {
  const net = network(URLS);
  const host = new live.LiveHost({ room: 'ROOM2345', brokers: URLS, connect: net.connect });
  t.after(async () => { host.stop(); await wait(300); });
  host.start();
  await wait();
  for (const client of host.clients) assert.deepEqual([...client.subs], ['escena/v1/ROOM2345/hello']);
  const intruder = memorySocket(net.brokers.get(URLS[0]));
  await wait();
  const hello = 'escena/v1/ROOM2345/hello';
  for (const bad of ['no es json', '{"v":2,"id":"X"}', '{"v":1,"id":7}', `{"v":1,"id":"${'x'.repeat(50)}"}`]) intruder.send(mqtt.publishPacket(hello, bad));
  for (const topic of ['escena/v1/ROOM2345/cmd', 'escena/v1/ROOM2345/st']) intruder.send(mqtt.publishPacket(topic, '{"v":1,"id":"X","cmd":"stop"}'));
  await wait();
  assert.equal(host.viewers(), 0, 'los saludos mal formados y lo que llega a otros temas no cuenta');
  intruder.send(mqtt.publishPacket(hello, '{"v":1,"id":"Y1","ts":1}'));
  await wait();
  assert.equal(host.viewers(), 1);
});

// ───────────── Cifrados entre computadoras ─────────────

const entry = (fp, text, updated, title = fp) => ({ fp, title, text, updated });
const CODE = 'K7P29QXM4HTD';
const chartTopic = fp => `escena/cifrados/v1/${CODE}/${fp}`;
const DAY = 24 * 3600 * 1000;

test('la huella de una canción ignora mayúsculas, acentos y signos, y distingue canciones distintas', () => {
  const fp = sync.fingerprint;
  assert.equal(fp('Somos - Majo & Dan'), fp('  SOMOS (Majo & Dan) '));
  assert.equal(fp('Canción de Él'), fp('cancion de el'));
  assert.equal(fp('Eres Fiel'), fp('eres   fiel!'));
  assert.notEqual(fp('Somos - Majo & Dan'), fp('Somos - Majo y Dan'), 'una palabra distinta es otra canción');
  assert.notEqual(fp('Eres Fiel'), fp('Eres Fiel 2'));
  assert.equal(fp(''), '');
  assert.equal(fp(null), '');
  assert.equal(fp(undefined), '');
  assert.equal(fp('¡¡!! ...'), '', 'sin letras ni números no hay nombre');
  const seen = new Set();
  for (let i = 0; i < 3000; i++) seen.add(fp(`Canción número ${i}`));
  assert.equal(seen.size, 3000, 'sin choques entre nombres parecidos');
  for (const value of seen) assert.match(value, /^[a-z0-9]{1,16}$/);
});

test('al unir cifrados gana el más reciente de cada canción y no se toca lo demás', () => {
  const local = { 'fp:aaa': entry('aaa', 'G D', 100), 'fp:bbb': entry('bbb', 'C F', 100), 'viejo-7': { text: 'antiguo', updated: 5 } };
  const frozen = JSON.stringify(local);
  const result = sync.mergeCharts(local, [
    entry('aaa', 'G D Em', 200), // más nuevo: reemplaza
    entry('bbb', 'otro', 50), // más viejo: se queda el de aquí
    entry('ccc', 'A E', 10), // canción nueva
    entry('aaa', 'G D Em', 200), // el mismo otra vez: ya está al día
  ], 1e6);
  assert.deepEqual([result.added, result.updated, result.kept, result.skipped], [1, 1, 2, 0]);
  assert.equal(result.next['fp:aaa'].text, 'G D Em');
  assert.equal(result.next['fp:bbb'].text, 'C F');
  assert.equal(result.next['fp:ccc'].text, 'A E');
  assert.equal(result.next['viejo-7'].text, 'antiguo', 'lo de versiones anteriores queda igual');
  assert.equal(JSON.stringify(local), frozen, 'no modifica el original');
  assert.deepEqual(sync.mergeCharts(local, undefined).next, local);
});

test('una baja más reciente quita el cifrado y una versión anterior no lo revive', () => {
  const song = entry('aaa', 'G D', 100);
  let charts = sync.mergeCharts({ 'fp:aaa': song }, [entry('aaa', '', 200)], 1e6).next;
  assert.equal(charts['fp:aaa'].text, '');
  charts = sync.mergeCharts(charts, [song], 1e6).next;
  assert.equal(charts['fp:aaa'].text, '', 'la versión vieja no revive lo borrado');
  charts = sync.mergeCharts(charts, [entry('aaa', 'nuevo', 300)], 1e6).next;
  assert.equal(charts['fp:aaa'].text, 'nuevo', 'escribirlo de nuevo sí lo trae de vuelta');
  // Una baja de una canción que aquí no existe se anota, para que una copia vieja que llegue después no la traiga de vuelta.
  const unknown = sync.mergeCharts({}, [entry('zzz', '', 50)], 1e6);
  assert.deepEqual([unknown.added, unknown.kept], [0, 1]);
  assert.equal(sync.mergeCharts(unknown.next, [entry('zzz', 'viejo', 10)], 1e6).next['fp:zzz'].text, '');
});

test('descarta entradas inválidas y no se fía de relojes adelantados', () => {
  const now = 1_700_000_000_000;
  const bad = [null, 'texto', 7, {}, entry('', 'x', 1), entry('MAYUS', 'x', 1), entry('a b', 'x', 1), entry('x'.repeat(17), 'x', 1),
    { fp: 'ok', text: 5, updated: 1 }, entry('ok', 'x', 0), entry('ok', 'x', -3), entry('ok', 'x', NaN), { fp: 'ok', text: 'x', updated: 'nunca' },
    entry('ok', 'z'.repeat(sync.MAX_TEXT + 1), 1)];
  const result = sync.mergeCharts({}, bad, now);
  assert.equal(result.skipped, bad.length);
  assert.deepEqual(result.next, {});
  const future = sync.mergeCharts({}, [entry('ok', 'G', now + 10 * DAY)], now);
  assert.equal(future.next['fp:ok'].updated, now + DAY, 'un reloj adelantado se limita a un día');
  assert.equal(sync.mergeCharts({}, [entry('ok', 'z'.repeat(sync.MAX_TEXT), 1)], now).added, 1, 'el largo máximo sí entra');
  assert.equal(sync.cleanEntry({ fp: 'ok', text: 'x', updated: 5, extra: 'se descarta', title: 'T'.repeat(500) }).title.length, 200);
  assert.deepEqual(Object.keys(sync.cleanEntry({ fp: 'ok', text: 'x', updated: 5, extra: 1 })).sort(), ['fp', 'text', 'title', 'updated']);
});

test('el archivo de cifrados va y viene sin perder nada, y rechaza lo que no es suyo', () => {
  const charts = {
    'fp:aaa': entry('aaa', '[Coro]\n| G | D |', 100, 'Zeta'),
    'fp:bbb': entry('bbb', 'C F\nñandú áéíóú «ü» 🎵', 200, 'Alfa'),
    'fp:ccc': entry('ccc', '', 300, 'Borrado'),
    'viejo-7': { text: 'de una versión anterior', updated: 5 },
  };
  const file = sync.chartsToFile(charts, 1_700_000_000_000);
  const list = sync.chartsFromFile(file);
  assert.deepEqual(list.map(c => c.title), ['Alfa', 'Zeta'], 'solo los cifrados con texto, por orden alfabético');
  assert.equal(list[0].text, 'C F\nñandú áéíóú «ü» 🎵');
  assert.deepEqual(sync.mergeCharts({}, list).next, { 'fp:aaa': charts['fp:aaa'], 'fp:bbb': charts['fp:bbb'] });
  assert.equal(sync.chartsFromFile(`\n  ${file}  \n`).length, 2, 'tolera espacios y saltos al pegar');
  for (const bad of ['', 'hola', '{}', '[]', '{"escena":"otra cosa","charts":[]}', '{"escena":"cifrados"}', '{"escena":"cifrados","charts":{}}', '<html>']) {
    assert.throws(() => sync.chartsFromFile(bad), /no es un archivo de cifrados/, bad);
  }
  assert.equal(sync.chartsFromFile('{"escena":"cifrados","v":1,"charts":[]}').length, 0, 'un archivo sin cifrados es válido');
});

test('el código de sincronización no usa letras que se confunden, tolera guiones y minúsculas, y rechaza lo incompleto', () => {
  for (let i = 0; i < 50; i++) assert.match(sync.newCode(), /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{12}$/);
  assert.notEqual(sync.newCode(), sync.newCode());
  assert.equal(sync.cleanCode('k7p2-9qxm-4htd'), CODE);
  assert.equal(sync.cleanCode(' K7P2 9QXM 4HTD '), CODE);
  assert.equal(sync.prettyCode(CODE), 'K7P2-9QXM-4HTD');
  assert.equal(sync.prettyCode(''), '');
  for (const bad of ['', 'K7P2-9QXM', 'K7P29QXM4HTDX', 'K7P29QXM4HT0', 'K7P29QXM4HTI', 'K7P29QXM4HT!', null, undefined]) assert.equal(sync.cleanCode(bad), '', String(bad));
  assert.throws(() => new sync.ChartSync({ code: 'corto' }), /código/);
});

// Una «computadora»: guarda sus cifrados y anota lo que le llega, como hace la interfaz.
function pc(net, charts, { code = CODE, ...extra } = {}) {
  const device = { charts, got: [] };
  device.sync = new sync.ChartSync({
    code, brokers: URLS, connect: net.connect, grace: 40,
    getCharts: () => device.charts,
    onChart: item => { device.got.push(item); device.charts = sync.mergeCharts(device.charts, [item]).next; },
    ...extra,
  });
  device.save = item => { device.charts = sync.mergeCharts(device.charts, [item]).next; device.sync.push(item); };
  return device;
}
const stored = (net, url, fp) => {
  const raw = net.brokers.get(url).retained.get(chartTopic(fp));
  return raw ? JSON.parse(new TextDecoder().decode(raw)) : null;
};
const finish = (...devices) => async () => { for (const device of devices) device.sync.stop(); await wait(300); };

test('un cifrado guardado en una computadora aparece en la otra, aunque la otra se abra después', async t => {
  const net = network(URLS);
  const a = pc(net, {});
  const b = pc(net, {});
  t.after(finish(a, b));
  a.sync.start();
  await wait();
  const somos = entry('abc123', '[Coro]\n| Db/F | Cm/Eb |', 1000, 'Somos - Majo & Dan');
  a.save(somos);
  await wait();
  for (const url of URLS) assert.equal(net.brokers.get(url).retained.size, 1, 'queda guardado en cada servidor');
  b.sync.start(); // se abre después: el servidor se lo entrega
  await wait();
  assert.equal(b.got.length, 1, 'llega una sola vez aunque lo entreguen dos servidores');
  assert.deepEqual(b.charts['fp:abc123'], somos);
  assert.equal(b.sync.status.received, 1);
  assert.equal(b.sync.status.connected, 2);
  // Un cambio con las dos abiertas llega en vivo.
  const better = { ...somos, text: '[Coro]\n| Db/F | Cm/Eb | Bb | Bbm/Db |', updated: 2000 };
  b.save(better);
  await wait();
  assert.equal(a.charts['fp:abc123'].text, better.text);
  assert.equal(a.got.at(-1).updated, 2000);
  assert.equal(a.charts['fp:abc123'].title, 'Somos - Majo & Dan');
});

test('si las dos computadoras tenían versiones distintas, al conectarse las dos quedan con la más reciente', async t => {
  const net = network(URLS);
  const old = entry('abc123', 'G D', 1000, 'Eres Fiel');
  const recent = { ...old, text: 'G D Em C', updated: 5000 };
  const a = pc(net, { 'fp:abc123': recent });
  const b = pc(net, { 'fp:abc123': old });
  t.after(finish(a, b));
  a.sync.start();
  b.sync.start();
  await wait(150);
  assert.equal(a.charts['fp:abc123'].text, 'G D Em C');
  assert.equal(b.charts['fp:abc123'].text, 'G D Em C');
  for (const url of URLS) assert.equal(stored(net, url, 'abc123').updated, 5000, 'cada servidor guarda la versión nueva');
});

test('quitar un cifrado en una computadora lo quita en la otra, y una copia vieja no lo revive', async t => {
  const net = network(URLS);
  const song = entry('abc123', 'G D', 1000, 'Eres Fiel');
  const a = pc(net, { 'fp:abc123': song });
  const b = pc(net, { 'fp:abc123': song });
  const c = pc(net, { 'fp:abc123': song }); // estaba apagada y aún tiene el cifrado
  t.after(finish(a, b, c));
  a.sync.start();
  b.sync.start();
  await wait(150);
  a.save({ ...song, text: '', updated: 2000 });
  await wait();
  assert.equal(b.charts['fp:abc123'].text, '');
  c.sync.start();
  await wait(150);
  assert.equal(c.charts['fp:abc123'].text, '');
  for (const url of URLS) {
    assert.equal(stored(net, url, 'abc123').text, '');
    assert.ok(net.brokers.get(url).retained.get(chartTopic('abc123')).length > 0, 'la baja lleva contenido: un mensaje vacío borraría lo guardado en el servidor');
  }
  assert.equal(c.sync.status.received, 1);
});

test('con otro código no se ve nada de lo ajeno', async t => {
  const net = network(URLS);
  const a = pc(net, { 'fp:abc123': entry('abc123', 'G D', 1000, 'Eres Fiel') });
  const stranger = pc(net, {}, { code: 'B8M2-NQ4T-W6RA' });
  t.after(finish(a, stranger));
  a.sync.start();
  stranger.sync.start();
  await wait(150);
  assert.equal(stranger.got.length, 0);
  assert.equal(stranger.sync.status.received, 0);
  for (const slot of stranger.sync.slots) assert.deepEqual([...slot.client.subs], ['escena/cifrados/v1/B8M2NQ4TW6RA/+'], 'solo escucha su propio código');
  assert.equal(a.sync.status.received, 1, 'solo recibe su propio eco');
});

test('al conectarse completa solo lo que le falta a cada servidor', async t => {
  const net = network(URLS);
  const x = entry('xxx', 'G D', 1000, 'X');
  const y = entry('yyy', 'C F', 2000, 'Y');
  const gone = entry('ggg', '', 3000, 'Borrada'); // una baja de algo que ningún servidor tiene: no hace falta publicarla
  const a = pc(net, { 'fp:xxx': x, 'fp:yyy': y, 'fp:ggg': gone, 'viejo-7': { text: 'sin huella', updated: 5 } });
  // El segundo servidor ya tiene X (alguien más lo dejó); el primero no tiene nada.
  net.brokers.get(URLS[1]).retained.set(chartTopic('xxx'), new TextEncoder().encode(JSON.stringify({ v: 1, ...x })));
  t.after(finish(a));
  a.sync.start();
  await wait(150);
  const [first, second] = URLS.map(url => net.brokers.get(url));
  assert.deepEqual([...first.retained.keys()].sort(), [chartTopic('xxx'), chartTopic('yyy')]);
  assert.deepEqual([...second.retained.keys()].sort(), [chartTopic('xxx'), chartTopic('yyy')]);
  const count = (broker, topic) => broker.log.filter(item => item === topic).length;
  assert.equal(count(first, chartTopic('xxx')), 1);
  assert.equal(count(second, chartTopic('xxx')), 0, 'al segundo no se le vuelve a mandar lo que ya tenía');
  assert.equal(count(second, chartTopic('yyy')), 1);
  assert.equal(count(first, chartTopic('ggg')) + count(second, chartTopic('ggg')), 0);
});

test('ignora mensajes rotos, de otro tema o demasiado grandes, y limita las fechas adelantadas', async t => {
  const net = network(URLS);
  const a = pc(net, {});
  t.after(finish(a));
  a.sync.start();
  await wait();
  const intruder = memorySocket(net.brokers.get(URLS[0]));
  await wait();
  const good = { v: 1, fp: 'abc', title: 'T', text: 'G D', updated: 5 };
  const send = (topic, payload) => intruder.send(mqtt.publishPacket(topic, typeof payload === 'string' ? payload : JSON.stringify(payload)));
  send(chartTopic('abc'), 'no es json');
  send(chartTopic('abc'), { ...good, fp: 'otra' }); // la huella no coincide con el tema
  send(chartTopic('abc'), { ...good, text: 7 });
  send(chartTopic('abc'), { ...good, text: 'x'.repeat(sync.MAX_TEXT + 1) });
  send(chartTopic('abc'), { ...good, updated: 'ayer' });
  send(chartTopic('abc'), '');
  send(`${chartTopic('abc')}/extra`, good);
  await wait();
  assert.equal(a.got.length, 0);
  send(chartTopic('abc'), { ...good, updated: Date.now() + 90 * DAY });
  await wait();
  assert.equal(a.got.length, 1);
  assert.ok(a.got[0].updated <= Date.now() + DAY, 'un reloj adelantado se limita a un día');
});

test('basta con un servidor, y al detener la sincronización ya no entra ni sale nada', async t => {
  const net = network(URLS);
  net.down.add(URLS[0]);
  const a = pc(net, {});
  const b = pc(net, {});
  t.after(finish(a, b));
  a.sync.start();
  b.sync.start();
  await wait();
  assert.equal(a.sync.status.connected, 1);
  assert.equal(a.sync.status.total, 2);
  b.save(entry('abc123', 'G D', 1000, 'Eres Fiel'));
  await wait();
  assert.equal(a.charts['fp:abc123'].text, 'G D');
  a.sync.stop();
  await wait();
  assert.equal(a.sync.status.running, false);
  assert.equal(a.sync.status.connected, 0);
  a.sync.push(entry('solo-a', 'C', 2000, 'No debe salir'));
  b.save(entry('abc123', 'G D Em', 3000, 'Eres Fiel'));
  await wait();
  assert.equal(a.charts['fp:abc123'].text, 'G D', 'detenida, ya no recibe');
  assert.equal(net.brokers.get(URLS[1]).retained.has(chartTopic('solo-a')), false, 'detenida, ya no publica');
  a.sync.start(); // y se puede volver a encender
  await wait(150);
  assert.equal(a.charts['fp:abc123'].text, 'G D Em');
});

// ───────────── Reproductor ─────────────

let SongPlayer = null;
try { ({ SongPlayer } = await import(await moduleURL('player.js'))); } catch { /* carpeta sin el resto de Escena */ }
const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('liveState informa posición, espera de arranque, pre-conteo, repetición y tono', { skip: SongPlayer ? false : 'falta el resto de Escena (tempo.js, synth.js…)' }, () => {
  const ctx = { currentTime: 10 };
  const player = Object.create(SongPlayer.prototype);
  Object.assign(player, {
    ctx, duration: 44, state: 'stopped', run: null, pending: null, pausedAt: 0, pitchSemitones: 0, offset: 0,
    song: { click: { countIn: 2 } }, tempo: { segmentAtTime: () => ({ beatDur: 0.5, num: 4 }) },
  });
  assert.deepEqual(player.liveState(), { state: 'stopped', pos: 0, wait: 0, counting: false, loop: null, pitch: 0, duration: 44 });

  Object.assign(player, { state: 'paused', pausedAt: 12.5, pitchSemitones: 2 });
  assert.deepEqual(player.liveState(), { state: 'paused', pos: 12.5, wait: 0, counting: false, loop: null, pitch: 2, duration: 44 });

  // Tocando desde 5 s: la música arranca 0,2 s después de pulsar play.
  Object.assign(player, { state: 'playing', run: { ctxStart: 10.2, songStart: 5, loop: null, countStart: 0, countEnd: 0 } });
  let live = player.liveState();
  assert.equal(live.pos, 5);
  close(live.wait, 0.2);
  assert.equal(live.counting, false, 'el margen de arranque no es un pre-conteo');
  ctx.currentTime = 13.2;
  live = player.liveState();
  close(live.pos, 8);
  assert.equal(live.wait, 0);

  // Repetición 8–16: la posición da la vuelta, como la oye el músico.
  player.run = { ctxStart: 10.2, songStart: 14, loop: { a: 8, b: 16 }, countStart: 0, countEnd: 0 };
  live = player.liveState();
  close(live.pos, 9);
  assert.deepEqual(live.loop, { a: 8, b: 16 });

  // Pre-conteo de 4 s que termina cuando entra la música (a los 12 s del reloj de audio).
  ctx.currentTime = 9;
  player.run = { ctxStart: 12, songStart: 0, loop: null, countStart: 8, countEnd: 12 };
  live = player.liveState();
  assert.equal(live.counting, true);
  assert.equal(live.pos, 0);
  close(live.wait, 3);

  // Un salto programado no cambia nada hasta que llega su instante.
  ctx.currentTime = 15;
  player.run = { ctxStart: 10, songStart: 0, loop: null, countStart: 0, countEnd: 0 };
  player.pending = { ctxStart: 16, songStart: 30, loop: null };
  close(player.liveState().pos, 5);
  ctx.currentTime = 16.5;
  close(player.liveState().pos, 30.5);
});
