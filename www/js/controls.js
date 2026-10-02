import { app } from './app.js';
import { createEmitter } from './util.js';

export const ACTIONS = [
  { id: 'playPause', name: 'Reproducir / pausa' },
  { id: 'stop', name: 'Detener' },
  { id: 'nextSection', name: 'Sección siguiente' },
  { id: 'prevSection', name: 'Sección anterior' },
  { id: 'nextSong', name: 'Canción siguiente' },
  { id: 'prevSong', name: 'Canción anterior' },
  { id: 'toggleClick', name: 'Click sí / no' },
  { id: 'toggleGuide', name: 'Guía sí / no' },
  { id: 'toggleLoop', name: 'Repetir sección' },
];

export const DEFAULT_BINDINGS = {
  playPause: ['k:Space'],
  stop: ['k:Escape'],
  nextSection: ['k:ArrowRight'],
  prevSection: ['k:ArrowLeft'],
  nextSong: ['k:PageDown', 'k:ArrowDown'],
  prevSong: ['k:PageUp', 'k:ArrowUp'],
  toggleClick: ['k:KeyC'],
  toggleGuide: ['k:KeyG'],
  toggleLoop: ['k:KeyL'],
};

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
  MediaPlayPause: 'Medios: reproducir',
  MediaTrackNext: 'Medios: siguiente',
  MediaTrackPrevious: 'Medios: anterior',
  MediaStop: 'Medios: detener',
};

const NOTE_NAMES = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];

const bus = createEmitter();

const midi = {
  status: 'off',
  inputs: [],
  access: null,
  last: new Map(),
};

let learning = null;
let lookup = new Map();

function currentBindings() {
  return app.settings.bindings || DEFAULT_BINDINGS;
}

function rebuild() {
  lookup = new Map();
  for (const [action, triggers] of Object.entries(currentBindings())) {
    for (const trigger of triggers) if (!lookup.has(trigger)) lookup.set(trigger, action);
  }
}

function keyTrigger(event) {
  const code = event.code && event.code !== 'Unidentified' ? event.code : event.key;
  return code ? `k:${code}` : '';
}

function typing(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable || target.getAttribute('role') === 'slider';
}

function fire(trigger) {
  if (learning) {
    const done = learning;
    learning = null;
    done(trigger);
    return true;
  }
  const action = lookup.get(trigger);
  if (!action) return false;
  bus.emit('trigger', action, trigger);
  app.runAction(action);
  return true;
}

function onKeyDown(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const trigger = keyTrigger(event);
  if (!trigger) return;
  if (learning) {
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) fire(trigger);
    return;
  }
  if (typing(event.target) || document.querySelector('.modal-layer')) return;
  if (!lookup.has(trigger)) return;
  event.preventDefault();
  if (!event.repeat) fire(trigger);
}

function onKeyUp(event) {
  if (learning || typing(event.target) || document.querySelector('.modal-layer')) return;
  if (lookup.has(keyTrigger(event))) event.preventDefault();
}

function onMidi(message) {
  const [status, first, second] = message.data;
  const type = status & 0xf0;
  if (type === 0x90 && second > 0) {
    fire(`m:note:${first}`);
  } else if (type === 0xb0) {
    const key = `${status & 0x0f}:${first}`;
    const previous = midi.last.get(key) || { value: 0, time: 0 };
    const now = performance.now();
    midi.last.set(key, { value: second, time: now });
    if (second >= 64 && (previous.value < 64 || (second === previous.value && now - previous.time > 400))) fire(`m:cc:${first}`);
  } else if (type === 0xc0 && app.settings.midiProgramChange && !learning) {
    app.goToSetlistIndex(first);
  }
}

function attachInputs() {
  if (!midi.access) return;
  midi.inputs = [];
  for (const input of midi.access.inputs.values()) {
    input.onmidimessage = onMidi;
    midi.inputs.push(input.name || 'Dispositivo MIDI');
  }
  bus.emit('midi');
}

export const controls = {
  on: bus.on,
  midi,
  get learning() {
    return Boolean(learning);
  },
  init() {
    rebuild();
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    app.on('settings', (key) => {
      if (key === 'bindings') rebuild();
    });
    if (app.settings.midiEnabled) this.enableMidi();
  },
  async enableMidi() {
    if (midi.access) {
      attachInputs();
      return;
    }
    if (!navigator.requestMIDIAccess) {
      midi.status = 'unsupported';
      bus.emit('midi');
      return;
    }
    try {
      midi.access = await navigator.requestMIDIAccess({ sysex: false });
      midi.status = 'ready';
      midi.access.onstatechange = attachInputs;
      attachInputs();
    } catch (error) {
      midi.status = 'denied';
      bus.emit('midi');
    }
  },
  disableMidi() {
    if (midi.access) for (const input of midi.access.inputs.values()) input.onmidimessage = null;
    midi.access = null;
    midi.status = 'off';
    midi.inputs = [];
    bus.emit('midi');
  },
  bindings() {
    return currentBindings();
  },
  triggersFor(action) {
    return currentBindings()[action] || [];
  },
  learn() {
    if (learning) learning(null);
    return new Promise((resolve) => {
      learning = (trigger) => {
        learning = null;
        bus.emit('learn', false);
        resolve(trigger);
      };
      bus.emit('learn', true);
    });
  },
  cancelLearn() {
    if (learning) learning(null);
  },
  assign(action, trigger) {
    const next = {};
    for (const [id, triggers] of Object.entries(currentBindings())) next[id] = triggers.filter((item) => item !== trigger);
    next[action] = [...(next[action] || []), trigger];
    app.setSetting('bindings', next);
  },
  unassign(action, trigger) {
    const next = {};
    for (const [id, triggers] of Object.entries(currentBindings())) next[id] = [...triggers];
    next[action] = (next[action] || []).filter((item) => item !== trigger);
    app.setSetting('bindings', next);
  },
  reset() {
    app.setSetting('bindings', null);
  },
  label(trigger) {
    const [kind, ...rest] = trigger.split(':');
    if (kind === 'k') {
      const code = rest.join(':');
      if (KEY_NAMES[code]) return KEY_NAMES[code];
      if (/^Key[A-Z]$/.test(code)) return code.slice(3);
      if (/^Digit\d$/.test(code)) return code.slice(5);
      if (/^Numpad/.test(code)) return `Num ${code.slice(6)}`;
      return code.length === 1 ? code.toUpperCase() : code;
    }
    if (kind === 'm') {
      const [type, value] = rest;
      if (type === 'note') {
        const note = Number(value);
        return `MIDI nota ${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
      }
      return `MIDI pedal CC ${value}`;
    }
    return trigger;
  },
};
