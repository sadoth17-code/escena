// Pruebas de la lógica de la pestaña DJ (sin navegador): matemática de la mezcla, MIDI/teclado y controlador.
// Ejecutar: node --test tests/dj-core.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createEmitter } from '../www/js/util.js';
import * as math from '../www/js/dj-math.js';
import * as midi from '../www/js/dj-midi.js';
import { createMemoryDjStore } from '../www/js/dj-store.js';
import { createDj, isAudioFile, cleanName } from '../www/js/dj.js';

const near = (actual, expected, tolerance = 1e-9, message = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${message} esperado ${expected}, recibido ${actual}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Todo controlador creado se destruye al terminar, falle o no la prueba (si no, su reloj mantiene vivo el proceso).
const abiertos = [];
after(() => abiertos.forEach((dj) => dj.destroy()));
const clock = { t: 100000 };
const tick = (ms = 1000) => (clock.t += ms);

// ------------------------------------------------------------------ matemática de la mezcla

test('fadeSeconds: corte, límites y valores raros', () => {
  assert.equal(math.fadeSeconds(0), math.MIN_FADE);
  assert.equal(math.fadeSeconds(-3), math.MIN_FADE);
  assert.equal(math.fadeSeconds(4), 4);
  assert.equal(math.fadeSeconds(99), math.MAX_FADE);
  assert.equal(math.fadeSeconds('abc'), math.DEFAULT_FADE);
  assert.equal(math.fadeSeconds(undefined, 2), 2);
});

test('mezcla de potencia constante: la suma de potencias es siempre 1 (el volumen no se hunde)', () => {
  for (let step = 0; step <= 100; step++) {
    const x = step / 100;
    const entra = math.blendLevel(0, 1, x);
    const sale = math.blendLevel(1, 0, x);
    near(entra * entra + sale * sale, 1, 1e-12, `x=${x}`);
  }
  near(math.blendLevel(0, 1, 0), 0);
  near(math.blendLevel(0, 1, 1), 1);
  near(math.blendLevel(1, 0, 1), 0, 1e-12);
  near(math.blendLevel(0.5, 0.5, 0.37), 0.5, 1e-12);
});

test('cambiar de idea a mitad de una mezcla no produce saltos de nivel', () => {
  // A sale y B entra (potencia constante). A los 1.3 s se pide C: A y B bajan desde su nivel exacto y C sube.
  const a = math.makePlan(0, 4, 1, 0);
  const b = math.makePlan(0, 4, 0, 1);
  const t = 1.3;
  const la = math.planLevel(a, t);
  const lb = math.planLevel(b, t);
  near(la * la + lb * lb, 1, 1e-12, 'antes del cambio');
  const a2 = math.makePlan(t, 3, la, 0);
  const b2 = math.makePlan(t, 3, lb, 0);
  const c = math.makePlan(t, 3, 0, 1);
  near(math.planLevel(a2, t), la, 1e-12, 'A continúa donde estaba');
  near(math.planLevel(b2, t), lb, 1e-12, 'B continúa donde estaba');
  near(math.planLevel(c, t), 0, 1e-12, 'C entra desde cero');
  for (let step = 0; step <= 60; step++) {
    const time = t + (3 * step) / 60;
    const power = [a2, b2, c].reduce((sum, plan) => sum + math.planLevel(plan, time) ** 2, 0);
    near(power, 1, 1e-9, `potencia total en ${time.toFixed(2)} s`);
  }
});

test('una canción que ya sonaba a medias y vuelve a entrar sube desde su nivel, sin saltos', () => {
  const sale = math.makePlan(0, 4, 1, 0);
  const t = 2;
  const nivel = math.planLevel(sale, t);
  const vuelve = math.makePlan(t, 2, nivel, 1);
  near(math.planLevel(vuelve, t), nivel, 1e-12);
  near(math.planLevel(vuelve, t + 2), 1, 1e-12);
  let previous = nivel;
  for (let step = 1; step <= 40; step++) {
    const value = math.planLevel(vuelve, t + (2 * step) / 40);
    assert.ok(value >= previous - 1e-12, 'sube sin bajar');
    previous = value;
  }
});

test('fadePoints: suficientes puntos, termina exacto y sigue la curva', () => {
  for (const seconds of [0.06, 0.5, 4, 12]) {
    const plan = math.makePlan(10, seconds, 0, 1);
    const points = math.fadePoints(plan);
    assert.ok(points.length >= 24);
    assert.equal(points[points.length - 1][1], 1);
    near(points[points.length - 1][0], plan.dur, 1e-12);
    let previousTime = 0;
    for (const [offset, value] of points) {
      assert.ok(offset > previousTime);
      previousTime = offset;
      near(value, math.planLevel(plan, 10 + offset), 1e-9);
    }
  }
});

test('planDone / planProgress', () => {
  const plan = math.makePlan(5, 2, 0, 1);
  assert.equal(math.planDone(plan, 4), false);
  assert.equal(math.planDone(plan, 7), true);
  assert.equal(math.planDone(null, 0), true);
  assert.equal(math.planProgress(plan, 6), 0.5);
});

test('limitador: no toca lo normal, redondea lo fuerte y nunca pasa del techo', () => {
  const curve = math.makeLimiterCurve();
  const at = (x) => curve[Math.round(((x + 1) / 2) * (curve.length - 1))];
  near(at(0), 0, 1e-6);
  near(at(0.2), 0.2, 1e-3, 'señal baja intacta');
  near(at(0.4), 0.4, 2e-3, 'bajo la rodilla intacta');
  assert.ok(at(1) <= 0.485 + 1e-6 && at(-1) >= -0.485 - 1e-6, 'techo de 0.97 una vez devuelta la ganancia');
  near(at(0.5), -at(-0.5), 1e-6, 'simétrico');
  let previous = -Infinity;
  for (const value of curve) {
    assert.ok(value >= previous - 1e-9, 'monótona');
    previous = value;
  }
  // Con ganancia 0.5 antes y 2 después, una señal normal (máximo 0.85) sale igual y dos canciones muy fuertes sumadas (1.9) no pasan de 1.
  near(at(0.85 * 0.5) * 2, 0.85, 3e-3);
  assert.ok(at(1.9 * 0.5) * 2 <= 0.97 + 1e-6);
});

test('fmtClock y parseClock', () => {
  assert.equal(math.fmtClock(0), '0:00');
  assert.equal(math.fmtClock(65.9), '1:05');
  assert.equal(math.fmtClock(3600 + 61), '1:01:01');
  assert.equal(math.fmtClock(-5), '0:00');
  assert.equal(math.fmtClock(NaN), '0:00');
  assert.equal(math.parseClock('83'), 83);
  assert.equal(math.parseClock('1:23'), 83);
  assert.equal(math.parseClock('01:02:03'), 3723);
  assert.equal(math.parseClock('1,5'), 1.5);
  assert.ok(Number.isNaN(math.parseClock('')));
  assert.ok(Number.isNaN(math.parseClock('a:10')));
  assert.ok(Number.isNaN(math.parseClock('1:2:3:4')));
});

test('itemEnd y remainingSeconds', () => {
  assert.equal(math.itemEnd({ start: 10, maxDur: 30 }, 200), 40);
  assert.equal(math.itemEnd({ start: 190, maxDur: 30 }, 200), 200, 'no pasa del final de la canción');
  assert.equal(math.itemEnd({ start: 10, maxDur: 0 }, 200), 200);
  assert.equal(math.itemEnd({ start: 10, maxDur: 30 }, 0), 40, 'sin duración conocida usa la máxima');
  assert.equal(math.itemEnd({ start: 0, maxDur: 0 }, 0), 0);
  assert.equal(math.remainingSeconds({ start: 10, maxDur: 30 }, 25, 200), 15);
  assert.equal(math.remainingSeconds({ start: 10, maxDur: 30 }, 55, 200), 0);
  assert.equal(math.remainingSeconds({ start: 0, maxDur: 0 }, 5, 0), null);
});

test('resolveNextItem / resolvePrevItem / moveItem', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  assert.equal(math.resolveNextItem(items, null, null).id, 'a');
  assert.equal(math.resolveNextItem(items, 'a', null).id, 'b');
  assert.equal(math.resolveNextItem(items, 'a', 'd').id, 'd', 'la elegida manda');
  assert.equal(math.resolveNextItem(items, 'd', null), null);
  assert.equal(math.resolveNextItem(items, 'a', 'a').id, 'b', 'elegir la que suena no cuenta');
  assert.equal(math.resolveNextItem([], null, null), null);
  assert.equal(math.resolvePrevItem(items, 'c').id, 'b');
  assert.equal(math.resolvePrevItem(items, 'a'), null);
  assert.equal(math.resolvePrevItem(items, null), null);
  assert.deepEqual(math.moveItem(items, 1, 1).map((i) => i.id), ['a', 'c', 'b', 'd']);
  assert.deepEqual(math.moveItem(items, 0, -1).map((i) => i.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(math.moveItem(items, 3, 5).map((i) => i.id), ['a', 'b', 'c', 'd']);
});

test('shouldStartMix: empieza `fade` segundos antes del final', () => {
  assert.equal(math.shouldStartMix({ position: 35, end: 40, fade: 4 }), false);
  assert.equal(math.shouldStartMix({ position: 36, end: 40, fade: 4 }), true);
  assert.equal(math.shouldStartMix({ position: 5, end: 0, fade: 4 }), false);
});

test('softTakeover: la perilla no se oye hasta alcanzar el volumen actual', () => {
  const state = math.newTakeover();
  assert.equal(math.softTakeover(state, 0.0, 0.78), false);
  assert.equal(math.softTakeover(state, 0.3, 0.78), false);
  assert.equal(math.softTakeover(state, 0.7, 0.78), false);
  assert.equal(math.softTakeover(state, 0.8, 0.78), true, 'cruzó el valor actual');
  assert.equal(math.softTakeover(state, 0.2, 0.78), true, 'ya enganchada sigue');
  const near = math.newTakeover();
  assert.equal(math.softTakeover(near, 0.77, 0.78), true, 'ya estaba casi en el mismo punto');
  const falling = math.newTakeover();
  assert.equal(math.softTakeover(falling, 1.0, 0.5), false);
  assert.equal(math.softTakeover(falling, 0.4, 0.5), true, 'cruzó hacia abajo');
});

// ------------------------------------------------------------------ MIDI y teclado

test('parseMessage: notas, controles, programa, pitch bend y mensajes de sistema', () => {
  assert.deepEqual(midi.parseMessage([0x99, 36, 100]), { kind: 'note', on: true, channel: 10, note: 36, velocity: 100 });
  assert.equal(midi.parseMessage([0x90, 36, 0]).on, false, 'nota con fuerza 0 es soltar');
  assert.equal(midi.parseMessage([0x80, 36, 64]).on, false);
  assert.deepEqual(midi.parseMessage([0xb0, 21, 127]), { kind: 'cc', channel: 1, cc: 21, value: 127 });
  assert.deepEqual(midi.parseMessage([0xc2, 5]), { kind: 'program', channel: 3, program: 5 });
  near(midi.parseMessage([0xe0, 0x7f, 0x7f]).value, 1);
  near(midi.parseMessage([0xe0, 0, 0]).value, 0);
  assert.equal(midi.parseMessage([0xf8]), null, 'reloj MIDI');
  assert.equal(midi.parseMessage([0xfe]), null, 'active sensing');
  assert.equal(midi.parseMessage([0x40, 1, 2]), null, 'datos sueltos');
  assert.equal(midi.parseMessage([]), null);
  assert.equal(midi.parseMessage(null), null);
});

test('detector de pulsaciones: rebote, cruce de 64, repetición y perillas', () => {
  let time = 1000;
  const detector = midi.createPressDetector({ now: () => time });
  const feed = (data) => detector.feed(midi.parseMessage(data));
  assert.equal(feed([0x90, 36, 100]).press, 'n:1:36');
  time += 30;
  assert.equal(feed([0x90, 36, 100]).press, null, 'rebote de 30 ms');
  time += 200;
  assert.equal(feed([0x90, 36, 100]).press, 'n:1:36');
  assert.equal(feed([0x90, 37, 0]).press, null, 'soltar no cuenta');
  // Botón que manda CC 127 al apretar y 0 al soltar
  time += 500;
  assert.equal(feed([0xb0, 20, 127]).press, 'c:1:20');
  time += 100;
  assert.equal(feed([0xb0, 20, 0]).press, null);
  time += 500;
  assert.equal(feed([0xb0, 20, 127]).press, 'c:1:20');
  // Botón que manda siempre 127 (sin soltar): solo cuenta si pasaron 400 ms
  time += 1000;
  assert.equal(feed([0xb0, 22, 127]).press, 'c:1:22');
  time += 100;
  assert.equal(feed([0xb0, 22, 127]).press, null);
  time += 500;
  assert.equal(feed([0xb0, 22, 127]).press, 'c:1:22');
  // Una perilla que gira: movimientos, y una sola pulsación al cruzar 64
  time += 1000;
  const movimientos = [10, 30, 50, 70, 90].map((value) => feed([0xb1, 7, value]));
  assert.deepEqual(movimientos.map((r) => r.move.position > 0), [true, true, true, true, true]);
  assert.deepEqual(movimientos.map((r) => r.press), [null, null, null, 'c:2:7', null]);
  assert.equal(movimientos[4].move.trigger, 'c:2:7');
  near(feed([0xb1, 7, 127]).move.position, 1);
  assert.equal(feed([0xc0, 7]).press, 'p:1:7');
  const bend = feed([0xe0, 0, 64]);
  assert.equal(bend.move.trigger, 'b:1');
  assert.equal(bend.press, null);
});

test('asignaciones: exclusivas, con teclado por defecto y reversibles', () => {
  const base = midi.DEFAULT_BINDINGS;
  assert.deepEqual(base.next, ['k:ArrowRight', 'k:PageDown']);
  assert.deepEqual(base['slot:1'], ['k:Digit1', 'k:Numpad1']);
  assert.equal(base['slot:9'][0], 'k:Digit9');
  const uno = midi.assignBinding(base, 'next', 'n:10:36');
  assert.deepEqual(uno.next, ['k:ArrowRight', 'k:PageDown', 'n:10:36']);
  assert.deepEqual(base.next, ['k:ArrowRight', 'k:PageDown'], 'no modifica el original');
  const dos = midi.assignBinding(uno, 'slot:1', 'n:10:36');
  assert.ok(!dos.next.includes('n:10:36'), 'un botón solo hace una cosa');
  assert.ok(dos['slot:1'].includes('n:10:36'));
  const tres = midi.removeBinding(dos, 'slot:1', 'n:10:36');
  assert.ok(!tres['slot:1'].includes('n:10:36'));
  const sinPads = midi.clearSlots(dos);
  assert.deepEqual(sinPads['slot:1'], []);
  assert.deepEqual(sinPads.next, dos.next, 'solo se borran los pads');
  assert.equal(midi.acceptsTrigger('volume', 'c:1:7'), true);
  assert.equal(midi.acceptsTrigger('volume', 'b:1'), true);
  assert.equal(midi.acceptsTrigger('volume', 'n:1:36'), false);
  assert.equal(midi.acceptsTrigger('volume', 'k:KeyA'), false);
  assert.equal(midi.acceptsTrigger('next', 'k:KeyA'), true);
});

test('descripciones legibles de botones y mensajes', () => {
  assert.equal(midi.describeTrigger('n:10:36'), 'Nota 36 (Do2) · canal 10');
  assert.equal(midi.describeTrigger('c:1:21'), 'Control 21 · canal 1');
  assert.equal(midi.describeTrigger('p:1:5'), 'Programa 5 · canal 1');
  assert.equal(midi.describeTrigger('b:2'), 'Pitch bend · canal 2');
  assert.equal(midi.describeTrigger('k:Space'), 'Tecla Espacio');
  assert.equal(midi.describeTrigger('k:KeyQ'), 'Tecla Q');
  assert.equal(midi.describeTrigger('k:Digit3'), 'Tecla 3');
  assert.equal(midi.describeTrigger('k:Numpad7'), 'Tecla num 7');
  assert.match(midi.describeMessage(midi.parseMessage([0x99, 36, 100])), /Nota 36 \(Do2\).*canal 10/);
  assert.equal(midi.slotNumber('slot:12'), 12);
  assert.equal(midi.slotNumber('next'), 0);
  assert.equal(midi.actionName('slot:3'), 'Participante 3');
});

function routerFixture(bindings = null) {
  const log = { actions: [], values: [], signals: [] };
  let time = 0;
  const router = midi.createRouter({
    getBindings: () => bindings || midi.DEFAULT_BINDINGS,
    onAction: (action) => log.actions.push(action),
    onValue: (action, position) => log.values.push([action, position]),
    onSignal: ({ text }) => log.signals.push(text),
    now: () => (time += 1000),
  });
  return { router, log };
}

test('router: ignora todo mientras no está activo y ejecuta cuando lo está', () => {
  const { router, log } = routerFixture({ ...midi.DEFAULT_BINDINGS, next: ['n:10:36'], volume: ['c:1:7'] });
  router.handleMessage([0x99, 36, 100]);
  assert.deepEqual(log.actions, []);
  assert.equal(log.signals.length, 1, 'el monitor sí ve la señal');
  router.setActive(true);
  router.handleMessage([0x99, 36, 100]);
  assert.deepEqual(log.actions, ['next']);
  router.handleMessage([0xb0, 7, 64]);
  assert.deepEqual(log.values, [['volume', 64 / 127]]);
  assert.deepEqual(log.actions, ['next'], 'una perilla de volumen no dispara botones');
  router.handleMessage([0x99, 99, 100]);
  assert.deepEqual(log.actions, ['next'], 'sin asignar no hace nada');
});

test('router: aprender un botón, una perilla y cancelar', async () => {
  const { router, log } = routerFixture();
  router.setActive(true);
  const botón = router.learn();
  assert.deepEqual(router.learning, { continuous: false });
  router.handleMessage([0xb0, 20, 30]); // movimiento bajo: no es un botón
  router.handleMessage([0x99, 40, 90]);
  assert.equal(await botón, 'n:10:40');
  assert.equal(router.learning, null);
  assert.deepEqual(log.actions, [], 'mientras aprende no ejecuta acciones');
  const perilla = router.learn({ continuous: true });
  router.handleMessage([0x99, 41, 90]); // una nota no vale para una perilla
  router.handleMessage([0xb2, 9, 10]);
  assert.equal(await perilla, 'c:3:9');
  const cancelada = router.learn();
  router.cancelLearn();
  assert.equal(await cancelada, null);
  const reemplazada = router.learn();
  const nueva = router.learn();
  assert.equal(await reemplazada, null, 'una nueva petición cancela la anterior');
  router.handleMessage([0x90, 50, 100]);
  assert.equal(await nueva, 'n:1:50');
});

test('router: teclado (acciones, escribir en campos, cancelar con Esc, aprender teclas)', async () => {
  const { router, log } = routerFixture();
  const key = (code, extra = {}) => ({ type: 'keydown', code, key: code, target: { tagName: 'BODY' }, preventDefault() { this.prevented = true; }, ...extra });
  assert.equal(router.handleKey(key('Space')), false, 'inactivo: no consume la tecla');
  router.setActive(true);
  const space = key('Space');
  assert.equal(router.handleKey(space), true);
  assert.equal(space.prevented, true);
  assert.deepEqual(log.actions, ['playPause']);
  assert.equal(router.handleKey(key('Digit2')), true);
  assert.deepEqual(log.actions, ['playPause', 'slot:2']);
  assert.equal(router.handleKey(key('Space', { repeat: true })), true, 'se consume pero no repite la acción');
  assert.deepEqual(log.actions, ['playPause', 'slot:2']);
  assert.equal(router.handleKey(key('Space', { target: { tagName: 'INPUT' } })), false, 'escribiendo en un campo');
  assert.equal(router.handleKey(key('Space', { ctrlKey: true })), false, 'con Ctrl no');
  assert.equal(router.handleKey(key('KeyZ')), false, 'sin asignar');
  const pendiente = router.learn();
  assert.equal(router.handleKey(key('ShiftLeft')), false, 'las modificadoras no se asignan');
  assert.equal(router.handleKey(key('KeyM')), true);
  assert.equal(await pendiente, 'k:KeyM');
  const otra = router.learn();
  assert.equal(router.handleKey(key('Escape')), true);
  assert.equal(await otra, null, 'Esc cancela en vez de asignarse');
  const perilla = router.learn({ continuous: true });
  assert.equal(router.handleKey(key('KeyA')), false, 'una perilla no se asigna con teclas');
  router.cancelLearn();
  assert.equal(await perilla, null);
});

test('router: al soltar una tecla del DJ (o recién asignada) se cancela su efecto normal', async () => {
  const { router } = routerFixture();
  const key = (code, extra = {}) => ({ type: 'keydown', code, key: code, target: { tagName: 'BODY' }, preventDefault() {}, ...extra });
  const up = (code, extra = {}) => ({ type: 'keyup', code, key: code, target: { tagName: 'BODY' }, ...extra });
  assert.equal(router.claimsKey(up('Space')), false, 'inactivo: la tecla es de la página');
  router.setActive(true);
  assert.equal(router.claimsKey(up('Space')), true, 'Espacio es del DJ: no debe volver a pulsar el botón enfocado');
  assert.equal(router.claimsKey(up('KeyZ')), false, 'sin asignar');
  assert.equal(router.claimsKey(up('Space', { target: { tagName: 'INPUT' } })), false, 'escribiendo en un campo');
  const pendiente = router.learn();
  assert.equal(router.handleKey(key('KeyM')), true);
  await pendiente;
  assert.equal(router.claimsKey(up('KeyM')), true, 'la tecla recién asignada tampoco debe pulsar nada al soltarse');
  assert.equal(router.claimsKey(up('KeyM')), false, 'solo esa vez');
  const otra = router.learn();
  assert.equal(router.handleKey(key('Escape')), true);
  await otra;
  assert.equal(router.claimsKey(up('Escape')), true, 'Esc que canceló también se absorbe');
});

// ------------------------------------------------------------------ controlador con un motor falso

function fakeEngine() {
  const events = createEmitter();
  const calls = [];
  const ready = new Set();
  const engine = {
    calls,
    events,
    on: events.on,
    snapshotData: { audio: 'running', current: null, decks: [], mixing: { active: false, progress: 1, seconds: 0 } },
    playingFlag: false,
    async unlock() {
      return true;
    },
    async load(key, blob, options) {
      calls.push(['load', key, options]);
      ready.add(key);
      return { duration: 200 };
    },
    isReady: (key) => ready.has(key),
    isLoading: () => false,
    mixTo(key, options) {
      calls.push(['mixTo', key, options.duration]);
      engine.playingFlag = true;
      engine.snapshotData.current = { key, state: 'playing', position: 0, duration: 200, level: 1 };
      return true;
    },
    pause(seconds) {
      calls.push(['pause', seconds]);
      return true;
    },
    resume(seconds) {
      calls.push(['resume', seconds]);
      return true;
    },
    stopAll(options) {
      calls.push(['stopAll', options.duration]);
      engine.playingFlag = false;
      return true;
    },
    snapshot: () => engine.snapshotData,
    setVolume: (gain) => calls.push(['volume', gain]),
    setWanted: (keys) => calls.push(['wanted', keys]),
    drop: (key) => {
      ready.delete(key);
      calls.push(['drop', key]);
    },
    get playing() {
      return engine.playingFlag;
    },
    peak: () => 0,
    setSink: async () => {},
    destroy() {},
  };
  return engine;
}

const audioFile = (name, size = 1000) => new File([new Uint8Array(size)], name, { type: 'audio/mpeg' });

async function djFixture({ names = ['03 Padrinos.mp3', '01 Novios.mp3', '02 Madrina.mp3', '10 Cierre.mp3'], host = {} } = {}) {
  const engine = fakeEngine();
  const toasts = [];
  const paused = [];
  const dj = createDj({
    store: createMemoryDjStore(),
    engine,
    now: () => clock.t,
    probe: async () => ({ duration: 200 }),
    host: { toast: (message, kind) => toasts.push([message, kind]), pauseMultitrack: () => paused.push(1), ...host },
  });
  abiertos.push(dj);
  await dj.init();
  await dj.importFiles(names.map((name) => audioFile(name)));
  dj.setActive(true);
  await sleep(0);
  return { dj, engine, toasts, paused, items: () => dj.items() };
}

test('controlador: importar ordena por nombre natural, crea el programa y descarta lo que no es audio', async () => {
  const { dj, toasts } = await djFixture();
  assert.deepEqual(dj.items().map((i) => i.title), ['01 Novios', '02 Madrina', '03 Padrinos', '10 Cierre']);
  assert.equal(dj.state.tracks.length, 4);
  assert.equal(dj.program().name, 'Programa 1');
  const antes = dj.state.tracks.length;
  const resultado = await dj.importFiles([new File([new Uint8Array(10)], 'notas.txt', { type: 'text/plain' })]);
  assert.deepEqual(resultado, []);
  assert.equal(dj.state.tracks.length, antes);
  assert.equal(toasts.at(-1)[1], 'error');
  assert.equal(isAudioFile(new File([], 'cancion.FLAC')), true);
  assert.equal(isAudioFile(new File([], 'foto.jpg', { type: 'image/jpeg' })), false);
  assert.equal(cleanName('Mi_canción__final.mp3'), 'Mi canción final');
  dj.destroy();
});

test('controlador: Siguiente arranca la primera con entrada corta y luego mezcla con la duración elegida', async () => {
  const { dj, engine, paused } = await djFixture();
  const ids = dj.items().map((i) => i.id);
  assert.equal(await dj.next(), true);
  assert.deepEqual(engine.calls.filter((c) => c[0] === 'mixTo').at(-1), ['mixTo', ids[0], math.START_FADE]);
  assert.equal(dj.state.transport, 'playing');
  assert.equal(dj.state.nowId, ids[0]);
  assert.ok(paused.length >= 1, 'al empezar a sonar se detiene el multitrack de Escena');
  dj.setFade(6);
  await dj.next();
  assert.deepEqual(engine.calls.filter((c) => c[0] === 'mixTo').at(-1), ['mixTo', ids[1], 6]);
  assert.equal(dj.state.nowId, ids[1]);
  await dj.prev();
  assert.deepEqual(engine.calls.filter((c) => c[0] === 'mixTo').at(-1), ['mixTo', ids[0], 6]);
  assert.equal(await dj.prev(), false, 'ya es la primera');
  dj.destroy();
});

test('controlador: elegir "Sigue" manda sobre el orden y se borra al usarla; pad directo salta a cualquiera', async () => {
  const { dj, engine } = await djFixture();
  const ids = dj.items().map((i) => i.id);
  await dj.next();
  dj.cue(ids[3]);
  assert.equal(dj.nextItem().id, ids[3]);
  assert.ok(engine.calls.some((c) => c[0] === 'wanted' && c[1][0] === ids[3]), 'la elegida se prepara de antemano');
  await dj.next();
  assert.equal(dj.state.nowId, ids[3]);
  assert.equal(dj.state.cueId, null);
  await dj.runAction('slot:2');
  assert.equal(dj.state.nowId, ids[1]);
  assert.deepEqual(engine.calls.filter((c) => c[0] === 'mixTo').at(-1), ['mixTo', ids[1], 4]);
  dj.cue(ids[2]);
  dj.cue(ids[2]);
  assert.equal(dj.state.cueId, null, 'tocar otra vez quita la elección');
  dj.destroy();
});

test('controlador: pausa, reanuda, para con fade y pánico', async () => {
  const { dj, engine } = await djFixture();
  await dj.playPause();
  assert.equal(dj.state.transport, 'playing');
  await dj.playPause();
  assert.deepEqual(engine.calls.filter((c) => c[0] === 'pause').at(-1), ['pause', math.PAUSE_FADE]);
  assert.equal(dj.state.transport, 'paused');
  await dj.playPause();
  assert.deepEqual(engine.calls.filter((c) => c[0] === 'resume').at(-1), ['resume', math.PAUSE_FADE]);
  assert.equal(dj.state.transport, 'playing');
  dj.setFade(3);
  dj.stopFade();
  assert.deepEqual(engine.calls.filter((c) => c[0] === 'stopAll').at(-1), ['stopAll', 3]);
  assert.equal(dj.state.transport, 'idle');
  await dj.playPause();
  assert.equal(dj.state.transport, 'playing', 'play después de parar vuelve a arrancar la misma');
  dj.panic();
  assert.deepEqual(engine.calls.filter((c) => c[0] === 'stopAll').at(-1), ['stopAll', math.PANIC_FADE]);
  assert.equal(dj.state.transport, 'idle');
  dj.destroy();
});

test('controlador: la última orden gana si se pulsan dos pads casi a la vez', async () => {
  const { dj, engine } = await djFixture();
  const ids = dj.items().map((i) => i.id);
  const a = dj.runAction('slot:1');
  const b = dj.runAction('slot:3');
  await Promise.all([a, b]);
  const mezclas = engine.calls.filter((c) => c[0] === 'mixTo');
  assert.equal(mezclas.at(-1)[1], ids[2]);
  assert.equal(dj.state.nowId, ids[2]);
  dj.destroy();
});

test('controlador: avance automático empieza la mezcla "fade" segundos antes del final', async () => {
  const { dj, engine } = await djFixture();
  const ids = dj.items().map((i) => i.id);
  dj.updateItem(ids[0], { start: 10, maxDur: 30 }); // termina en el segundo 40
  dj.setFade(4);
  await dj.next();
  const mezclasAntes = engine.calls.filter((c) => c[0] === 'mixTo').length;
  engine.snapshotData.current = { key: ids[0], state: 'playing', position: 20, duration: 200, level: 1 };
  await sleep(250);
  assert.equal(engine.calls.filter((c) => c[0] === 'mixTo').length, mezclasAntes, 'sin avance automático no hace nada');
  dj.setAutoAdvance(true);
  await sleep(250);
  assert.equal(engine.calls.filter((c) => c[0] === 'mixTo').length, mezclasAntes, 'todavía falta');
  engine.snapshotData.current = { key: ids[0], state: 'playing', position: 36.2, duration: 200, level: 1 };
  await sleep(250);
  const mezclas = engine.calls.filter((c) => c[0] === 'mixTo');
  assert.equal(mezclas.length, mezclasAntes + 1);
  assert.equal(mezclas.at(-1)[1], ids[1]);
  assert.ok(mezclas.at(-1)[2] <= 4 && mezclas.at(-1)[2] >= 0.3);
  await sleep(250);
  assert.equal(engine.calls.filter((c) => c[0] === 'mixTo').length, mezclasAntes + 1, 'una sola vez por canción');
  dj.destroy();
});

test('controlador: al terminar la canción sola queda detenido y, con avance automático, sigue con la próxima', async () => {
  const { dj, engine } = await djFixture();
  const ids = dj.items().map((i) => i.id);
  await dj.next();
  engine.events.emit('ended', { key: ids[0], current: true });
  assert.equal(dj.state.transport, 'idle');
  await dj.next();
  dj.setAutoAdvance(true);
  engine.events.emit('ended', { key: ids[1], current: true });
  await sleep(10);
  assert.equal(dj.state.nowId, ids[2]);
  assert.equal(dj.state.transport, 'playing');
  dj.destroy();
});

test('controlador: no se puede quitar lo que suena ni cambiar de programa a media música', async () => {
  const { dj, toasts } = await djFixture();
  const items = dj.items();
  await dj.next();
  assert.equal(dj.removeItem(items[0].id), false);
  const trackId = items[0].track.id;
  assert.equal(await dj.removeTrack(trackId), false);
  assert.equal(toasts.at(-1)[1], 'error');
  const segundo = await dj.createProgram('Desfile');
  assert.equal(dj.state.programId, segundo.id, 'crear un programa lo abre');
  dj.stopFade();
  dj.selectProgram(dj.state.programs[0].id);
  assert.equal(dj.state.programId, dj.state.programs[0].id);
  await dj.next();
  dj.selectProgram(segundo.id);
  assert.equal(dj.state.programId, dj.state.programs[0].id, 'no cambia mientras suena');
  dj.stopFade();
  assert.equal(dj.removeItem(items[0].id), true);
  assert.equal(dj.items().length, 3);
  assert.equal(await dj.removeTrack(items[1].track.id), true);
  assert.equal(dj.items().length, 2);
  assert.equal(dj.state.tracks.length, 3);
  dj.destroy();
});

test('controlador: orden, edición de participantes con límites razonables', async () => {
  const { dj } = await djFixture();
  const [a, b] = dj.items();
  dj.moveItemBy(a.id, 1);
  assert.equal(dj.items()[1].id, a.id);
  dj.moveItemBy(a.id, -5);
  assert.equal(dj.items()[1].id, a.id, 'fuera de rango no se mueve');
  dj.updateItem(b.id, { label: '  Entrada de los novios  ', start: 9999, maxDur: -4, gainDb: 99 });
  const editado = dj.items().find((i) => i.id === b.id);
  assert.equal(editado.title, 'Entrada de los novios');
  assert.equal(editado.start, 199, 'el inicio no pasa del final de la canción');
  assert.equal(editado.maxDur, 0);
  assert.equal(editado.gainDb, 12);
  dj.updateItem(b.id, { label: '' });
  assert.equal(dj.items().find((i) => i.id === b.id).title, '02 Madrina');
  dj.destroy();
});

test('controlador: asignar botones, pads en orden, pads por notas y volumen con toma suave', async () => {
  const { dj, engine } = await djFixture();
  const ids = dj.items().map((i) => i.id);
  // Asignar "Siguiente" a una nota del controlador
  const aprendiendo = dj.learn('next');
  assert.equal(dj.state.learning.action, 'next');
  dj.router.handleMessage([0x99, 48, 100]);
  assert.equal(await aprendiendo, 'n:10:48');
  assert.equal(dj.state.learning, null);
  assert.ok(dj.effectiveBindings().next.includes('n:10:48'));
  // Con el controlador: pulsar la nota hace la mezcla
  tick();
  dj.router.handleMessage([0x99, 48, 100]);
  await sleep(5);
  assert.equal(dj.state.nowId, ids[0]);
  // Pads por notas consecutivas: el primero y los demás siguen la numeración
  const repartiendo = dj.learnSlotsByNote();
  dj.router.handleMessage([0x99, 36, 100]);
  assert.equal(await repartiendo, 4);
  const b = dj.effectiveBindings();
  assert.deepEqual([1, 2, 3, 4].map((n) => b[`slot:${n}`].filter((t) => t.startsWith('n:'))), [['n:10:36'], ['n:10:37'], ['n:10:38'], ['n:10:39']]);
  tick();
  dj.router.handleMessage([0x99, 38, 90]);
  await sleep(5);
  assert.equal(dj.state.nowId, ids[2], 'el pad 3 lleva al tercer participante');
  assert.deepEqual(engine.calls.filter((c) => c[0] === 'mixTo').at(-1), ['mixTo', ids[2], 4]);
  // Pads en orden
  const ordenados = dj.learnSlots(1);
  for (const nota of [60, 61]) {
    await sleep(0);
    tick();
    dj.router.handleMessage([0x9a, nota, 100]);
  }
  await sleep(0);
  dj.cancelLearn();
  assert.equal(await ordenados, 2);
  assert.ok(dj.effectiveBindings()['slot:2'].includes('n:11:61'));
  assert.ok(!dj.effectiveBindings()['slot:1'].includes('n:10:36'), 'el pad nuevo reemplazó al anterior');
  // Volumen con perilla: se ignora hasta alcanzar el valor actual
  const volumen = dj.learn('volume');
  tick();
  dj.router.handleMessage([0xb0, 7, 10]);
  assert.equal(await volumen, 'c:1:7');
  dj.setVolume(0.78);
  const antesVol = engine.calls.filter((c) => c[0] === 'volume').length;
  dj.router.handleMessage([0xb0, 7, 5]);
  dj.router.handleMessage([0xb0, 7, 40]);
  assert.equal(engine.calls.filter((c) => c[0] === 'volume').length, antesVol, 'aún lejos del volumen actual');
  assert.ok(dj.state.midi.pickup !== null);
  dj.router.handleMessage([0xb0, 7, 110]);
  assert.ok(engine.calls.filter((c) => c[0] === 'volume').length > antesVol, 'al cruzar el valor actual se engancha');
  assert.equal(dj.state.midi.pickup, null);
  near(dj.state.settings.volume, 110 / 127, 1e-9);
  // Restablecer
  dj.resetBindings();
  assert.deepEqual(dj.effectiveBindings(), midi.DEFAULT_BINDINGS);
  dj.destroy();
});

test('controlador: sin permiso de audio guarda lo pedido y lo repite al activar', async () => {
  const engine = fakeEngine();
  let permitido = false;
  engine.unlock = async () => permitido;
  const dj = createDj({ store: createMemoryDjStore(), engine, probe: async () => ({ duration: 100 }), host: { toast() {} } });
  abiertos.push(dj);
  await dj.init();
  await dj.importFiles([audioFile('a.mp3'), audioFile('b.mp3')]);
  assert.equal(await dj.next(), false);
  assert.equal(dj.state.audioBlocked, true);
  assert.equal(engine.calls.filter((c) => c[0] === 'mixTo').length, 0);
  permitido = true;
  await dj.activateAudio();
  await sleep(10);
  assert.equal(dj.state.audioBlocked, false);
  assert.equal(engine.calls.filter((c) => c[0] === 'mixTo').length, 1, 'repitió la orden');
  dj.destroy();
});

test('controlador: guarda y recupera programas, canciones y ajustes', async () => {
  const store = createMemoryDjStore();
  const first = createDj({ store, engine: fakeEngine(), probe: async () => ({ duration: 90 }), host: { toast() {} } });
  abiertos.push(first);
  await first.init();
  await first.importFiles([audioFile('uno.mp3'), audioFile('dos.mp3')]);
  first.renameProgram(first.state.programId, 'Boda de Ana');
  first.setFade(7);
  first.setAutoAdvance(true);
  first.setVolume(0.5);
  first.updateItem(first.items()[0].id, { label: 'Entrada', start: 5, maxDur: 20 });
  await first.flush();
  first.destroy();
  const second = createDj({ store, engine: fakeEngine(), probe: async () => ({ duration: 0 }), host: { toast() {} } });
  abiertos.push(second);
  await second.init();
  assert.equal(second.state.tracks.length, 2);
  assert.equal(second.program().name, 'Boda de Ana');
  assert.equal(second.state.settings.fade, 7);
  assert.equal(second.state.settings.autoAdvance, true);
  assert.equal(second.state.settings.volume, 0.5);
  assert.deepEqual(second.items().map((i) => [i.title, i.start, i.maxDur]), [['Entrada', 5, 20], ['uno', 0, 0]]);
  second.destroy();
});
