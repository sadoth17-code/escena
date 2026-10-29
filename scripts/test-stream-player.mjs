// Integration of the real player, transport, tempo map and generated click/guide.
// The only fakes are the AudioContext, prepared local PCM storage and timers.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test, afterEach } from 'node:test';

const urls = new Map();
async function moduleURL(name) {
  if (urls.has(name)) return urls.get(name);
  let source = await readFile(new URL(`../www/js/${name}`, import.meta.url), 'utf8');
  const dependencies = [...source.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)];
  for (const dependency of dependencies) {
    const replacement = await moduleURL(dependency[1]);
    source = source.replace(dependency[0], `from ${JSON.stringify(replacement)}`);
  }
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  urls.set(name, url);
  return url;
}
const { SongPlayer, endFadeLevel, END_FADES } = await import(await moduleURL('player.js'));

const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;
const timers = new Map();
let nextTimer = 0;
const fixtures = new Set();
function installTimers() {
  globalThis.setInterval = fn => { const id = ++nextTimer; timers.set(id, fn); return id; };
  globalThis.clearInterval = id => timers.delete(id);
}
afterEach(() => {
  for (const fixture of fixtures) {
    for (const player of fixture.players) player.dispose();
    // Rewind detaches a run after scheduling its 12 ms release; let that already
    // authorized future cutoff pass on the fake audio clock as well.
    fixture.advance(fixture.ctx.currentTime + 0.1);
  }
  fixtures.clear();
  const remaining = timers.size;
  timers.clear();
  globalThis.setInterval = nativeSetInterval;
  globalThis.clearInterval = nativeClearInterval;
  assert.equal(remaining, 0, 'disposing all players must release every transport timer');
});

const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function flush() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
// El doble de AudioParam del fixture solo guarda el último valor. Para comprobar fades hace falta ver las
// llamadas de automatización de cada ganancia nueva, con su orden y sus instantes.
function recordGainEvents(f) {
  const create = f.ctx.createGain;
  f.ctx.createGain = function () {
    const node = create.call(this);
    const gain = node.gain;
    gain.events = [];
    for (const name of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'cancelScheduledValues']) {
      const original = gain[name];
      gain[name] = function (...args) { this.events.push({ name, args }); return original.apply(this, args); };
    }
    return node;
  };
}

// Valor de una ganancia en el instante t según sus llamadas de automatización, con las reglas de la Web Audio API
// para las que usa el fade del final (incluida cancelScheduledValues, que borra lo programado desde ese instante).
// Así se comprueba la forma real del fade y no solo los números de las llamadas.
function gainAt(events, t) {
  let active = [];
  for (const event of events) {
    if (event.name === 'cancelScheduledValues') active = active.filter(item => item.args[1] < event.args[0]);
    else active.push(event);
  }
  active.sort((a, b) => a.args[1] - b.args[1]);
  let time = -Infinity;
  let value = 1;
  for (const { name, args: [target, at] } of active) {
    if (name === 'setValueAtTime') {
      if (t < at) return value;
    } else if (t < at) {
      const progress = (t - time) / (at - time);
      return name === 'linearRampToValueAtTime' ? value + (target - value) * progress : value * Math.pow(target / value, progress);
    }
    time = at;
    value = target;
  }
  return value;
}

