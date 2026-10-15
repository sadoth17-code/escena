// Run with: node scripts/test-song-switch.mjs
// The real App module runs with a fake audio engine/local store: no network, timers or audio device.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import vm from 'node:vm';

if (!vm.SourceTextModule) {
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(child.status ?? 1);
}

const emitter = () => {
  const handlers = new Map();
  return {
    on(name, fn) {
      const listeners = handlers.get(name) || new Set();
      handlers.set(name, listeners);
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(name, ...args) { for (const fn of handlers.get(name) || []) fn(...args); },
  };
};
const store = { setMeta: async () => {}, getMany: async () => [] };
// Replace storage streaming only; every test below still runs the real App.prepare.
// The default emulates opening a locally prepared two-second head through the fake engine.
let fakeDiskAudio = async (engine, blob, options = {}) => {
  const head = await engine.decode(blob, { cancelled: options.cancelled });
  return {
    ...head, stream: true, preparedPitch: true,
    memoryBytes: () => Math.ceil(Math.min(2, head.duration) * engine.ctx.sampleRate) * head.numberOfChannels * 4,
  };
};
const context = vm.createContext({
  navigator: { userAgent: 'Android', deviceMemory: 4, hardwareConcurrency: 4 },
  AbortController, console,
});
const stubs = {
  './util.js': { createEmitter: emitter, debounce: fn => fn, isIOS: () => false, clamp: (n, lo, hi) => Math.min(hi, Math.max(lo, n)) },
  './store.js': { store },
  './audio-info.js': { readAudioInfo: async () => null },
  './disk-audio.js': { DISK_CHUNK_SECONDS: 2, createDiskAudio: (...args) => fakeDiskAudio(...args) },
  './engine.js': { Engine: class {}, DEFAULT_OUTPUT: { routes: {} }, normalizeRoutes: routes => routes || {} },
  './library.js': { normalizeSong: song => song, serializableSong: song => song, createSong() {}, createTrackDef() {}, createSetlist() {} },
  './tempo.js': { normalizeTempoEntries() {}, detectTempoFromBuffer() {} },
  './synth.js': { renderPreview() {}, isSampleSound: () => false },
  './voices.js': { DEFAULT_GUIDE_LANG: 'es', isGuideLanguage: () => true, guideLanguageName: lang => lang },
  './pitch-utils.js': { normalizePitch: pitch => Number(pitch) || 0, pitchLabel() {}, keyPitchClass() {}, defaultPitchEnabled: () => false },
  './pad.js': { AmbientPad: class {}, normalizePadStyle: style => style },
  './access.js': { access: { canEdit: false } },
};
const source = await readFile(new URL('../www/js/app.js', import.meta.url), 'utf8');
const module = new vm.SourceTextModule(source, { context, identifier: 'app.js' });
await module.link(specifier => {
  assert.ok(stubs[specifier], `Unexpected dependency: ${specifier}`);
  const values = stubs[specifier];
  return new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value);
  }, { context });
});
await module.evaluate();
const App = module.namespace.app.constructor;
const MB = 1048576;
const fixtures = new Set();

afterEach(() => {
  for (const app of fixtures) {
    app.settings.preloadNext = false;
    for (const job of Array.from(app.jobs.values())) app.cancelJob(job);
    app.discardWarm();
    app.unloadCurrent();
  }
  fixtures.clear();
});

function song(id, bytes = 10 * MB) {
  return {
    id, title: id, testBytes: bytes, pitchSemitones: 0,
    tracks: [{ id: `${id}-track`, fileId: `${id}-file`, mono: false, pitchEnabled: false, name: id }],
    click: { sound: 'wood', solo: false }, guide: { solo: false },
  };
}

function entry(song, bytes = song.testBytes) {
  return {
    song, bytes, failed: [], signature: `0|${song.id}-track:${song.id}-file:0:0`,
    player: {
      state: 'stopped', disposed: false, rewinds: 0, playRequest: 0, playOptions: [], liveBytes: bytes,
      async play(options) { this.playOptions.push(options); this.state = 'playing'; },
      rewind() { this.rewinds++; this.playRequest++; this.state = 'stopped'; },
      pause() { this.playRequest++; if (this.state === 'playing') this.state = 'paused'; },
      stop() { this.playRequest++; this.state = 'stopped'; },
      dispose() { this.disposed = true; },
      syncWithSong() {}, memoryBytes() { return this.liveBytes; },
    },
  };
}

