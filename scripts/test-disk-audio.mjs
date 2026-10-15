import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import vm from 'node:vm';

if (!vm.SourceTextModule) {
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(child.status ?? 1);
}

const rows = new Map();
const io = { reads: [], writes: [], failChunk: null, failAfterWrite: null };
const cache = {
  async get(name, key) { assert.equal(name, 'audioCache'); io.reads.push(key); return rows.get(key); },
  async remove(name, key) { assert.equal(name, 'audioCache'); rows.delete(key); },
  async put(name, row) {
    assert.equal(name, 'audioCache');
    if (io.failChunk === row.id) throw new Error('quota');
    io.writes.push(row.id); rows.set(row.id, row);
    if (io.failAfterWrite === row.id) throw new Error('commit aborted');
  },
};
const pitchCalls = [];
const context = vm.createContext({ console, Blob, AbortController, setInterval, clearInterval });
const loaded = new Map();
const stubs = {
  './store.js': { store: cache },
  './pitch-render.js': { async renderPitchBuffer(ctx, buffer, pitch, { signal, onProgress }) {
    pitchCalls.push(pitch);
    if (signal.aborted) throw new Error('aborted');
    const result = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    for (let c = 0; c < buffer.numberOfChannels; c++) result.getChannelData(c).set(buffer.getChannelData(c));
    onProgress(1);
    return result;
  } },
};
async function moduleFor(specifier) {
  if (loaded.has(specifier)) return loaded.get(specifier);
  const stub = stubs[specifier];
  const module = stub
    ? new vm.SyntheticModule(Object.keys(stub), function () { for (const [name, value] of Object.entries(stub)) this.setExport(name, value); }, { context })
    : new vm.SourceTextModule(await readFile(new URL(`../www/js/${specifier.slice(2)}`, import.meta.url), 'utf8'), { context });
  loaded.set(specifier, module);
  await module.link(moduleFor);
  return module;
}
const module = await moduleFor('./disk-audio.js');
await module.evaluate();
const { createDiskAudio, DiskAudio } = module.namespace;

function audioBuffer(channels, length, sampleRate) {
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: channel => data[channel] };
}
function engineFixture({ channels = 2, length = 56000, rate = 8000 } = {}) {
  let decodes = 0;
  const created = [];
  const engine = {
    ctx: { sampleRate: 48000, createBuffer(ch, frames, hz) {
      const buffer = audioBuffer(ch, frames, hz); created.push(buffer); return buffer;
    } },
    async decode(blob, { cancelled }) {
      decodes++;
      assert.equal(cancelled?.() || false, false);
      const buffer = audioBuffer(channels, length, rate);
      for (let c = 0; c < channels; c++) {
        const out = buffer.getChannelData(c);
        for (let frame = 0; frame < length; frame++) out[frame] = valueAt(frame, c);
      }
      return buffer;
    },
    monoDownmix(buffer) {
      const mono = audioBuffer(1, buffer.length, buffer.sampleRate);
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const input = buffer.getChannelData(c), out = mono.getChannelData(0);
        for (let frame = 0; frame < out.length; frame++) out[frame] += input[frame] / buffer.numberOfChannels;
      }
      return mono;
    },
  };
  return { engine, created, get decodes() { return decodes; } };
}
const values = [-1, -0.5, 0, 0.25, 0.75];
const valueAt = (frame, channel) => values[(frame + channel * 2) % values.length];
function wav({ code = 1, bits = 16, channels = 2, rate = 8000, frames = 40001 } = {}) {
  const align = channels * bits / 8;
  const body = frames * align;
  const bytes = Buffer.alloc(44 + body + (body & 1));
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(code, 20);
  bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * align, 28);
  bytes.writeUInt16LE(align, 32); bytes.writeUInt16LE(bits, 34); bytes.write('data', 36); bytes.writeUInt32LE(body, 40);
  for (let frame = 0; frame < frames; frame++) for (let c = 0; c < channels; c++) {
    const value = valueAt(frame, c), offset = 44 + (frame * channels + c) * bits / 8;
    if (code === 3 && bits === 32) bytes.writeFloatLE(value, offset);
    else if (code === 3) bytes.writeDoubleLE(value, offset);
    else if (bits === 8) bytes.writeUInt8(value * 128 + 128, offset);
    else bytes.writeIntLE(value * 2 ** (bits - 1), offset, bits / 8);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}
