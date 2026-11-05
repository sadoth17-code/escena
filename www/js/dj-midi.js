// Control de la pestaña DJ: teclado y controladores MIDI (pads, botones, perillas y faders).
//
// Se divide en dos partes:
//   - Router: lógica pura (traduce mensajes en acciones, asignación "aprender", teclas). Se prueba en Node.
//   - Puertos: la parte del navegador que abre Web MIDI (Chrome, Edge y Firefox; no Safari ni iPhone).
//
// Disparadores (trigger) con los que se guardan las asignaciones:
//   n:<canal>:<nota>        pad o tecla de un controlador (nota)
//   c:<canal>:<control>     botón o perilla (control continuo, CC)
//   p:<canal>:<programa>    cambio de programa
//   b:<canal>               pitch bend (algunos faders)
//   k:<código>              tecla del teclado del computador

export const NOTE_NAMES = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];
export const MAX_SLOTS = 64;

export const ACTIONS = [
  { id: 'next', name: 'Siguiente (mezcla)', detail: 'Mezcla a la canción que sigue' },
  { id: 'prev', name: 'Anterior (mezcla)', detail: 'Mezcla de vuelta a la canción anterior' },
  { id: 'playPause', name: 'Reproducir / pausa', detail: 'Pausa o reanuda con un fundido corto' },
  { id: 'stopFade', name: 'Parar con fade', detail: 'Baja la música despacio hasta el silencio' },
  { id: 'panic', name: 'Pánico', detail: 'Silencio inmediato' },
  { id: 'volume', name: 'Volumen', detail: 'Perilla o fader', continuous: true },
];

export const CONTINUOUS = new Set(ACTIONS.filter((action) => action.continuous).map((action) => action.id));

export const slotAction = (number) => `slot:${number}`;

export function slotNumber(action) {
  const match = /^slot:(\d+)$/.exec(String(action));
  return match ? Number(match[1]) : 0;
}

export function actionName(action) {
  const found = ACTIONS.find((item) => item.id === action);
  if (found) return found.name;
  const slot = slotNumber(action);
  return slot ? `Participante ${slot}` : String(action);
}

export function buildDefaultBindings() {
  const bindings = {
    next: ['k:ArrowRight', 'k:PageDown'],
    prev: ['k:ArrowLeft', 'k:PageUp'],
    playPause: ['k:Space'],
    stopFade: [],
    panic: [],
    volume: [],
  };
  for (let number = 1; number <= 9; number++) bindings[slotAction(number)] = [`k:Digit${number}`, `k:Numpad${number}`];
  return bindings;
}

export const DEFAULT_BINDINGS = buildDefaultBindings();

// ---------------------------------------------------------------- mensajes MIDI

export function parseMessage(data) {
  if (!data || data.length < 1) return null;
  const status = data[0];
  // Datos sueltos (< 0x80) y mensajes de sistema (reloj, "sigo vivo", etc.): no son controles.
  if (status < 0x80 || status >= 0xf0) return null;
  const type = status & 0xf0;
  const channel = (status & 0x0f) + 1;
  const first = (data[1] ?? 0) & 0x7f;
  const second = (data[2] ?? 0) & 0x7f;
  switch (type) {
    case 0x90:
      return { kind: 'note', on: second > 0, channel, note: first, velocity: second };
    case 0x80:
      return { kind: 'note', on: false, channel, note: first, velocity: second };
    case 0xb0:
      return { kind: 'cc', channel, cc: first, value: second };
    case 0xc0:
      return { kind: 'program', channel, program: first };
    case 0xe0:
      return { kind: 'bend', channel, value: (first | (second << 7)) / 16383 };
    default:
      return null;
  }
}