function fixture() {
  installTimers();
  const nodes = [];
  const createdBuffers = [];
  const players = [];
  function param(value = 1) {
    return { value, setValueAtTime(value) { this.value = value; }, setTargetAtTime(value) { this.value = value; }, linearRampToValueAtTime(value) { this.value = value; }, exponentialRampToValueAtTime(value) { this.value = value; }, cancelScheduledValues() {} };
  }
  function audioNode(extra = {}) {
    return {
      connections: [],
      connect(target) { this.connections.push(target); return target; },
      disconnect(target) { this.connections = target ? this.connections.filter(item => item !== target) : []; },
      ...extra,
    };
  }
  const ctx = {
    currentTime: 0, sampleRate: 1000, baseLatency: 0.02,
    createBuffer(channels, length, rate) {
      assert(Number.isInteger(length) && length > 0);
      const samples = Array.from({ length: channels }, () => new Float32Array(length));
      const buffer = { length, sampleRate: rate, numberOfChannels: channels, duration: length / rate,
        getChannelData(index) { return samples[index]; }, copyToChannel(source, index) { samples[index].set(source); } };
      createdBuffers.push(buffer);
      return buffer;
    },
    createGain() { return audioNode({ gain: param() }); },
    createStereoPanner() { return audioNode({ pan: param(0) }); },
    createAnalyser() { return audioNode({ fftSize: 512, getFloatTimeDomainData(out) { out.fill(0); } }); },
    createBufferSource() {
      const node = audioNode({ stopAt: Infinity, ended: false,
        start(when, offset = 0, duration = this.buffer.duration - offset) {
          assert(this.connections.length, 'native source must be connected before scheduling');
          assert(this.buffer && duration > 0);
          this.when = when; this.offset = offset; this.duration = duration; this.end = when + duration;
        },
        stop(when = ctx.currentTime) { this.stopAt = when; },
      });
      nodes.push(node);
      return node;
    },
  };
  const engine = { ctx, resume: async () => {}, mainStereo: audioNode(), mainMono: audioNode(), cueStereo: audioNode(), cueMono: audioNode() };
  function descriptor(id, duration = 20) {
    const cache = new Map();
    const reads = [];
    const ensures = [];
    const blocked = new Map();
    let trims = 0, disposals = 0, reprocesses = 0;
    function chunk(index) {
      if (index * 2 >= duration) return null;
      const buffer = ctx.createBuffer(2, Math.min(2000, Math.round((duration - index * 2) * 1000)), 1000);
      buffer.testTrack = id; buffer.testChunk = index;
      return buffer;
    }
    cache.set(0, chunk(0));
    const value = {
      stream: true, preparedPitch: true, sampleRate: 1000, chunkSeconds: 2, framesPerChunk: 2000,
      length: Math.round(duration * 1000), duration, playbackDuration: duration, numberOfChannels: 2,
      cache, reads, ensures, blocked,
      peekChunk(index) { return cache.get(index) || null; },
      getChunk(index) {
        if (cache.has(index)) return Promise.resolve(cache.get(index));
        reads.push(index);
        if (blocked.has(index)) return blocked.get(index).promise.then(() => { const buffer = chunk(index); if (buffer) cache.set(index, buffer); return buffer; });
        const buffer = chunk(index); if (buffer) cache.set(index, buffer);
        return Promise.resolve(buffer);
      },
      async ensure(position) { ensures.push(position); await value.getChunk(Math.floor(position / 2)); },
      trimToHead() { trims++; for (const index of cache.keys()) if (index !== 0) cache.delete(index); },
      memoryBytes() { return [...cache.values()].reduce((bytes, buffer) => bytes + buffer.length * buffer.numberOfChannels * 4, 0); },
      dispose() { disposals++; cache.clear(); },
      reprocess() { reprocesses++; throw new Error('Already prepared PCM must not be processed again'); },
      get trims() { return trims; }, get disposals() { return disposals; }, get reprocesses() { return reprocesses; },
    };
    return value;
  }
  function player(id = `song-${players.length}`, lengths = [20, 20], pitch = 0) {
    const definitions = lengths.map((duration, index) => ({ id: `${id}-${index}`, name: `Piano ${index}`, vol: 1, pan: 0, dest: 'main', solo: false, mute: false, pitchEnabled: true }));
    const song = { id, title: id, pitchSemitones: pitch, tempoMap: [{ bar: 1, bpm: 120, num: 4, den: 4 }], offsetMs: 0, markers: [],
      tracks: definitions,
      click: { id: 'click', vol: 1, pan: 0, dest: 'cue', mute: false, solo: false, sound: 'wood', subdivision: 1, countIn: 0 },
      guide: { id: 'guide', vol: 1, pan: 0, dest: 'cue', mute: false, solo: false, leadBars: 1, counting: false },
    };
    const buffers = new Map(definitions.map((def, index) => [def.id, descriptor(def.id, lengths[index])]));
    const duration = Math.max(...lengths);
    for (const buffer of buffers.values()) buffer.playbackDuration = duration;
    const result = new SongPlayer(engine, song, { buffers, voices: new Map() });
    result.testDescriptors = [...buffers.values()];
    players.push(result);
    return result;
  }
  function advance(time) {
    ctx.currentTime = time;
    for (const node of [...nodes]) {
      if (!node.ended && Number.isFinite(node.end) && time >= Math.min(node.end, node.stopAt)) {
        node.ended = true;
        node.onended?.();
      }
    }
    for (const fn of [...timers.values()]) fn();
  }
  const result = { ctx, engine, players, nodes, createdBuffers, player, advance };
  fixtures.add(result);
  return result;
}

test('seven prepared songs start cached heads synchronously without storage reads in the switching task', async () => {
  const f = fixture();
  const songs = Array.from({ length: 7 }, (_, index) => f.player(`mt-${index + 1}`));
  for (const player of songs) {
    assert.equal(player.audioReady(0), true);
    await player.ensureAudio(0);
    assert(player.testDescriptors.every(buffer => buffer.reads.length === 0));
  }
  for (const player of songs) {
    const before = f.nodes.length;
    player.playAt(0.07);
    const heads = f.nodes.slice(before).filter(node => node.buffer.testChunk === 0);
    assert.equal(heads.length, 2);
    assert(heads.every(node => node.when === 0.07 && node.offset === 0));
    assert(player.testDescriptors.every(buffer => buffer.reads.length === 0), 'ahead storage I/O must leave the synchronous switching task');
    player.rewind();
  }
  await flush();
});

test('real file stems, generated click and generated guide share one AudioContext start', async () => {
  const f = fixture();
  const player = f.player();
  await player.play();
  assert.equal(player.state, 'playing');
  const at = player.run.ctxStart;
  const firstChunks = f.nodes.filter(node => node.when === at);
  assert.equal(firstChunks.length, 4);
  assert(firstChunks.every(node => node.offset === 0 && node.connections.length));
  assert(player.testDescriptors.every(buffer => buffer.ensures.length === 0));
  assert(f.createdBuffers.every(buffer => buffer.duration <= 2), 'constructing and starting a song must not create full-duration click/guide buffers');
});