function trackedBlob(blob, afterRead = () => {}) {
  const slices = [];
  return { blob: {
    size: blob.size, type: blob.type,
    arrayBuffer() { throw new Error('Whole-file reading is forbidden'); },
    slice(start, end) {
      slices.push([start, end]);
      const part = blob.slice(start, end);
      return { async arrayBuffer() { const raw = await part.arrayBuffer(); afterRead(start, end); return raw; } };
    },
  }, slices };
}
function reset() {
  rows.clear(); io.reads.length = 0; io.writes.length = 0; io.failChunk = null; io.failAfterWrite = null; pitchCalls.length = 0;
}

for (const [code, bits] of [[1, 8], [1, 16], [1, 24], [1, 32], [3, 32], [3, 64]]) {
  test(`disk WAV ${code === 3 ? 'float' : 'PCM'} ${bits}: exact samples across chunk boundaries`, async () => {
    for (const channels of [1, 2]) {
      const fixture = engineFixture();
      const stream = await createDiskAudio(fixture.engine, wav({ code, bits, channels }));
      assert.equal(fixture.decodes, 0);
      assert.equal(stream.stream, true);
      assert.equal(stream.numberOfChannels, channels);
      assert.equal(stream.length, 40001);
      assert.equal(stream.chunkSeconds, 2);
      assert.equal(stream.framesPerChunk, 16000);
      for (const index of [0, 1, 2]) {
        const buffer = await stream.getChunk(index);
        assert.equal(buffer.length, index === 2 ? 8001 : 16000);
        for (let c = 0; c < channels; c++) for (const frame of [0, 1, buffer.length - 1]) {
          assert.equal(buffer.getChannelData(c)[frame], valueAt(index * 16000 + frame, c));
        }
      }
      assert.equal(await stream.getChunk(3), null);
      assert.equal(await stream.getChunk(-1), null);
      assert.equal(stream.peaks.length, 1600);
      assert.ok(stream.peaks.some(peak => peak === 1));
    }
  });
}

test('preparation reads only a header and 2 seconds at the original sample rate', async () => {
  const tracked = trackedBlob(wav({ rate: 44100, frames: 44100 * 20 }));
  const fixture = engineFixture();
  const stream = await createDiskAudio(fixture.engine, tracked.blob, { fileId: 'bounded' });
  assert.equal(stream.sampleRate, 44100);
  assert.equal(stream.duration, 20);
  assert.equal(stream.peekChunk(0).length, 88200);
  assert.equal(stream.peekChunk(1), null);
  assert.equal(fixture.created.length, 1);
  assert.equal(tracked.slices.length, 2);
  assert.equal(tracked.slices[1][1] - tracked.slices[1][0], 88200 * 4);
  assert.ok(tracked.slices.reduce((total, [start, end]) => total + end - start, 0) < tracked.blob.size / 5);
  assert.equal(fixture.decodes, 0);
});

test('stereo downmix is opt-in and sourceChannels survives it', async () => {
  const fixture = engineFixture();
  const stream = await createDiskAudio(fixture.engine, wav(), { mono: true });
  assert.equal(stream.numberOfChannels, 1);
  assert.equal(stream.sourceChannels, 2);
  const buffer = await stream.getChunk(1);
  for (let i = 0; i < 10; i++) assert.equal(buffer.getChannelData(0)[i], (valueAt(16000 + i, 0) + valueAt(16000 + i, 1)) / 2);
});

