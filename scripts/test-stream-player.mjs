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
const { SongPlayer } = await import(await moduleURL('player.js'));

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
    for (const name of ['setValueAtTime', 'linearRampToValueAtTime', 'cancelScheduledValues']) {
      const original = gain[name];
      gain[name] = function (...args) { this.events.push({ name, args }); return original.apply(this, args); };
    }
    return node;
  };
}

function fixture() {
  installTimers();
  const nodes = [];
  const createdBuffers = [];
  const players = [];
  function param(value = 1) {
    return { value, setValueAtTime(value) { this.value = value; }, setTargetAtTime(value) { this.value = value; }, linearRampToValueAtTime(value) { this.value = value; }, cancelScheduledValues() {} };
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

test('every source, click and guide included, fades out over the last 50 ms of its own buffer', async () => {
  const f = fixture();
  recordGainEvents(f);
  const player = f.player('tail', [20, 12]);
  await player.play();
  const start = player.run.ctxStart;
  assert.equal(player.run.sources.length, 4);
  for (const entry of player.run.sources) {
    const end = start + entry.duration;
    const events = entry.fade.gain.events;
    assert.equal(events.length, 2, `${entry.track.def.id} must get exactly one end fade and nothing else`);
    assert.equal(events[0].name, 'setValueAtTime');
    assert.equal(events[0].args[0], 1);
    close(events[0].args[1], end - 0.05);
    assert.equal(events[1].name, 'linearRampToValueAtTime');
    assert.equal(events[1].args[0], 0);
    close(events[1].args[1], end);
  }
  // The short stem fades at its own end, not at the end of the song.
  assert.deepEqual(player.run.sources.map(entry => entry.duration).sort((a, b) => a - b), [12, 20, 20, 20]);
});

test('a loop has no end fade: arming it cancels the fade and turning it off schedules it again', async () => {
  const f = fixture();
  recordGainEvents(f);
  const player = f.player('loop-tail', [20, 20]);
  await player.play();
  const sources = player.run.sources;
  const end = player.run.ctxStart + 20;
  assert(sources.every(entry => entry.endFadeAt != null));
  f.advance(1);
  player.setLoop({ a: 2, b: 8 });
  for (const entry of sources) {
    assert.equal(entry.endFadeAt, null);
    // Only the fade itself is removed, never anything scheduled before it.
    const cancel = entry.fade.gain.events.filter(event => event.name === 'cancelScheduledValues').at(-1);
    close(cancel.args[0], end - 0.05);
  }
  player.setLoop(null);
  for (const entry of sources) {
    close(entry.endFadeAt, end - 0.05);
    const events = entry.fade.gain.events;
    assert.equal(events.at(-2).name, 'setValueAtTime');
    close(events.at(-2).args[1], end - 0.05);
    assert.equal(events.at(-1).name, 'linearRampToValueAtTime');
    assert.equal(events.at(-1).args[0], 0);
    close(events.at(-1).args[1], end);
  }
});

test('a source that starts in a loop gets no end fade, and pause or a jump to the last milliseconds never leave a stale one', async () => {
  const f = fixture();
  recordGainEvents(f);
  const looping = f.player('looping', [20, 20]);
  looping.setLoop({ a: 0, b: 8 });
  await looping.play();
  assert(looping.run.sources.every(entry => entry.endFadeAt === null && entry.fade.gain.events.length === 0));

  const player = f.player('release', [20, 20]);
  await player.play();
  await flush();
  const run = player.run;
  assert(run.sources.every(entry => entry.endFadeAt != null));
  f.advance(0.5);
  player.pause();
  for (const entry of run.sources) {
    assert.equal(entry.endFadeAt, null);
    const cancel = entry.fade.gain.events.filter(event => event.name === 'cancelScheduledValues').at(-1);
    close(cancel.args[0], 0.5);
  }
  await player.play();
  await flush();
  f.advance(1);
  player.seek(19.98, 'now');
  await flush();
  assert(player.pending, 'the jump must be queued');
  // Less than 50 ms left: there is no room for the fade and nothing may be scheduled in the past.
  assert(player.pending.sources.every(entry => entry.endFadeAt === null));
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