test('pause schedules a common future cutoff and rewind trims every file descriptor back to the head', async () => {
  const f = fixture();
  const player = f.player();
  await player.play();
  await flush();
  const run = player.run;
  f.advance(0.5);
  player.pause();
  assert.equal(player.state, 'paused');
  assert(player.pausedAt > 0);
  for (const entry of run.sources) close(entry.src._stopAt, 0.512);
  player.rewind();
  assert.equal(player.pausedAt, 0);
  assert.equal(player.state, 'stopped');
  assert(player.testDescriptors.every(buffer => buffer.trims === 1 && [...buffer.cache.keys()].join() === '0'));
  f.advance(0.52);
  assert.equal(timers.size, 0);
});

test('a deferred seek keeps the original music running until target blocks are ready, then queues the next bar', async () => {
  const f = fixture();
  const player = f.player();
  await player.play();
  await flush();
  const oldRun = player.run;
  const wait = deferred();
  for (const buffer of player.testDescriptors) buffer.blocked.set(4, wait);
  f.advance(0.5);
  player.seek(8, 'bar');
  assert.equal(player.run, oldRun);
  assert.equal(player.pending, null);
  assert(player.testDescriptors.every(buffer => buffer.ensures.at(-1) === 8));
  f.advance(1.1);
  const positionBefore = player.position();
  assert(positionBefore > 0.9 && positionBefore < 1.1);
  wait.resolve();
  await flush();
  assert.equal(player.run, oldRun);
  assert.equal(player.pending.songStart, 8);
  close(player.pending.ctxStart, 2.07);
  close(player.position(), positionBefore);
  f.advance(player.pending.ctxStart);
  close(player.position(), 8);
});

test('pause cancels an in-flight seek and prevents its late completion from starting new sources', async () => {
  const f = fixture();
  const player = f.player();
  await player.play();
  const wait = deferred();
  for (const buffer of player.testDescriptors) buffer.blocked.set(4, wait);
  f.advance(0.5);
  player.seek(8, 'bar');
  player.pause();
  const before = f.nodes.length;
  wait.resolve();
  await flush();
  assert.equal(player.state, 'paused');
  assert.equal(player.pending, null);
  assert.equal(f.nodes.length, before);
});

test('rapid scene requests only commit the most recently requested target', async () => {
  const f = fixture();
  const player = f.player();
  await player.play();
  const a = deferred(), b = deferred();
  for (const buffer of player.testDescriptors) { buffer.blocked.set(4, a); buffer.blocked.set(6, b); }
  f.advance(0.5);
  player.seek(8, 'bar');
  player.seek(12, 'bar');
  a.resolve();
  await flush();
  assert.equal(player.pending, null);
  b.resolve();
  await flush();
  assert.equal(player.pending.songStart, 12);
});

test('a short streamed stem loops over silent song tail and returns without reading after EOF', async () => {
  const f = fixture();
  const player = f.player('short', [1, 8]);
  player.setLoop({ a: 0, b: 8 });
  await player.play();
  await flush();
  const short = player.testDescriptors[0];
  const source = player.run.sources.find(entry => entry.track.def.id === 'short-0').src;
  assert.equal(source.totalFrames, 8000);
  let native = f.nodes.filter(node => node.buffer.testTrack === 'short-0');
  assert.equal(native.length, 1);
  close(native[0].duration, 1);
  f.advance(7);
  await flush();
  native = f.nodes.filter(node => node.buffer.testTrack === 'short-0');
  assert.equal(native.length, 2);
  close(native[1].when - native[0].when, 8);
  assert.deepEqual(short.reads, []);
});

test('disposing a playing or future-started player clears all stream timers and descriptor storage', async () => {
  const f = fixture();
  const a = f.player('a'), b = f.player('b');
  await a.play();
  b.playAt(10);
  assert.equal(timers.size, 8);
  a.dispose(); b.dispose();
  await flush();
  assert.equal(timers.size, 0);
  for (const player of [a, b]) {
    assert.equal(player.disposed, true);
    assert(player.testDescriptors.every(buffer => buffer.disposals === 1));
  }
  assert(f.nodes.every(node => node.connections.length === 0));
});

test('already prepared pitch survives activation and selecting the same pitch without reprocessing', async () => {
  const f = fixture();
  const player = f.player('prepared', [20, 20], 2);
  // App.prepare records the pitch already committed to the local PCM cache.
  player.pitchSemitones = player.song.pitchSemitones;
  player.syncWithSong();
  await player.setPitch(2);
  assert(player.testDescriptors.every(buffer => buffer.reprocesses === 0));
  await player.play();
  assert(player.testDescriptors.every(buffer => buffer.reprocesses === 0));
  assert.equal(player.pitchSemitones, 2);
});