test('chunk reads deduplicate, LRU remains bounded, and the first chunk stays armed', async () => {
  const tracked = trackedBlob(wav({ frames: 8000 * 30 }));
  const fixture = engineFixture();
  const stream = await createDiskAudio(fixture.engine, tracked.blob);
  const requests = tracked.slices.length;
  const [a, b] = await Promise.all([stream.getChunk(2), stream.getChunk(2)]);
  assert.equal(a, b);
  assert.equal(tracked.slices.length, requests + 1);
  stream.setPins([4]);
  for (let chunk = 1; chunk < 15; chunk++) await stream.getChunk(chunk);
  assert.ok(stream.peekChunk(0));
  assert.ok(stream.peekChunk(2));
  assert.ok(stream.peekChunk(14));
  assert.equal(stream.peekChunk(1), null);
  assert.ok(stream.memoryBytes() <= 8 * 16000 * 2 * 4);
  await stream.ensure(100000);
  assert.ok(stream.peekChunk(14));
  stream.dispose();
  assert.equal(stream.memoryBytes(), 0);
  assert.equal(stream.peekChunk(0), null);
  await assert.rejects(stream.getChunk(0), { name: 'WavAborted' });
});

test('ensure arms a seek destination and its immediate successor', async () => {
  const fixture = engineFixture();
  const stream = await createDiskAudio(fixture.engine, wav({ frames: 8000 * 20 }));
  await stream.ensure(6.9);
  assert.ok(stream.peekChunk(3));
  assert.ok(stream.peekChunk(4));
  const head = stream.peekChunk(0);
  stream.trimToHead();
  assert.equal(stream.peekChunk(0), head);
  assert.equal(stream.peekChunk(3), null);
  assert.equal(stream.peekChunk(4), null);
  assert.equal(stream.memoryBytes(), head.length * head.numberOfChannels * 4);
});

test('compressed audio decodes once and reopens from persistent chunks without full buffers', async () => {
  reset();
  const fixture = engineFixture();
  const blob = new Blob(['compressed MP3 bytes'], { type: 'audio/mpeg' });
  const stream = await createDiskAudio(fixture.engine, blob, { fileId: 'mp3' });
  assert.equal(fixture.decodes, 1);
  assert.equal(rows.size, 5); // Four chunks plus the complete index.
  assert.equal(stream.duration, 7);
  assert.equal(stream.peaks.length, 1600);
  for (let c = 0; c < 2; c++) assert.equal((await stream.getChunk(3)).getChannelData(c)[0], valueAt(48000, c));
  stream.dispose();
  const newEngine = engineFixture();
  const reopened = await createDiskAudio(newEngine.engine, blob, { fileId: 'mp3' });
  assert.equal(newEngine.decodes, 0);
  assert.equal(newEngine.created.length, 1);
  assert.equal(reopened.memoryBytes(), 16000 * 2 * 4);
  assert.equal(rows.size, 5);
});

test('compressed mono cache is separate from stereo and invalidates changed source metadata', async () => {
  reset();
  const fixture = engineFixture();
  const blob = new Blob(['FLAC'], { type: 'audio/flac' });
  const stereo = await createDiskAudio(fixture.engine, blob, { fileId: 'one' });
  const mono = await createDiskAudio(fixture.engine, blob, { fileId: 'one', mono: true });
  assert.equal(fixture.decodes, 2);
  assert.equal(stereo.numberOfChannels, 2);
  assert.equal(mono.numberOfChannels, 1);
  assert.equal(mono.sourceChannels, 2);
  const chunk = mono.peekChunk(0);
  assert.equal(chunk.getChannelData(0)[0], (valueAt(0, 0) + valueAt(0, 1)) / 2);
  await createDiskAudio(fixture.engine, new Blob(['larger FLAC'], { type: 'audio/flac' }), { fileId: 'one' });
  assert.equal(fixture.decodes, 3);
});