function fixture(ids = ['a', 'b', 'c', 'd', 'e'], budgetMB = 100) {
  const app = new App();
  app.sessionAllowed = true;
  fixtures.add(app);
  app.settings.warmBudgetMB = budgetMB;
  app.activeSetlistId = 'set';
  app.setlists = [{ id: 'set', songIds: ids }];
  app.songs = new Map(ids.map(id => [id, song(id)]));
  app.engine = { ctx: { sampleRate: 48000 }, voiceBanks: new Map() };
  app.estimateBytes = song => song.testBytes;
  app.hasAudioInfo = () => true;
  app.inspectSong = async () => {};
  app.prepared = [];
  app.prepare = async song => { app.prepared.push(song.id); return entry(song); };
  return app;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('a locked session cannot start audio, prepare songs or reactivate through MIDI actions', async () => {
  const app = fixture(['a', 'b']);
  app.current = entry(app.songs.get('a'));
  let plays = 0, inspections = 0;
  app.current.player.play = async () => { plays++; };
  app.hasAudioInfo = () => false;
  app.inspectSong = async () => { inspections++; };
  app.sessionAllowed = false;
  app.warmUp();
  app.runAction('nextSong');
  await app.loadSong('b', { autoplay: true });
  await app.play();
  assert.equal(plays, 0);
  assert.equal(app.current.song.id, 'a');
  assert.equal(app.jobs.size, 0);
  assert.equal(app.prepared.length, 0);
  assert.equal(inspections, 0);
});

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Background preparation did not settle');
}