test('changing pitch preserves the short stem virtual duration and its silence in a song-length loop', async () => {
  const f = fixture();
  const player = f.player('pitched-short', [1, 8]);
  const replacements = [];
  for (const original of player.testDescriptors) {
    original.reprocess = async () => {
      const cache = new Map();
      function chunk(index) {
        if (index * 2 >= original.duration) return null;
        const frames = Math.min(2000, original.length - index * 2000);
        const buffer = f.ctx.createBuffer(2, frames, 1000);
        buffer.testTrack = `pitched-${original.duration}`;
        return buffer;
      }
      cache.set(0, chunk(0));
      const replacement = {
        stream: true, preparedPitch: true, duration: original.duration, length: original.length,
        sampleRate: 1000, numberOfChannels: 2, chunkSeconds: 2, framesPerChunk: 2000,
        playbackDuration: original.duration,
        peekChunk: index => cache.get(index) || null,
        async getChunk(index) { if (!cache.has(index)) cache.set(index, chunk(index)); return cache.get(index); },
        async ensure(position) { await this.getChunk(Math.floor(position / 2)); },
        memoryBytes: () => [...cache.values()].reduce((sum, buffer) => sum + (buffer?.length || 0) * 8, 0),
        dispose() { cache.clear(); },
      };
      replacements.push(replacement);
      return replacement;
    };
  }
  await player.setPitch(3);
  assert.equal(replacements.length, 2);
  assert.equal(player.fileTracks[0].buffer.duration, 1);
  assert.equal(player.fileTracks[0].buffer.playbackDuration, 8);
  player.setLoop({ a: 0, b: 8 });
  await player.play();
  await flush();
  const transport = player.run.sources.find(entry => entry.track.def.id === 'pitched-short-0').src;
  assert.equal(transport.totalFrames, 8000);
  f.advance(7);
  await flush();
  const shortNodes = f.nodes.filter(node => node.buffer.testTrack === 'pitched-1');
  assert.equal(shortNodes.length, 2);
  close(shortNodes[0].duration, 1);
  close(shortNodes[1].when - shortNodes[0].when, 8);
});

test('without a measured tail every source, click and guide included, fades out over the last 50 ms of its own buffer', async () => {
  const f = fixture();
  recordGainEvents(f);
  const player = f.player('tail', [20, 12]);
  await player.play();
  const start = player.run.ctxStart;
  assert.equal(player.run.sources.length, 4);
  for (const entry of player.run.sources) {
    const end = start + entry.duration;
    const events = entry.end.gain.events;
    assert.equal(events.length, 2, `${entry.track.def.id} must get exactly one end fade and nothing else`);
    assert.equal(events[0].name, 'setValueAtTime');
    assert.equal(events[0].args[0], 1);
    close(events[0].args[1], end - 0.05);
    assert.equal(events[1].name, 'linearRampToValueAtTime');
    assert.equal(events[1].args[0], 0);
    close(events[1].args[1], end);
    close(entry.endPlan.start, end - 0.05);
    close(entry.endPlan.end, end);
    assert.equal(entry.endPlan.expEnd, null);
    // The end fade has its own node: the splice fade-in/out node is not involved.
    assert.equal(entry.fade.gain.events.length, 0);
  }
  // The short stem fades at its own end, not at the end of the song.
  assert.deepEqual(player.run.sources.map(entry => entry.duration).sort((a, b) => a - b), [12, 20, 20, 20]);
});

test('a stem that is still sounding when its file ends fades out over the length chosen in Ajustes', async () => {
  const f = fixture();
  recordGainEvents(f);
  const player = f.player('soft', [40, 8]);
  for (const buffer of player.testDescriptors) buffer.tailPeak = 0.5;
  await player.play();
  const start = player.run.ctxStart;
  for (const entry of player.run.sources) {
    const end = start + entry.duration;
    const events = entry.end.gain.events;
    if (entry.track.kind !== 'file') {
      // Generated click and guide have no tail to measure: they keep the short fade.
      assert.equal(events.length, 2);
      close(events[0].args[1], end - 0.05);
      continue;
    }
    // "Suave" is 3 s, but no stem gives more than a quarter of its own length to the fade.
    const length = Math.min(3, entry.duration / 4);
    assert.deepEqual(events.map(event => event.name), ['setValueAtTime', 'exponentialRampToValueAtTime', 'linearRampToValueAtTime']);
    assert.equal(events[0].args[0], 1);
    close(events[0].args[1], end - length);
    assert.equal(events[1].args[0], 0.001);
    close(events[1].args[1], end - 0.02);
    assert.equal(events[2].args[0], 0);
    close(events[2].args[1], end);
    close(entry.endPlan.start, end - length);
    close(entry.endPlan.expEnd, end - 0.02);
  }
  assert.deepEqual(player.run.sources.filter(entry => entry.track.kind === 'file').map(entry => entry.endLength).sort((a, b) => a - b), [2, 3]);
});