test('retuned WAV decodes and renders only on its first preparation; reprocess uses the original', async () => {
  reset();
  const fixture = engineFixture();
  const blob = wav();
  const stream = await createDiskAudio(fixture.engine, blob, { fileId: 'pitch', pitchEnabled: true, pitchSemitones: -2 });
  assert.equal(fixture.decodes, 1);
  assert.deepEqual(pitchCalls, [-2]);
  const reopened = await stream.reprocess(-2);
  assert.equal(fixture.decodes, 1);
  assert.equal(reopened.duration, 7);
  const original = await stream.reprocess(0);
  assert.equal(fixture.decodes, 1);
  assert.equal(original.length, 40001);
  assert.equal(original.numberOfChannels, 2);
  const disabled = await stream.reprocess(-7, { pitchEnabled: false });
  assert.equal(disabled.length, 40001);
  assert.deepEqual(pitchCalls, [-2]);
});

test('a failed compressed conversion publishes no complete index and can be retried', async () => {
  reset();
  const fixture = engineFixture();
  const blob = new Blob(['AIFF'], { type: 'audio/aiff' });
  io.failChunk = 'file:retry:mono:0:pitch:0:1';
  await assert.rejects(createDiskAudio(fixture.engine, blob, { fileId: 'retry' }), /quota/);
  assert.equal(rows.has('file:retry:mono:0:pitch:0'), false);
  io.failChunk = null;
  const stream = await createDiskAudio(fixture.engine, blob, { fileId: 'retry' });
  assert.equal(fixture.decodes, 2);
  assert.ok(stream.peekChunk(0));
  assert.ok(rows.has('file:retry:mono:0:pitch:0'));
});

test('concurrent full-file preparations serialize decoders, while WAV heads stay independent', async () => {
  reset();
  const fixture = engineFixture({ length: 100 });
  const originalDecode = fixture.engine.decode;
  const gates = [];
  let active = 0, maxActive = 0, calls = 0;
  fixture.engine.decode = async (...args) => {
    calls++; active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => gates.push(resolve));
    try { return await originalDecode(...args); } finally { active--; }
  };
  const blob = new Blob(['MP3'], { type: 'audio/mpeg' });
  const one = createDiskAudio(fixture.engine, blob, { fileId: 'serial-one' });
  const two = createDiskAudio(fixture.engine, blob, { fileId: 'serial-two' });
  const head = await createDiskAudio(fixture.engine, wav({ frames: 8 }), { fileId: 'independent-wav' });
  assert.ok(head.peekChunk(0));
  assert.equal(calls, 1);
  assert.equal(gates.length, 1);
  gates.shift()();
  await one;
  // The second request may begin before the first descriptor's head read ends.
  for (let i = 0; !gates.length && i < 10; i++) await Promise.resolve();
  assert.equal(calls, 2);
  assert.equal(gates.length, 1);
  gates.shift()();
  await two;
  assert.equal(maxActive, 1);
});

test('duplicate concurrent cache variants decode once and retain independent cancellation', async () => {
  reset();
  const fixture = engineFixture({ length: 100 });
  const originalDecode = fixture.engine.decode;
  let finish, decodeStarted;
  const started = new Promise(resolve => { decodeStarted = resolve; });
  fixture.engine.decode = async (...args) => {
    decodeStarted();
    await new Promise(resolve => { finish = resolve; });
    return originalDecode(...args);
  };
  const blob = new Blob(['MP3'], { type: 'audio/mpeg' });
  const one = createDiskAudio(fixture.engine, blob, { fileId: 'duplicate' });
  let cancelled = false;
  const cancelledDuplicate = createDiskAudio(fixture.engine, blob, { fileId: 'duplicate', cancelled: () => cancelled });
  const three = createDiskAudio(fixture.engine, blob, { fileId: 'duplicate' });
  const rejected = assert.rejects(cancelledDuplicate, { name: 'WavAborted' });
  await started;
  cancelled = true;
  finish();
  const [a, b] = await Promise.all([one, three]);
  await rejected;
  assert.equal(fixture.decodes, 1);
  assert.ok(a.peekChunk(0));
  assert.ok(b.peekChunk(0));
  assert.notEqual(a, b);
});