test('automatically prepares the whole fitting setlist before any song is opened', async () => {
  const app = fixture();
  app.warmUp();
  await waitUntil(() => app.preparationStatus().complete);
  assert.deepEqual(app.prepared, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(app.current, null);
  assert.ok(app.memoryUsed() <= app.warmBudget());
});

test('automatic preparation includes local library songs after the active setlist', async () => {
  const app = fixture(['a', 'b']);
  app.songs.set('c', song('c'));
  app.songs.set('d', song('d'));
  app.warmUp();
  await waitUntil(() => [...app.songs.keys()].every(id => app.isReady(id)) && !app.jobs.size);
  assert.deepEqual(app.prepared, ['a', 'b', 'c', 'd']);
  assert.equal(app.preparationStatus().ready, 2);
  assert.equal(app.preparationStatus().total, 2);
  assert.ok(app.memoryUsed() <= app.warmBudget());
});

test('library candidates cannot evict already prepared songs when memory is full', async () => {
  const app = fixture(['a', 'b'], 30);
  app.songs.set('c', song('c'));
  app.warmUp();
  await waitUntil(() => ['a', 'b', 'c'].every(id => app.isReady(id)) && !app.jobs.size);
  const retained = [...app.warm.values()];
  app.songs.set('d', song('d'));
  for (let attempt = 0; attempt < 5; attempt++) {
    app.warmUp();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(app.prepared, ['a', 'b', 'c']);
  assert.equal(app.jobs.size, 0);
  assert.equal(app.isReady('d'), false);
  assert.ok(retained.every(item => !item.player.disposed));
  assert.ok(['a', 'b', 'c'].every(id => app.isReady(id)));
});

test('opportunistic setlist preparation preserves the last visited library song for immediate return', async () => {
  const app = fixture(['a', 'b', 'd'], 30);
  app.songs.set('c', song('c'));
  app.current = entry(app.songs.get('a'));
  const previous = entry(app.songs.get('c'));
  app.addWarm(entry(app.songs.get('b')));
  app.addWarm(previous);
  app.lastVisitedId = 'c';
  app.warmUp();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(previous.player.disposed, false);
  assert.equal(app.isReady('c'), true);
  assert.equal(app.isReady('d'), false);
  const events = [];
  app.on('loading', state => events.push(state));
  const outward = app.loadSong('c');
  assert.equal(app.current.song.id, 'c');
  await outward;
  const returning = app.loadSong('a');
  assert.equal(app.current.song.id, 'a');
  await returning;
  assert.deepEqual(app.prepared, []);
  assert.deepEqual(events, []);
  assert.equal(previous.player.disposed, false);
});

test('RAM estimates reserve two-second heads using original mono channels', () => {
  const app = fixture(['a']);
  const original = app.songs.get('a');
  original.tracks = Array.from({ length: 8 }, (_, index) => ({
    id: `mono-${index}`, fileId: `mono-file-${index}`, mono: false,
  }));
  app.audioInfo = new Map(original.tracks.map(track => [track.fileId, { channels: 1, duration: 120 }]));
  const expectedBytes = 2 * 48000 * 4 * (8 + 2);
  assert.equal(App.prototype.estimateBytes.call(app, original), expectedBytes);
  // The duration of the song does not reserve a full-song AudioBuffer in RAM.
  for (const info of app.audioInfo.values()) info.duration = 300;
  assert.equal(App.prototype.estimateBytes.call(app, original), expectedBytes);
});

test('RAM estimates still account for stereo stems and explicit downmixing', () => {
  const app = fixture(['a']);
  const original = app.songs.get('a');
  original.tracks = Array.from({ length: 8 }, (_, index) => ({
    id: `stereo-${index}`, fileId: `stereo-file-${index}`, mono: false, duration: 120,
  }));
  app.audioInfo = new Map(original.tracks.map(track => [track.fileId, { channels: 2, duration: 120 }]));
  assert.equal(App.prototype.estimateBytes.call(app, original), 2 * 48000 * 4 * (16 + 2));
  for (const track of original.tracks) track.mono = true;
  assert.equal(App.prototype.estimateBytes.call(app, original), 2 * 48000 * 4 * (8 + 2));
});

test('pitch memory estimates keep only the prepared heads rather than full originals', () => {
  const app = fixture(['a']);
  const original = app.songs.get('a');
  original.pitchSemitones = 2;
  original.tracks = Array.from({ length: 8 }, (_, index) => ({
    id: `pitch-${index}`, fileId: `pitch-file-${index}`, mono: false, pitchEnabled: index < 4,
  }));
  app.audioInfo = new Map(original.tracks.map(track => [track.fileId, { channels: 1, duration: 120 }]));
  // Retuned audio lives in persistent chunks; eight heads plus click and guide stay in RAM.
  assert.equal(App.prototype.estimateBytes.call(app, original), 2 * 48000 * 4 * (8 + 2));
  for (const track of original.tracks) track.pitchEnabled = false;
  assert.equal(App.prototype.estimateBytes.call(app, original), 2 * 48000 * 4 * (8 + 2));
});

test('RAM accounting follows streamed block allocation and release after preparation', () => {
  const app = fixture(['a', 'b']);
  app.current = entry(app.songs.get('a'));
  app.addWarm(entry(app.songs.get('b')));
  assert.equal(app.memoryUsed(), 20 * MB);
  app.current.player.liveBytes = 15 * MB;
  app.warm.get('b').player.liveBytes = 3 * MB;
  assert.equal(app.memoryUsed(), 18 * MB);
  // Snapshot costs deliberately stay stale: live player accounting must take priority.
  assert.equal(app.current.bytes, 10 * MB);
  assert.equal(app.warm.get('b').bytes, 10 * MB);
});

test('audio header inspection reads each local file once even when its format is unknown', async () => {
  const app = fixture(['a']);
  const original = app.songs.get('a');
  const reads = [];
  const previousGetMany = store.getMany;
  app.audioInfo = new Map();
  app.inspectSong = App.prototype.inspectSong;
  app.hasAudioInfo = App.prototype.hasAudioInfo;
  store.getMany = async (name, ids) => {
    assert.equal(name, 'files');
    reads.push(...ids);
    return ids.map(id => ({ blob: { id } }));
  };
  try {
    assert.equal(app.hasAudioInfo(original), false);
    await app.inspectSong(original);
    assert.equal(app.hasAudioInfo(original), true);
    assert.equal(app.audioInfo.get('a-file'), null);
    await app.inspectSong(original);
    assert.deepEqual(reads, ['a-file']);
    original.tracks.push({ id: 'extra-track', fileId: 'extra-file' });
    await app.inspectSong(original);
    assert.deepEqual(reads, ['a-file', 'extra-file']);
  } finally {
    store.getMany = previousGetMany;
  }
});

test('prioritizes neighbors and prepares arbitrary later selections without manual preparation', async () => {
  const app = fixture();
  app.current = entry(app.songs.get('b'));
  app.warmUp();
  await waitUntil(() => app.preparationStatus().complete);
  assert.deepEqual(app.prepared, ['c', 'a', 'd', 'e']);
  const events = [];
  app.on('loading', state => events.push(['loading', state]));
  app.on('song:unloaded', state => events.push(['unloaded', state]));
  await app.loadSong('e');
  assert.equal(app.current.song.id, 'e');
  assert.equal(app.current.switching, true);
  assert.deepEqual(events, []);
  assert.equal(app.prepared.filter(id => id === 'e').length, 1);
  assert.ok(app.isReady('b'));
});

test('a ready selection preserves useful background decoding instead of restarting it', async () => {
  const app = fixture(['a', 'b', 'c']);
  app.current = entry(app.songs.get('a'));
  app.addWarm(entry(app.songs.get('c')));
  const pending = deferred();
  app.prepare = () => pending.promise;
  const job = app.startJob(app.songs.get('b'));
  await app.loadSong('c');
  assert.equal(job.cancelled, false);
  assert.equal(app.jobs.get('b'), job);
  pending.resolve(entry(app.songs.get('b')));
  await job.promise;
  assert.ok(app.isReady('b'));
});

test('cold selection keeps the current player until commit when both songs fit', async () => {
  const app = fixture(['a', 'b']);
  const old = entry(app.songs.get('a'));
  old.player.state = 'playing';
  app.current = old;
  const pending = deferred();
  app.prepare = () => pending.promise;
  const unloaded = [];
  app.on('song:unloaded', info => unloaded.push(info));
  const loading = app.loadSong('b');
  assert.equal(app.current, old);
  assert.equal(old.player.disposed, false);
  assert.equal(old.player.rewinds, 0);
  assert.equal(app.loading.switching, true);
  app.jobs.get('b').onProgress(1, 1, 'Bajo');
  assert.equal(app.loading.switching, true);
  pending.resolve(entry(app.songs.get('b')));
  await loading;
  assert.equal(app.current.song.id, 'b');
  assert.equal(app.current.switching, true);
  assert.equal(old.player.rewinds, 1);
  assert.equal(app.loading, null);
  assert.deepEqual(unloaded, []);
});

test('a failed cold selection preserves the current song and clears its loading state', async () => {
  const app = fixture(['a', 'b']);
  app.settings.preloadNext = false;
  const old = entry(app.songs.get('a'));
  app.current = old;
  app.prepare = async () => { throw new Error('Archivo dañado'); };
  const errors = [];
  app.on('toast', toast => errors.push(toast.message));
  await app.loadSong('b');
  assert.equal(app.current, old);
  assert.equal(old.player.disposed, false);
  assert.equal(app.loading, null);
  assert.deepEqual(errors, ['Archivo dañado']);
});

test('returning to the current song cancels an older pending selection', async () => {
  const app = fixture(['a', 'b']);
  app.settings.preloadNext = false;
  const old = entry(app.songs.get('a'));
  app.current = old;
  const pending = deferred();
  app.prepare = () => pending.promise;
  const staleLoad = app.loadSong('b');
  const job = app.jobs.get('b');
  await app.loadSong('a');
  assert.equal(job.cancelled, true);
  assert.equal(app.loading, null);
  const stale = entry(app.songs.get('b'));
  pending.resolve(stale);
  await staleLoad;
  assert.equal(app.current, old);
  assert.equal(stale.player.disposed, true);
  assert.equal(app.wantedId, null);
});

test('rapid cold-to-ready selection cannot be replaced by the older late completion', async () => {
  const app = fixture(['a', 'b', 'c']);
  app.current = entry(app.songs.get('a'));
  app.addWarm(entry(app.songs.get('c')));
  const pending = deferred();
  app.prepare = () => pending.promise;
  const staleLoad = app.loadSong('b');
  const job = app.jobs.get('b');
  // Disable further preparation so this assertion isolates the selection race.
  app.settings.preloadNext = false;
  await app.loadSong('c');
  assert.equal(job.cancelled, true);
  const stale = entry(app.songs.get('b'));
  pending.resolve(stale);
  await staleLoad;
  assert.equal(app.current.song.id, 'c');
  assert.equal(stale.player.disposed, true);
  assert.equal(app.loading, null);
});

test('automatic preparation respects the mobile RAM budget and reports limited readiness', async () => {
  const app = fixture(['a', 'b', 'c', 'd'], 25);
  app.current = entry(app.songs.get('a'));
  app.warmUp();
  await waitUntil(() => !app.jobs.size);
  assert.deepEqual(app.prepared, ['b']);
  assert.equal(app.preparationStatus().complete, false);
  assert.equal(app.preparationStatus().limited, true);
  assert.ok(app.memoryUsed() <= app.warmBudget());
});

test('an oversized next song does not evict ready songs that cannot make it fit', async () => {
  const app = fixture(['a', 'b', 'c'], 25);
  app.current = entry(app.songs.get('a'));
  app.songs.get('b').testBytes = 30 * MB;
  const ready = entry(app.songs.get('c'));
  app.addWarm(ready);
  app.warmUp();
  assert.equal(app.warm.get('c'), ready);
  assert.equal(ready.player.disposed, false);
  assert.equal(app.jobs.size, 0);
});

test('cold selection releases the old player only when RAM requires it, preserving switching metadata', async () => {
  const app = fixture(['a', 'b'], 15);
  const old = entry(app.songs.get('a'));
  app.current = old;
  const pending = deferred();
  app.prepare = () => pending.promise;
  const unloaded = [];
  app.on('song:unloaded', info => unloaded.push(info));
  const loading = app.loadSong('b');
  assert.equal(app.current, null);
  assert.equal(old.player.disposed, true);
  assert.equal(app.loading.switching, true);
  assert.equal(unloaded.length, 1);
  pending.resolve(entry(app.songs.get('b')));
  await loading;
  assert.equal(app.current.song.id, 'b');
  assert.equal(app.current.switching, true);
  assert.ok(app.memoryUsed() <= app.warmBudget());
});

test('a stale ready entry is discarded and regenerated from local audio', async () => {
  const app = fixture(['a', 'b']);
  app.settings.preloadNext = false;
  app.current = entry(app.songs.get('a'));
  const stale = entry(app.songs.get('b'));
  stale.signature = 'old-file-revision';
  app.warm.set('b', stale);
  await app.loadSong('b');
  assert.equal(stale.player.disposed, true);
  assert.equal(app.current.song.id, 'b');
  assert.deepEqual(app.prepared, ['b']);
});

test('prepared arbitrary selections reuse local heads without reading or decoding them again', async () => {
  const app = fixture(['a', 'b', 'c']);
  app.setlists[0].songIds = ['a', 'b'];
  const reads = [], decodes = [];
  const previousGetMany = store.getMany;
  store.getMany = async (name, ids) => {
    assert.equal(name, 'files');
    reads.push(...ids);
    return ids.map(id => ({ blob: { id } }));
  };
  app.engine.loadVoices = async () => new Map();
  app.engine.decode = async blob => {
    decodes.push(blob.id);
    return { duration: 1, numberOfChannels: 2 };
  };
  app.engine.createPlayer = song => ({ ...entry(song).player, on() {}, peaks() {} });
  app.prepare = App.prototype.prepare;
  try {
    app.warmUp();
    await waitUntil(() => ['a', 'b', 'c'].every(id => app.isReady(id)) && !app.jobs.size);
    assert.deepEqual(reads, ['a-file', 'b-file', 'c-file']);
    assert.equal(decodes.length, 3);
    await app.loadSong('c');
    await app.loadSong('a');
    await app.loadSong('b');
    await app.loadSong('c');
    assert.equal(reads.length, 3);
    assert.equal(decodes.length, 3);
    assert.equal(app.current.song.id, 'c');
  } finally {
    store.getMany = previousGetMany;
  }
});

test('preparation passes mono and pitch to local storage once and does not retune an already prepared stream', async () => {
  const app = fixture(['a']);
  app.prepare = App.prototype.prepare;
  const original = app.songs.get('a');
  original.pitchSemitones = -3;
  original.tracks[0].mono = true;
  original.tracks[0].pitchEnabled = true;
  const previousGetMany = store.getMany, previousDiskAudio = fakeDiskAudio;
  const calls = [];
  store.getMany = async (name, ids) => ids.map(id => ({ blob: { id } }));
  fakeDiskAudio = async (engine, blob, options) => {
    calls.push({ blob, options });
    return { stream: true, preparedPitch: true, duration: 300, sourceChannels: 2, numberOfChannels: 1, memoryBytes: () => 384000 };
  };
  app.engine.loadVoices = async () => new Map();
  app.engine.createPlayer = currentSong => ({
    ...entry(currentSong).player, on() {}, peaks() {},
    async setPitch() { assert.fail('App.prepare must not render a prepared stream twice'); },
  });
  try {
    const prepared = await app.prepare(original);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.fileId, 'a-file');
    assert.equal(calls[0].options.mono, true);
    assert.equal(calls[0].options.pitchSemitones, -3);
    assert.equal(calls[0].options.pitchEnabled, true);
    assert.equal(prepared.player.pitchSemitones, -3);
    assert.equal(app.audioInfo.get('a-file').channels, 2, 'Header metadata retains original channel count');
    assert.equal(original.tracks[0].duration, 300);
  } finally {
    store.getMany = previousGetMany;
    fakeDiskAudio = previousDiskAudio;
  }
});

test('seven five-minute songs with ten stereo stems fit in 128 MiB and switch 1→7→1 without I/O', async () => {
  const ids = Array.from({ length: 7 }, (_, index) => `mt${index + 1}`);
  const app = fixture(ids, 128);
  app.estimateBytes = App.prototype.estimateBytes;
  app.prepare = App.prototype.prepare;
  app.audioInfo = new Map();
  for (const original of app.songs.values()) {
    original.tracks = Array.from({ length: 10 }, (_, index) => ({
      id: `${original.id}-track${index}`, fileId: `${original.id}-file${index}`,
      name: `Pista ${index + 1}`, mono: false, pitchEnabled: false, duration: 300,
    }));
    for (const track of original.tracks) app.audioInfo.set(track.fileId, { channels: 2, duration: 300 });
  }
  const reads = [], heads = [];
  const previousGetMany = store.getMany, previousDiskAudio = fakeDiskAudio;
  let decodes = 0;
  store.getMany = async (name, fileIds) => {
    assert.equal(name, 'files');
    reads.push(...fileIds);
    return fileIds.map(id => ({ blob: { id } }));
  };
  // A previously downloaded/prepared disk source returns only its pinned head.
  // Decoding a full five-minute stem would fail this integration test.
  app.engine.decode = async () => { decodes++; throw new Error('Full-song decoding is forbidden'); };
  fakeDiskAudio = async (engine, blob, options) => {
    assert.equal(options.fileId, blob.id);
    assert.equal(options.cancelled(), false);
    const head = { duration: 2, length: 96000, sampleRate: 48000, numberOfChannels: 2 };
    heads.push(blob.id);
    return {
      stream: true, preparedPitch: true, duration: 300, length: 14400000,
      sampleRate: 48000, numberOfChannels: 2, chunkSeconds: 2,
      memoryBytes: () => head.length * head.numberOfChannels * 4,
      peekChunk: index => index === 0 ? head : null,
      getChunk: async index => { assert.equal(index, 0); return head; },
      ensure: async () => {}, dispose() {},
    };
  };
  app.engine.loadVoices = async () => new Map();
  app.engine.createPlayer = (original, buffers) => {
    assert.equal(buffers.size, 10);
    assert.ok([...buffers.values()].every(buffer => buffer.stream && buffer.peekChunk(0)));
    const player = entry(original).player;
    player.memoryBytes = () => [...buffers.values()].reduce((sum, buffer) => sum + buffer.memoryBytes(), 0)
      + 2 * 48000 * 4 * 2; // Generated click and guide heads.
    player.on = () => {};
    player.peaks = () => {};
    return player;
  };
  try {
    const perSongBytes = 2 * 48000 * 4 * 22;
    assert.equal(app.estimateBytes(app.songs.get('mt1')), perSongBytes);
    assert.ok(perSongBytes * 7 < app.warmBudget());
    // The former full-buffer plan required over 8 GiB for the same setlist.
    assert.ok(300 * 48000 * 4 * 22 * 7 > 8 * 1024 ** 3);
    app.warmUp();
    await waitUntil(() => app.preparationStatus().complete && !app.jobs.size);
    assert.equal(app.preparationStatus().ready, 7);
    assert.equal(heads.length, 70);
    assert.equal(reads.length, 70);
    assert.equal(decodes, 0);
    assert.equal(app.memoryUsed(), perSongBytes * 7);
    const loadingEvents = [];
    app.on('loading', value => loadingEvents.push(value));
    for (const id of ['mt1', 'mt7', 'mt1']) {
      const switching = app.loadSong(id);
      assert.equal(app.current.song.id, id, 'A ready selection commits before the promise yields');
      await switching;
    }
    assert.equal(reads.length, 70);
    assert.equal(heads.length, 70);
    assert.equal(decodes, 0);
    assert.deepEqual(loadingEvents, []);
    assert.equal(app.current.song.id, 'mt1');
    assert.equal(app.preparationStatus().ready, 7);
    assert.ok(app.memoryUsed() <= 128 * MB);
  } finally {
    store.getMany = previousGetMany;
    fakeDiskAudio = previousDiskAudio;
  }
});

test('switching a playing song starts its ready replacement without a new count-in', async () => {
  const app = fixture(['a', 'b']);
  app.current = entry(app.songs.get('a'));
  app.current.player.state = 'playing';
  const next = entry(app.songs.get('b'));
  app.addWarm(next);
  assert.equal(app.settings.autoCountIn, true);
  await app.loadSong('b');
  assert.equal(app.current, next);
  assert.equal(next.player.state, 'playing');
  assert.equal(next.player.playOptions.length, 1);
  assert.equal(next.player.playOptions[0].countIn, false);
});

test('rapid ready selections preserve playback while an earlier replacement is still starting', async () => {
  const app = fixture(['a', 'b', 'c']);
  app.current = entry(app.songs.get('a'));
  app.current.player.state = 'playing';
  const starting = entry(app.songs.get('b')), latest = entry(app.songs.get('c'));
  const resumed = deferred();
  starting.player.play = async function (options) {
    const request = ++this.playRequest;
    this.playOptions.push(options);
    await resumed.promise;
    if (request === this.playRequest) this.state = 'playing';
  };
  app.addWarm(starting);
  app.addWarm(latest);
  const first = app.loadSong('b');
  assert.equal(app.current, starting);
  assert.equal(starting.player.state, 'stopped');
  assert.equal(app.playbackIntent, true);
  const second = app.loadSong('c');
  assert.equal(app.current, latest);
  await second;
  resumed.resolve();
  await first;
  assert.equal(latest.player.state, 'playing');
  assert.equal(latest.player.playOptions.length, 1);
  assert.equal(latest.player.playOptions[0].countIn, false);
  assert.equal(starting.player.rewinds, 1);
  assert.equal(starting.player.state, 'stopped', 'A retired pending start cannot reactivate');
});

test('pausing during cold preparation prevents its replacement from restarting playback', async () => {
  const app = fixture(['a', 'b']);
  app.current = entry(app.songs.get('a'));
  app.current.player.state = 'playing';
  const pending = deferred();
  app.prepare = () => pending.promise;
  const loading = app.loadSong('b');
  assert.equal(app.playbackIntent, true);
  app.pause();
  assert.equal(app.playbackIntent, false);
  assert.equal(app.current.player.state, 'paused');
  const ready = entry(app.songs.get('b'));
  pending.resolve(ready);
  await loading;
  assert.equal(app.current, ready);
  assert.equal(ready.player.state, 'stopped');
  assert.equal(ready.player.playOptions.length, 0);
});

test('a deliberate stop cancels an unfinished start and clears playback intent for later selections', async () => {
  const app = fixture(['a', 'b']);
  const initial = entry(app.songs.get('a')), replacement = entry(app.songs.get('b'));
  const resumed = deferred();
  initial.player.play = async function (options) {
    const request = ++this.playRequest;
    this.playOptions.push(options);
    await resumed.promise;
    if (request === this.playRequest) this.state = 'playing';
  };
  app.current = initial;
  app.addWarm(replacement);
  const starting = app.play();
  assert.equal(app.playbackIntent, true);
  app.stop();
  assert.equal(app.playbackIntent, false);
  resumed.resolve();
  await starting;
  assert.equal(initial.player.state, 'stopped');
  await app.loadSong('b');
  assert.equal(app.current, replacement);
  assert.equal(replacement.player.state, 'stopped');
  assert.equal(replacement.player.playOptions.length, 0);
  assert.equal(app.playbackIntent, false);
});

test('a deliberate first play still uses the configured count-in', async () => {
  const app = fixture(['a']);
  app.current = entry(app.songs.get('a'));
  await app.play();
  assert.equal(app.current.player.playOptions.length, 1);
  assert.equal(app.current.player.playOptions[0].countIn, true);
});

test('a natural ending in stop mode clears playback intent before a later manual selection', async () => {
  const app = fixture(['a', 'b']);
  app.current = entry(app.songs.get('a'));
  const later = entry(app.songs.get('b'));
  app.addWarm(later);
  await app.play();
  assert.equal(app.playbackIntent, true);
  app.current.player.state = 'stopped'; // SongPlayer.poll has reached the end.
  app.handleEnded(app.current);
  assert.equal(app.playbackIntent, false);
  await app.loadSong('b');
  assert.equal(app.current, later);
  assert.equal(later.player.state, 'stopped');
  assert.equal(later.player.playOptions.length, 0);
});

test('the last natural ending in next mode clears playback intent when no next song exists', async () => {
  const app = fixture(['a', 'b']);
  app.settings.afterSong = 'next';
  app.current = entry(app.songs.get('b'));
  await app.play();
  app.current.player.state = 'stopped';
  app.handleEnded(app.current);
  assert.equal(app.current.song.id, 'b');
  assert.equal(app.playbackIntent, false);
  assert.equal(app.wantedId, null);
});

test('reloading a playing song restores its position before the first replacement start', async () => {
  const app = fixture(['a']);
  const original = app.songs.get('a');
  app.current = entry(original);
  app.current.player.position = () => 37.5;
  app.current.player.state = 'playing';
  const replacement = entry(original), starts = [], seeks = [];
  replacement.player.pausedAt = 0;
  replacement.player.seek = function (position, mode) { this.pausedAt = position; seeks.push({ position, mode }); };
  replacement.player.play = async function (options) {
    this.playOptions.push(options);
    starts.push({ position: this.pausedAt, countIn: options.countIn });
    this.state = 'playing';
  };
  app.prepare = async () => replacement;
  await app.reloadIfCurrent('a');
  assert.equal(app.current, replacement);
  assert.deepEqual(seeks, [{ position: 37.5, mode: 'now' }]);
  assert.deepEqual(starts, [{ position: 37.5, countIn: false }]);
  assert.equal(app.playbackIntent, true);
});

test('the retained song ending does not override a pending manual selection', async () => {
  const app = fixture(['a', 'b', 'c']);
  app.settings.afterSong = 'next';
  app.current = entry(app.songs.get('a'));
  const old = app.current;
  const pending = deferred();
  app.prepare = song => song.id === 'c' ? pending.promise : Promise.resolve(entry(song));
  const loading = app.loadSong('c');
  app.handleEnded(old);
  assert.equal(app.wantedId, 'c');
  assert.equal(app.jobs.has('b'), false);
  pending.resolve(entry(app.songs.get('c')));
  await loading;
  assert.equal(app.current.song.id, 'c');
});

test('replacing a low-memory pending selection preserves switching metadata', async () => {
  const app = fixture(['a', 'b', 'c'], 15);
  app.current = entry(app.songs.get('a'));
  const b = deferred(), c = deferred();
  app.prepare = song => song.id === 'b' ? b.promise : c.promise;
  const first = app.loadSong('b');
  assert.equal(app.current, null);
  const latest = app.loadSong('c');
  assert.equal(app.loading.switching, true);
  b.resolve(entry(app.songs.get('b')));
  await first;
  c.resolve(entry(app.songs.get('c')));
  await latest;
  assert.equal(app.current.song.id, 'c');
  assert.equal(app.current.switching, true);
});

test('changing the active setlist frees old-setlist cache entries to prepare the new setlist', async () => {
  const app = fixture(['a', 'b', 'c', 'd'], 25);
  const a = entry(app.songs.get('a')), b = entry(app.songs.get('b'));
  app.addWarm(a);
  app.addWarm(b);
  app.setlists.push({ id: 'new-set', songIds: ['c', 'd'] });
  await app.setActiveSetlist('new-set');
  await waitUntil(() => app.preparationStatus().complete);
  assert.deepEqual(app.prepared, ['c', 'd']);
  assert.equal(a.player.disposed, true);
  assert.equal(b.player.disposed, true);
  assert.ok(app.memoryUsed() <= app.warmBudget());
});