test('the length of the end fade follows the setting and how loud the stem still is at the end of its file', () => {
  const f = fixture();
  const player = f.player('lengths', [100, 100]);
  const length = (setting, tailPeak, duration = 100) => { f.engine.endFade = setting; return player.endFadeLength({ tailPeak, duration }); };
  // Without a setting (or with an unknown one) the default is "soft".
  assert.equal(length(undefined, 0.5), END_FADES.soft);
  assert.equal(length('desconocido', 0.5), END_FADES.soft);
  assert.deepEqual([END_FADES.short, END_FADES.soft, END_FADES.long], [0.05, 3, 6]);
  assert.equal(length('short', 0.9), 0.05);
  assert.equal(length('soft', 0.9), 3);
  assert.equal(length('long', 0.9), 6);
  // Loud from −20 dBFS up; quiet below −54 dBFS, or with no measure at all: the short fade.
  assert.equal(length('long', 0.1), 6);
  assert.equal(length('long', 0.002), 0.05);
  assert.equal(length('long', 0.001), 0.05);
  assert.equal(length('long', 0), 0.05);
  assert.equal(length('long', undefined), 0.05);
  assert.equal(length('long', NaN), 0.05);
  assert.equal(player.endFadeLength(null), 0.05);
  // In between it grows with the level in dB: −37 dBFS is about halfway.
  const middle = length('soft', 0.014);
  close(middle, 0.05 + 2.95 * Math.log(0.014 / 0.002) / Math.log(50));
  assert(middle > 1.4 && middle < 1.6);
  assert(length('soft', 0.005) < middle && middle < length('soft', 0.05));
  // A short stem never becomes one big fade.
  assert.equal(length('long', 0.9, 8), 2);
  assert.equal(length('long', 0.9, 0.1), 0.05);
});

test('the scheduled end fade follows the planned curve: exponential down to −60 dB, then a few ms to zero', async () => {
  const f = fixture();
  recordGainEvents(f);
  const player = f.player('curve', [40, 40]);
  for (const buffer of player.testDescriptors) buffer.tailPeak = 0.5;
  await player.play();
  const entry = player.run.sources.find(source => source.track.kind === 'file');
  const events = entry.end.gain.events;
  const { start, end, expEnd } = entry.endPlan;
  close(end - start, 3);
  assert.equal(endFadeLevel(entry.endPlan, start - 1), 1);
  assert.equal(endFadeLevel(entry.endPlan, start), 1);
  close(endFadeLevel(entry.endPlan, expEnd), 0.001);
  assert.equal(endFadeLevel(entry.endPlan, end), 0);
  assert.equal(endFadeLevel(entry.endPlan, end + 5), 0);
  // −30 dB halfway through the exponential part: an even descent for the ear.
  close(endFadeLevel(entry.endPlan, (start + expEnd) / 2), Math.sqrt(0.001));
  // What was handed to the audio clock reproduces the plan, and it never jumps or rises.
  let previous = 1;
  for (let t = start - 0.5; t <= end + 0.5; t += 0.001) {
    const level = gainAt(events, t);
    assert(Math.abs(level - endFadeLevel(entry.endPlan, t)) < 1e-6, `t=${t}: ${level} != ${endFadeLevel(entry.endPlan, t)}`);
    assert(level <= previous + 1e-12, 'the fade never rises');
    assert(previous - level < 0.003 * Math.max(previous, 0.05), `no jump at t=${t}: ${previous} -> ${level}`);
    previous = level;
  }
  // The short plan is a plain linear ramp.
  const short = { start: 10, end: 10.05, expEnd: null };
  close(endFadeLevel(short, 10.025), 0.5);
});

test('a loop has no end fade: arming it brings the volume back and turning it off schedules the fade again', async () => {
  const f = fixture();
  recordGainEvents(f);
  const player = f.player('loop-tail', [20, 20]);
  for (const buffer of player.testDescriptors) buffer.tailPeak = 0.5;
  await player.play();
  const sources = player.run.sources;
  const end = player.run.ctxStart + 20;
  assert(sources.every(entry => entry.endPlan));
  f.advance(1);
  player.setLoop({ a: 2, b: 8 });
  for (const entry of sources) {
    assert.equal(entry.endPlan, null);
    // The fade had not started: it is simply removed and nothing else is written.
    const events = entry.end.gain.events;
    assert.equal(events.at(-1).name, 'cancelScheduledValues');
    assert.equal(gainAt(events, end - 1), 1, 'the volume stays normal where the fade used to be');
  }
  const loopedEvents = sources.map(entry => entry.end.gain.events.length);
  player.setLoop(null);
  sources.forEach((entry, index) => {
    const length = entry.track.kind === 'file' ? 3 : 0.05;
    close(entry.endPlan.start, end - length);
    close(entry.endPlan.end, end);
    const events = entry.end.gain.events.slice(loopedEvents[index]);
    assert.equal(events[0].name, 'setValueAtTime');
    close(events[0].args[1], end - length);
    assert.equal(events.at(-1).name, 'linearRampToValueAtTime');
    close(events.at(-1).args[1], end);
  });
});

test('arming a loop in the middle of the end fade brings the volume back without a jump', async () => {
  const f = fixture();
  recordGainEvents(f);
  const player = f.player('loop-mid-fade', [20, 20]);
  for (const buffer of player.testDescriptors) buffer.tailPeak = 0.5;
  await player.play();
  const sources = player.run.sources.filter(entry => entry.track.kind === 'file');
  const plan = sources[0].endPlan;
  const now = plan.start + 1.5;
  f.advance(now);
  const level = endFadeLevel(plan, now);
  assert(level > 0.01 && level < 0.1);
  player.setLoop({ a: 2, b: 19 });
  for (const entry of sources) {
    assert.equal(entry.endPlan, null);
    const events = entry.end.gain.events;
    assert.deepEqual(events.slice(-3).map(event => event.name), ['cancelScheduledValues', 'setValueAtTime', 'linearRampToValueAtTime']);
    close(events.at(-2).args[0], level);
    close(events.at(-2).args[1], now);
    assert.equal(events.at(-1).args[0], 1);
    close(events.at(-1).args[1], now + 0.02);
  }
  // Disarming it inside the window restarts the fade from the normal volume over what is left.
  f.advance(now + 0.1);
  player.setLoop(null);
  for (const entry of sources) {
    const end = player.run.ctxStart + (20 - player.run.songStart);
    close(entry.endPlan.start, now + 0.1);
    close(entry.endPlan.end, end);
    assert.equal(gainAt(entry.end.gain.events, now + 0.1), 1);
    assert.equal(gainAt(entry.end.gain.events, end), 0);
  }
});