test('failed cache index commits are invalidated and do not block subsequent conversions', async () => {
  reset();
  const fixture = engineFixture({ length: 100 });
  const blob = new Blob(['MP3'], { type: 'audio/mpeg' });
  const key = 'file:failed-index:mono:0:pitch:0';
  io.failAfterWrite = key;
  await assert.rejects(createDiskAudio(fixture.engine, blob, { fileId: 'failed-index' }), /commit aborted/);
  assert.equal(rows.has(key), false);
  io.failAfterWrite = null;
  const ready = await createDiskAudio(fixture.engine, blob, { fileId: 'failed-index' });
  assert.ok(ready.peekChunk(0));
  assert.equal(fixture.decodes, 2);
});

test('cancelled preparation reads nothing, and cancellation during a WAV read discards the result', async () => {
  const fixture = engineFixture();
  let cancelled = true;
  const tracked = trackedBlob(wav());
  await assert.rejects(createDiskAudio(fixture.engine, tracked.blob, { cancelled: () => cancelled }), { name: 'WavAborted' });
  assert.equal(tracked.slices.length, 0);
  cancelled = false;
  const reading = trackedBlob(wav(), start => { if (start === 44) cancelled = true; });
  await assert.rejects(createDiskAudio(fixture.engine, reading.blob, { cancelled: () => cancelled }), { name: 'WavAborted' });
});

test('cancelled compressed preparation leaves no committed cache index', async () => {
  reset();
  const fixture = engineFixture();
  let cancelled = false;
  const blob = new Blob(['compressed'], { type: 'audio/mpeg' });
  await assert.rejects(createDiskAudio(fixture.engine, blob, { fileId: 'cancel', cancelled: () => cancelled,
    onProgress(value) { if (value > 0.3) cancelled = true; } }), { name: 'WavAborted' });
  assert.equal(rows.has('file:cancel:mono:0:pitch:0'), false);
});

test('disposal while a chunk read is pending never retains the late buffer', async () => {
  const fixture = engineFixture();
  let finish;
  const stream = new DiskAudio({ ctx: fixture.engine.ctx, length: 16000, sampleRate: 8000, numberOfChannels: 1,
    readChunk: () => new Promise(resolve => { finish = resolve; }) });
  const pending = stream.getChunk(0);
  await Promise.resolve();
  stream.dispose();
  finish(audioBuffer(1, 16000, 8000));
  await assert.rejects(pending, { name: 'WavAborted' });
  assert.equal(stream.memoryBytes(), 0);
});

test('releaseExtra discards late read-ahead while keeping a new read for the same chunk', async () => {
  const fixture = engineFixture();
  const waiting = [];
  const stream = new DiskAudio({ ctx: fixture.engine.ctx, length: 48000, sampleRate: 8000, numberOfChannels: 1,
    readChunk: () => new Promise(resolve => { waiting.push(resolve); }) });
  const old = stream.getChunk(1);
  await Promise.resolve();
  stream.trimToHead();
  const current = stream.getChunk(1);
  await Promise.resolve();
  waiting[0](audioBuffer(1, 16000, 8000));
  await old;
  assert.equal(stream.peekChunk(1), null);
  assert.equal(stream.getChunk(1), current);
  waiting[1](audioBuffer(1, 16000, 8000));
  await current;
  assert.ok(stream.peekChunk(1));
});

test('explicit offline materialization copies every frame without changing the streaming cache limit', async () => {
  const fixture = engineFixture();
  const stream = await createDiskAudio(fixture.engine, wav({ frames: 8000 * 25 + 1 }));
  const buffer = await stream.materialize();
  assert.equal(buffer.length, stream.length);
  for (let c = 0; c < 2; c++) for (const frame of [0, 15999, 16000, 99999, 200000]) {
    assert.equal(buffer.getChannelData(c)[frame], valueAt(frame, c));
  }
  assert.ok(stream.memoryBytes() <= 8 * 16000 * 2 * 4);
});
