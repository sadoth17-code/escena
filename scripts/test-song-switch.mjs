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
const context = vm.createContext({
  navigator: { userAgent: 'Android', deviceMemory: 4, hardwareConcurrency: 4 },
  AbortController, console,
});
const stubs = {
  './util.js': { createEmitter: emitter, debounce: fn => fn, isIOS: () => false, clamp: (n, lo, hi) => Math.min(hi, Math.max(lo, n)) },
  './store.js': { store },
  './audio-info.js': { readAudioInfo: async () => null },
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
      state: 'stopped', disposed: false, rewinds: 0,
      rewind() { this.rewinds++; this.state = 'stopped'; },
      dispose() { this.disposed = true; },
      syncWithSong() {}, memoryBytes() { return bytes; },
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

test('RAM estimates use the original mono channels before any song is decoded', () => {
  const app = fixture(['a']);
  const original = app.songs.get('a');
  original.tracks = Array.from({ length: 8 }, (_, index) => ({
    id: `mono-${index}`, fileId: `mono-file-${index}`, mono: false,
  }));
  app.audioInfo = new Map(original.tracks.map(track => [track.fileId, { channels: 1, duration: 120 }]));
  const expectedBytes = 120 * 48000 * 4 * (8 + 2);
  assert.equal(App.prototype.estimateBytes.call(app, original), expectedBytes);
  // Two two-minute, eight-stem mono songs fit in 512 MiB with their click and guide.
  assert.ok(expectedBytes * 2 < 512 * MB);
});

test('RAM estimates still account for stereo stems and explicit downmixing', () => {
  const app = fixture(['a']);
  const original = app.songs.get('a');
  original.tracks = Array.from({ length: 8 }, (_, index) => ({
    id: `stereo-${index}`, fileId: `stereo-file-${index}`, mono: false, duration: 120,
  }));
  app.audioInfo = new Map(original.tracks.map(track => [track.fileId, { channels: 2, duration: 120 }]));
  assert.equal(App.prototype.estimateBytes.call(app, original), 120 * 48000 * 4 * (16 + 2));
  for (const track of original.tracks) track.mono = true;
  assert.equal(App.prototype.estimateBytes.call(app, original), 120 * 48000 * 4 * (8 + 2));
});

test('pitch memory estimates duplicate only the stems selected for processing', () => {
  const app = fixture(['a']);
  const original = app.songs.get('a');
  original.pitchSemitones = 2;
  original.tracks = Array.from({ length: 8 }, (_, index) => ({
    id: `pitch-${index}`, fileId: `pitch-file-${index}`, mono: false, pitchEnabled: index < 4,
  }));
  app.audioInfo = new Map(original.tracks.map(track => [track.fileId, { channels: 1, duration: 120 }]));
  // Eight mono stems, two generated channels and originals for the four pitched stems.
  assert.equal(App.prototype.estimateBytes.call(app, original), 120 * 48000 * 4 * (8 + 2 + 4));
  for (const track of original.tracks) track.pitchEnabled = false;
  assert.equal(App.prototype.estimateBytes.call(app, original), 120 * 48000 * 4 * (8 + 2));
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

test('prepared arbitrary selections reuse decoded local stems without reading or decoding them again', async () => {
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