test('a source that starts in a loop gets no end fade', async () => {
  const f = fixture();
  recordGainEvents(f);
  const looping = f.player('looping', [20, 20]);
  for (const buffer of looping.testDescriptors) buffer.tailPeak = 0.5;
  looping.setLoop({ a: 0, b: 8 });
  await looping.play();
  assert(looping.run.sources.every(entry => entry.endPlan === null && entry.end.gain.events.length === 0));
});

test('starting inside the fade window fades over what is left, from the normal volume, and keeps the splice fade-in', async () => {
  const f = fixture();
  recordGainEvents(f);
  const player = f.player('late', [20, 20]);
  for (const buffer of player.testDescriptors) buffer.tailPeak = 0.5;
  player.pausedAt = 18.5;
  await player.play();
  const start = player.run.ctxStart;
  const end = start + 1.5;
  for (const entry of player.run.sources.filter(source => source.track.kind === 'file')) {
    close(entry.endPlan.start, start);
    close(entry.endPlan.end, end);
    close(entry.endPlan.expEnd, end - 0.02);
    const events = entry.end.gain.events;
    assert.deepEqual(events.map(event => event.name), ['setValueAtTime', 'exponentialRampToValueAtTime', 'linearRampToValueAtTime']);
    assert.equal(gainAt(events, start), 1);
    close(gainAt(events, end - 0.02), 0.001);
    assert.equal(gainAt(events, end), 0);
    // The 4 ms fade-in of the start is on the other node and untouched.
    assert.deepEqual(entry.fade.gain.events.map(event => event.name), ['setValueAtTime', 'linearRampToValueAtTime']);
    assert.equal(entry.fade.gain.events[0].args[0], 0);
    assert.equal(entry.fade.gain.events[1].args[0], 1);
  }
});

test('with under 50 ms left nothing is scheduled, not even in the past', async () => {
  const f = fixture();
  recordGainEvents(f);
  const player = f.player('release', [20, 20]);
  await player.play();
  await flush();
  f.advance(1);
  player.seek(19.98, 'now');
  await flush();
  assert(player.pending, 'the jump must be queued');
  assert(player.pending.sources.every(entry => entry.endPlan === null && entry.end.gain.events.length === 0));
});

test('a queued jump into the last seconds gets its fade after its own start, also when the loop is switched around meanwhile', async () => {
  const f = fixture();
  recordGainEvents(f);
  const player = f.player('queued', [30, 30]);
  for (const buffer of player.testDescriptors) buffer.tailPeak = 0.5;
  await player.play();
  await flush();
  f.advance(1);
  player.seek(28, 'bar');
  await flush();
  const pending = player.pending;
  assert(pending && pending.ctxStart > f.ctx.currentTime, 'the jump must be queued for later');
  const files = pending.sources.filter(entry => entry.track.kind === 'file');
  const check = () => {
    for (const entry of files) {
      assert(entry.endPlan, 'the queued run has its fade');
      // A jump starts its sources 3 ms ahead of its first beat (the splice preroll), never earlier than that.
      assert(entry.endPlan.start >= pending.ctxStart - 0.003 - 1e-9, 'never before the queued run starts');
      close(entry.endPlan.end, pending.ctxStart + 2);
      assert(endFadeLevel(entry.endPlan, pending.ctxStart) > 0.98, 'the jump lands at practically the normal volume');
    }
  };
  check();
  player.setLoop({ a: 20, b: 29 });
  assert(files.every(entry => entry.endPlan === null));
  player.setLoop(null);
  check();
});

test('pausing or jumping in the middle of the end fade never touches it: both volumes just multiply', async () => {
  const f = fixture();
  recordGainEvents(f);
  const player = f.player('release-mid-fade', [20, 20]);
  for (const buffer of player.testDescriptors) buffer.tailPeak = 0.5;
  await player.play();
  await flush();
  const run = player.run;
  const now = run.sources[0].endPlan.start + 1.5;
  f.advance(now);
  const before = run.sources.map(entry => entry.end.gain.events.length);
  player.pause();
  run.sources.forEach((entry, index) => {
    assert.equal(entry.end.gain.events.length, before[index], 'the end fade node is left alone');
    assert(entry.endPlan);
    // The splice node carries the 10 ms release, as always.
    const cancel = entry.fade.gain.events.filter(event => event.name === 'cancelScheduledValues').at(-1);
    close(cancel.args[0], now);
    assert.equal(entry.fade.gain.events.at(-1).name, 'linearRampToValueAtTime');
    close(entry.fade.gain.events.at(-1).args[1], now + 0.01);
  });
  // Resuming inside the window starts a new, shorter fade from the normal volume.
  await player.play();
  await flush();
  const resumed = player.run.sources.filter(entry => entry.track.kind === 'file');
  assert(resumed.every(entry => entry.endPlan && entry.endPlan.start >= now && endFadeLevel(entry.endPlan, entry.endPlan.start) === 1));
});