export function noteLabel(note) {
  return `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
}

export function describeMessage(message) {
  switch (message.kind) {
    case 'note':
      return message.on ? `Nota ${message.note} (${noteLabel(message.note)}) · fuerza ${message.velocity} · canal ${message.channel}` : `Nota ${message.note} suelta · canal ${message.channel}`;
    case 'cc':
      return `Control ${message.cc} = ${message.value} · canal ${message.channel}`;
    case 'program':
      return `Programa ${message.program} · canal ${message.channel}`;
    case 'bend':
      return `Pitch bend ${Math.round(message.value * 100)}% · canal ${message.channel}`;
    default:
      return '';
  }
}

const KEY_NAMES = {
  Space: 'Espacio',
  Escape: 'Esc',
  ArrowRight: '→',
  ArrowLeft: '←',
  ArrowUp: '↑',
  ArrowDown: '↓',
  PageDown: 'Av Pág',
  PageUp: 'Re Pág',
  Enter: 'Intro',
  Backspace: 'Borrar',
  Tab: 'Tab',
  Home: 'Inicio',
  End: 'Fin',
  Delete: 'Supr',
  Insert: 'Insert',
  NumpadEnter: 'Num Intro',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num -',
  NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /',
  NumpadDecimal: 'Num .',
};

export function describeTrigger(trigger) {
  const [kind, ...rest] = String(trigger).split(':');
  if (kind === 'n') return `Nota ${rest[1]} (${noteLabel(Number(rest[1]))}) · canal ${rest[0]}`;
  if (kind === 'c') return `Control ${rest[1]} · canal ${rest[0]}`;
  if (kind === 'p') return `Programa ${rest[1]} · canal ${rest[0]}`;
  if (kind === 'b') return `Pitch bend · canal ${rest[0]}`;
  if (kind === 'k') {
    const code = rest.join(':');
    if (KEY_NAMES[code]) return `Tecla ${KEY_NAMES[code]}`;
    if (/^Key[A-Z]$/.test(code)) return `Tecla ${code.slice(3)}`;
    if (/^Digit\d$/.test(code)) return `Tecla ${code.slice(5)}`;
    if (/^Numpad\d$/.test(code)) return `Tecla num ${code.slice(6)}`;
    return `Tecla ${code.length === 1 ? code.toUpperCase() : code}`;
  }
  return String(trigger);
}

// Versión corta para las etiquetas de cada participante: "Nota 36", "CC 21", "Tecla 1".
export function shortTrigger(trigger) {
  const [kind, ...rest] = String(trigger).split(':');
  if (kind === 'n') return `Nota ${rest[1]}`;
  if (kind === 'c') return `CC ${rest[1]}`;
  if (kind === 'p') return `Prog ${rest[1]}`;
  if (kind === 'b') return 'Fader';
  if (kind === 'k') return describeTrigger(trigger).replace(/^Tecla /, '');
  return String(trigger);
}

export const isKeyTrigger = (trigger) => String(trigger).startsWith('k:');
export const isContinuousTrigger = (trigger) => /^(c:|b:)/.test(String(trigger));

// Una acción continua (volumen) solo admite un control continuo; las demás admiten cualquier botón o tecla.
export function acceptsTrigger(action, trigger) {
  return CONTINUOUS.has(action) ? isContinuousTrigger(trigger) : Boolean(trigger);
}

// ---------------------------------------------------------------- detección de pulsaciones

// Convierte mensajes sueltos en "pulsaciones" (botón apretado) y "movimientos" (perilla).
//   - nota con fuerza > 0                    -> pulsación
//   - control que cruza 64 hacia arriba      -> pulsación (también si se repite 127 pasados 400 ms)
//   - cambio de programa                     -> pulsación
//   - cualquier control o pitch bend         -> movimiento con posición 0..1
// Una misma pulsación que llega varias veces en 80 ms (rebote del botón) cuenta una sola vez.
export function createPressDetector({ debounceMs = 80, repeatMs = 400, now = () => Date.now() } = {}) {
  const lastPress = new Map();
  const lastCc = new Map();
  const accept = (trigger, time) => {
    const previous = lastPress.get(trigger);
    if (previous !== undefined && time - previous < debounceMs) return false;
    lastPress.set(trigger, time);
    return true;
  };
  return {
    feed(message) {
      const time = now();
      const out = { press: null, move: null };
      if (message.kind === 'note') {
        if (message.on) {
          const trigger = `n:${message.channel}:${message.note}`;
          if (accept(trigger, time)) out.press = trigger;
        }
      } else if (message.kind === 'cc') {
        const key = `${message.channel}:${message.cc}`;
        const trigger = `c:${key}`;
        const previous = lastCc.get(key) || { value: 0, time: -Infinity };
        lastCc.set(key, { value: message.value, time });
        out.move = { trigger, position: message.value / 127 };
        const rising = message.value >= 64 && (previous.value < 64 || (message.value === previous.value && time - previous.time > repeatMs));
        if (rising && accept(trigger, time)) out.press = trigger;
      } else if (message.kind === 'program') {
        const trigger = `p:${message.channel}:${message.program}`;
        if (accept(trigger, time)) out.press = trigger;
      } else if (message.kind === 'bend') {
        out.move = { trigger: `b:${message.channel}`, position: message.value };
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------- asignaciones

export function buildLookup(bindings) {
  const lookup = new Map();
  for (const [action, triggers] of Object.entries(bindings || {})) {
    for (const trigger of triggers || []) if (!lookup.has(trigger)) lookup.set(trigger, action);
  }
  return lookup;
}

function cloneBindings(bindings) {
  const copy = {};
  for (const [action, triggers] of Object.entries(bindings || {})) copy[action] = [...(triggers || [])];
  return copy;
}

// Un botón solo hace una cosa: al asignarlo se le quita a cualquier otra acción.
export function assignBinding(bindings, action, trigger) {
  const next = cloneBindings(bindings);
  for (const id of Object.keys(next)) next[id] = next[id].filter((item) => item !== trigger);
  next[action] = [...(next[action] || []), trigger];
  return next;
}

// Reemplaza los botones MIDI de una acción por uno nuevo (las teclas del teclado se conservan).
export function replaceMidiBinding(bindings, action, trigger) {
  const next = cloneBindings(bindings);
  next[action] = (next[action] || []).filter((item) => isKeyTrigger(item));
  return assignBinding(next, action, trigger);
}

export function removeBinding(bindings, action, trigger) {
  const next = cloneBindings(bindings);
  next[action] = (next[action] || []).filter((item) => item !== trigger);
  return next;
}

export function clearSlots(bindings) {
  const next = cloneBindings(bindings);
  for (const id of Object.keys(next)) if (slotNumber(id)) next[id] = [];
  return next;
}

// ---------------------------------------------------------------- teclado

export function keyTrigger(event) {
  const code = event.code && event.code !== 'Unidentified' ? event.code : event.key;
  return code ? `k:${code}` : '';
}

const MODIFIER_KEYS = /^(Shift|Control|Alt|Meta|OS|CapsLock|NumLock|ScrollLock|Fn)/;

export function keyIgnored(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return true;
  const target = event.target;
  if (target && target.tagName) {
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return true;
    if (target.getAttribute && target.getAttribute('role') === 'slider') return true;
  }
  return typeof document !== 'undefined' && Boolean(document.querySelector('.modal-layer'));
}

// ---------------------------------------------------------------- router

export function createRouter({ getBindings, onAction, onValue, onSignal, now } = {}) {
  const detector = createPressDetector({ now });
  let active = false;
  let learning = null;
  let swallow = null; // tecla que acaba de asignarse: su "soltar" no debe pulsar ningún botón
  let cachedFor = null;
  let lookup = new Map();

  const current = () => {
    const bindings = getBindings ? getBindings() : DEFAULT_BINDINGS;
    if (bindings !== cachedFor) {
      cachedFor = bindings;
      lookup = buildLookup(bindings);
    }
    return lookup;
  };

  const finishLearn = (value) => {
    if (!learning) return;
    const done = learning;
    learning = null;
    done.resolve(value);
  };

  const router = {
    get active() {
      return active;
    },
    get learning() {
      return learning ? { continuous: learning.continuous } : null;
    },
    setActive(value) {
      active = Boolean(value);
    },
    // Empieza a escuchar el siguiente botón (o perilla si continuous). Devuelve el disparador o null si se canceló.
    learn({ continuous = false } = {}) {
      finishLearn(null);
      return new Promise((resolve) => {
        learning = { continuous, resolve };
      });
    },
    cancelLearn() {
      finishLearn(null);
    },
    handleMessage(data, source) {
      const message = parseMessage(data);
      if (!message) return;
      const result = detector.feed(message);
      if (onSignal) onSignal({ text: describeMessage(message), message, source });
      if (learning) {
        const trigger = learning.continuous ? result.move && result.move.trigger : result.press;
        if (trigger) finishLearn(trigger);
        return;
      }
      if (!active) return;
      const map = current();
      if (result.press) {
        const action = map.get(result.press);
        if (action && !CONTINUOUS.has(action) && onAction) onAction(action, result.press);
      }
      if (result.move) {
        const action = map.get(result.move.trigger);
        if (action && CONTINUOUS.has(action) && onValue) onValue(action, result.move.position, result.move.trigger);
      }
    },
    // Devuelve true si la tecla se usó (hay que evitar su efecto normal en la página).
    handleKey(event) {
      if (event.type !== 'keydown' && event.type !== undefined) return false;
      if (learning) {
        if (event.key === 'Escape') {
          event.preventDefault();
          swallow = event.code || event.key;
          finishLearn(null);
          return true;
        }
        if (learning.continuous || event.repeat || MODIFIER_KEYS.test(event.code || event.key || '')) return false;
        const trigger = keyTrigger(event);
        if (!trigger) return false;
        event.preventDefault();
        swallow = event.code || event.key;
        finishLearn(trigger);
        return true;
      }
      if (!active || keyIgnored(event)) return false;
      const trigger = keyTrigger(event);
      const action = trigger && current().get(trigger);
      if (!action || CONTINUOUS.has(action)) return false;
      event.preventDefault();
      if (!event.repeat && onAction) onAction(action, trigger);
      return true;
    },
    // Al soltar la tecla: ¿era una tecla del DJ? Hay que cancelar su efecto normal (por ejemplo, la barra
    // espaciadora vuelve a pulsar el botón que tenga el foco al soltarla).
    claimsKey(event) {
      const code = event.code || event.key;
      if (swallow && code === swallow) {
        swallow = null;
        return true;
      }
      if (learning) return true;
      if (!active || keyIgnored(event)) return false;
      const trigger = keyTrigger(event);
      const action = trigger && current().get(trigger);
      return Boolean(action && !CONTINUOUS.has(action));
    },
  };
  return router;
}

// ---------------------------------------------------------------- puertos Web MIDI

export function midiSupported() {
  return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
}

// 'granted' | 'prompt' | 'denied' | null (si el navegador no lo dice)
export async function midiPermission() {
  try {
    if (!navigator.permissions || !navigator.permissions.query) return null;
    const status = await navigator.permissions.query({ name: 'midi' });
    return status.state;
  } catch {
    return null;
  }
}

// Se escucha con addEventListener (y no con onmidimessage) para no pisar el control MIDI que ya usa Escena.
export function createMidiPorts({ onMessage, onChange } = {}) {
  let access = null;
  let status = 'off';
  let names = [];
  const bound = new Map();
  const handler = (event) => {
    if (onMessage) onMessage(event.data, event.target);
  };
  const notify = () => {
    if (onChange) onChange();
  };
  const setStatus = (value) => {
    status = value;
    notify();
  };
  const unbindAll = () => {
    for (const input of bound.values()) input.removeEventListener('midimessage', handler);
    bound.clear();
  };
  const refresh = () => {
    if (!access) return;
    const present = new Map();
    for (const input of access.inputs.values()) present.set(input.id, input);
    for (const [id, input] of Array.from(bound)) {
      if (present.get(id) !== input) {
        input.removeEventListener('midimessage', handler);
        bound.delete(id);
      }
    }
    for (const [id, input] of present) {
      if (bound.has(id)) continue;
      input.addEventListener('midimessage', handler);
      try {
        const opened = input.open && input.open();
        if (opened && opened.catch) opened.catch(() => {});
      } catch {
        // El puerto se abre solo al recibir datos en la mayoría de los navegadores.
      }
      bound.set(id, input);
    }
    names = Array.from(present.values())
      .filter((input) => input.state !== 'disconnected')
      .map((input) => input.name || 'Dispositivo MIDI');
    notify();
  };
  return {
    get status() {
      return status;
    },
    get inputs() {
      return names.slice();
    },
    async enable() {
      if (!midiSupported()) {
        setStatus('unsupported');
        return false;
      }
      if (access) {
        refresh();
        setStatus('ready');
        return true;
      }
      setStatus('asking');
      try {
        access = await navigator.requestMIDIAccess({ sysex: false });
      } catch (error) {
        const name = error && error.name;
        setStatus(name === 'SecurityError' || name === 'NotAllowedError' ? 'denied' : 'error');
        return false;
      }
      access.addEventListener('statechange', refresh);
      refresh();
      setStatus('ready');
      return true;
    },
    disable() {
      unbindAll();
      if (access) access.removeEventListener('statechange', refresh);
      access = null;
      names = [];
      setStatus('off');
    },
  };
}