test('changing the setting while a song plays redoes the fades that were already scheduled', async () => {
  const f = fixture();
  recordGainEvents(f);
  const player = f.player('refresh', [100, 100]);
  for (const buffer of player.testDescriptors) buffer.tailPeak = 0.5;
  await player.play();
  const files = player.run.sources.filter(entry => entry.track.kind === 'file');
  const end = player.run.ctxStart + 100;
  assert(files.every(entry => Math.abs(entry.endPlan.start - (end - 3)) < 1e-8));
  f.advance(1);
  f.engine.endFade = 'long';
  player.refreshEndFades();
  for (const entry of files) {
    assert.equal(entry.endLength, 6);
    close(entry.endPlan.start, end - 6);
    close(entry.endPlan.end, end);
    // The old fade is removed first and the new one is the last thing written.
    const events = entry.end.gain.events;
    const cancelAt = events.map(event => event.name).lastIndexOf('cancelScheduledValues');
    assert.deepEqual(events.slice(cancelAt + 1).map(event => event.name), ['setValueAtTime', 'exponentialRampToValueAtTime', 'linearRampToValueAtTime']);
    assert.equal(gainAt(events.slice(cancelAt + 1), end - 6), 1);
  }
  f.engine.endFade = 'short';
  player.refreshEndFades();
  for (const entry of files) {
    assert.equal(entry.endLength, 0.05);
    close(entry.endPlan.start, end - 0.05);
    assert.equal(entry.endPlan.expEnd, null);
  }
  // Inside a loop the fades stay off, but the length is kept up to date for when it ends.
  player.setLoop({ a: 2, b: 8 });
  f.engine.endFade = 'soft';
  player.refreshEndFades();
  assert(files.every(entry => entry.endPlan === null && entry.endLength === 3));
  player.setLoop(null);
  assert(files.every(entry => entry.endPlan && Math.abs(entry.endPlan.start - (end - 3)) < 1e-8));
});

test('the end fade does not disturb the audio graph: every source ends up connected through its own gain nodes and is released when it ends', async () => {
  const f = fixture();
  const player = f.player('graph', [3, 3]);
  await player.play();
  for (const entry of player.run.sources) {
    assert.notEqual(entry.fade, entry.end);
    assert(entry.fade.connections.includes(entry.end));
    assert(entry.end.connections.includes(entry.track.input));
  }
  f.advance(player.run.ctxStart + 4);
  await flush();
  for (const entry of player.run.sources) assert.equal(entry.end.connections.length, 0, 'released with the source');
});

test('changing pitch measures the end of every transposed stem for its fade', async () => {
  const f = fixture();
  const player = f.player('pitch-tail', [20, 20]);
  const measured = [];
  const trimmed = [];
  for (const original of player.testDescriptors) {
    original.reprocess = async () => ({
      stream: true, preparedPitch: true, duration: original.duration, length: original.length,
      sampleRate: 1000, numberOfChannels: 2, chunkSeconds: 2, framesPerChunk: 2000, playbackDuration: original.duration,
      peekChunk: () => null, async getChunk() { return null; }, async ensure() {}, memoryBytes: () => 0, dispose() {},
      async measureTail() { measured.push(this); this.tailPeak = 0.25; return 0.25; },
      trimToHead() { trimmed.push(this); },
    });
  }
  await player.setPitch(2);
  assert.equal(measured.length, 2);
  assert.deepEqual(trimmed, measured, 'the measured block is not kept in memory');
  assert(player.fileTracks.every(track => track.buffer.tailPeak === 0.25));
  const entries = player.prepareSources(0, null);
  assert.deepEqual(entries.filter(entry => entry.track.kind === 'file').map(entry => entry.endLength), [3, 3]);
  // Going back to the original keeps what was measured for it; nothing is read again.
  await player.setPitch(2);
  assert.equal(measured.length, 2);
});

// Descriptores con lectura de fondo: bloques de 2 s, el primero ya leído al preparar la canción.
function scannable(player, calls, blocks = new Map()) {
  player.testDescriptors.forEach((buffer, track) => {
    const read = new Set([0]);
    buffer.chunkCount = Math.ceil(buffer.duration / 2);
    buffer.peaksComplete = false;
    buffer.scanChunk = async index => {
      if (index >= buffer.chunkCount || read.has(index)) return false;
      calls.push([track, index]);
      if (blocks.has(index)) await blocks.get(index).promise;
      read.add(index);
      return true;
    };
  });
}

test('warmWaveform reads the missing blocks of every main track in rounds, one at a time, and redraws when done', async () => {
  const f = fixture();
  const player = f.player('warm', [8, 6]);
  const calls = [];
  scannable(player, calls);
  player.fileTracks[1].def.dest = 'cue'; // a cue-only track is not part of the drawing
  const revision = player.waveRevision;
  await player.warmWaveform({ delay: 0 });
  assert.deepEqual(calls, [[0, 1], [0, 2], [0, 3]]);
  assert(player.waveRevision > revision);
  assert.equal(player.warmPromise, null);
  // Both main tracks: interleaved by block so the drawing fills evenly from left to right.
  player.fileTracks[1].def.dest = 'main';
  const again = f.player('warm-2', [8, 6]);
  const order = [];
  scannable(again, order);
  await again.warmWaveform({ delay: 0 });
  assert.deepEqual(order, [[0, 1], [1, 1], [0, 2], [1, 2], [0, 3]]);
});

test('warmWaveform skips finished tracks, is shared by concurrent callers and never rejects', async () => {
  const f = fixture();
  const player = f.player('warm-skip', [8, 8]);
  const calls = [];
  scannable(player, calls);
  player.testDescriptors[0].peaksComplete = true;
  const first = player.warmWaveform({ delay: 0 });
  assert.equal(player.warmWaveform({ delay: 0 }), first, 'one scan at a time');
  await first;
  assert.deepEqual(calls.map(([track]) => track), [1, 1, 1]);
  // A read error ends the scan quietly and leaves the drawing as it was.
  const broken = f.player('warm-broken', [8, 8]);
  scannable(broken, []);
  broken.testDescriptors[1].scanChunk = async () => { throw new Error('disco lleno'); };
  await broken.warmWaveform({ delay: 0 });
  assert.equal(broken.warmPromise, null);
  // Players without the ability (generated audio, legacy buffers) simply have nothing to do.
  await f.player('warm-none', [8, 8]).warmWaveform({ delay: 0 });
});

test('warmWaveform stops when the song leaves the stage and resumes from where it was when it returns', async () => {
  const f = fixture();
  const player = f.player('warm-leave', [8, 8]);
  const calls = [];
  const gate = deferred();
  scannable(player, calls, new Map([[2, gate]]));
  const scan = player.warmWaveform({ delay: 0 });
  // The scan hands the thread back between blocks (a real macrotask), so wait for it to get to the gate.
  for (let turns = 0; turns < 200 && calls.length < 3; turns++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(calls, [[0, 1], [1, 1], [0, 2]], 'waiting on block 2 of the first track');
  player.rewind();
  assert.equal(player.warmPromise, null, 'a new scan can start right away');
  gate.resolve();
  await scan;
  assert.deepEqual(calls, [[0, 1], [1, 1], [0, 2]], 'nothing more is read after leaving');
  await player.warmWaveform({ delay: 0 });
  assert.deepEqual(calls.slice(3), [[1, 2], [0, 3], [1, 3]], 'continues with what is missing');
  // Disposing also stops it.
  const gone = f.player('warm-gone', [8, 8]);
  const goneCalls = [];
  scannable(gone, goneCalls);
  const pending = gone.warmWaveform({ delay: 20 });
  gone.dispose();
  await pending;
  assert.deepEqual(goneCalls, []);
});

test('warmWaveform waits longer between blocks while the song plays, so playback comes first', async () => {
  const f = fixture();
  const player = f.player('warm-playing', [8, 8]);
  scannable(player, []);
  const real = globalThis.setTimeout;
  const waits = [];
  globalThis.setTimeout = (fn, ms) => { waits.push(ms); return real(fn, 0); };
  try {
    await player.warmWaveform({ delay: 0 });
    assert.deepEqual(waits, [], 'stopped: it only yields the thread');
    const playing = f.player('warm-playing-2', [8, 8]);
    scannable(playing, []);
    playing.state = 'playing';
    await playing.warmWaveform({ delay: 0 });
    assert(waits.length >= 6 && waits.every(ms => ms >= 14), `waits while playing: ${waits}`);
    playing.state = 'stopped';
  } finally {
    globalThis.setTimeout = real;
  }
});

test('changing pitch restarts the background drawing for the new buffers', async () => {
  const f = fixture();
  const player = f.player('warm-pitch', [20, 20]);
  const calls = [];
  scannable(player, calls);
  for (const original of player.testDescriptors) original.reprocess = async () => original;
  player.warmWaveform({ delay: 0 });
  const before = player.warmPromise;
  await player.setPitch(2);
  assert(player.warmPromise && player.warmPromise !== before, 'a fresh scan for the new epoch');
});

test('rewind cancels deferred waveform reading without further chunks or restoring its stale promise', async () => {
  const f = fixture();
  const player = f.player('wave', [20, 20]);
  const buffer = player.testDescriptors[0];
  const read = buffer.getChunk.bind(buffer);
  const requested = [];
  const wait = deferred();
  buffer.getChunk = index => { requested.push(index); return wait.promise.then(() => read(index)); };
  const waveform = player.prepareWaveform();
  assert.equal(player.wavePromise, waveform);
  assert.deepEqual(requested, [0]);
  player.rewind();
  assert.equal(player.wavePromise, null);
  assert.equal(player.waveKey, '');
  wait.resolve();
  assert.equal(await waveform, null);
  await flush();
  assert.deepEqual(requested, [0]);
  assert.equal(player.testDescriptors[1].reads.length, 0);
  assert.equal(player.wavePromise, null);
});
