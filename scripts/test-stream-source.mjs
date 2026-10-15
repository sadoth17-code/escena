// Deterministic transport tests: no audio device, wall-clock timers or sleeps.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = await readFile(new URL('../www/js/stream-source.js', import.meta.url), 'utf8');
const { StreamSource } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); }

function fixture({ duration = 20, playbackDuration = duration, rate = 1000, cached = true } = {}) {
  const timers = new Set();
  const nodes = [];
  const reads = [];
  const underruns = [];
  const chunks = new Map();
  const gains = [];
  const ctx = {
    currentTime: 0,
    sampleRate: rate,
    createGain() {
      const gain = { connections: [], connect(target) { this.connections.push(target); return target; }, disconnect() { this.connections = []; } };
      gains.push(gain);
      return gain;
    },
    createBufferSource() {
      const node = {
        connections: [], ended: false, stopAt: Infinity,
        connect(target) { this.connections.push(target); return target; },
        disconnect() { this.connections = []; },
        start(when, offset, duration) {
          assert(duration > 0);
          this.when = when; this.offset = offset; this.duration = duration;
          this.end = when + duration;
        },
        stop(when = ctx.currentTime) { this.stopAt = when; },
      };
      nodes.push(node);
      return node;
    },
  };
  const descriptor = {
    stream: true, duration, playbackDuration, sampleRate: rate, length: Math.round(duration * rate), chunkSeconds: 2,
    numberOfChannels: 2,
    peekChunk(index) { return cached ? chunks.get(index) || null : null; },
    getChunk(index) { reads.push(index); return chunks.get(index) || null; },
    onUnderrun(detail) { underruns.push(detail); },
  };
  for (let index = 0; index * 2 < duration; index++) {
    const length = Math.min(rate * 2, descriptor.length - index * rate * 2);
    chunks.set(index, { id: index, length, duration: length / rate, sampleRate: rate });
  }
  const options = { setInterval(fn) { timers.add(fn); return fn; }, clearInterval(fn) { timers.delete(fn); } };
  const make = () => new StreamSource(ctx, descriptor, options);
  const advance = time => {
    ctx.currentTime = time;
    for (const node of nodes) {
      if (!node.ended && time >= Math.min(node.end, node.stopAt)) {
        node.ended = true;
        node.onended?.();
      }
    }
    for (const timer of [...timers]) timer();
  };
  return { ctx, descriptor, chunks, nodes, reads, underruns, gains, timers, make, advance };
}

function close(actual, expected) { assert(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`); }
function contiguous(nodes) {
  for (let i = 1; i < nodes.length; i++) close(nodes[i - 1].when + nodes[i - 1].duration, nodes[i].when);
}

test('cached head schedules synchronously at a shared clock, with exact adjoining frames', () => {
  const f = fixture();
  const a = f.make(), b = f.make();
  const target = {};
  assert.equal(a.connect(target), target);
  a.start(0.07, 0);
  assert.equal(f.nodes.length, 3);
  const first = [...f.nodes];
  assert.deepEqual(first.map(n => [n.buffer.id, n.when, n.offset, n.duration]), [[0, 0.07, 0, 2], [1, 2.07, 0, 2], [2, 4.07, 0, 2]]);
  contiguous(first);
  b.start(0.07, 0);
  for (let i = 0; i < 3; i++) close(first[i].when, f.nodes[i + 3].when);
  assert.equal(f.reads.length, 0);
  a.stop(); b.stop();
  assert.equal(f.timers.size, 0);
});

test('rolling window requests whole chunks and does not fragment a chunk every timer tick', () => {
  const f = fixture();
  const stream = f.make();
  stream.start(0);
  for (let step = 1; step <= 19; step++) f.advance(step / 10);
  assert.equal(f.nodes.length, 4, '0..8 seconds need four sources, not twenty');
  f.advance(2.1);
  assert.equal(f.nodes.length, 5);
  contiguous(f.nodes);
  stream.stop();
});

test('a suspended scheduler skips obsolete chunks without loading the whole missed interval', () => {
  const f = fixture({ duration: 300 });
  const stream = f.make();
  stream.start(0);
  f.advance(120);
  assert.equal(f.nodes.length, 6);
  assert.deepEqual(f.nodes.slice(3).map(n => n.buffer.id), [60, 61, 62]);
  close(f.nodes[3].when, 120);
  assert(f.underruns.some(item => item.skippedFrames === 114000));
  stream.stop();
});

test('arbitrary offset is quantized once and chunk offsets retain frame precision', () => {
  const f = fixture({ rate: 48000 });
  const stream = f.make();
  stream.start(1, 1.234567);
  const offset = Math.round(1.234567 * 48000) / 48000;
  close(f.nodes[0].offset, offset);
  close(f.nodes[0].duration, 2 - offset);
  close(f.nodes[1].when, 1 + 2 - offset);
  contiguous(f.nodes);
  stream.stop();
});

test('finite final partial chunk ends at the track duration and calls onended once', () => {
  const f = fixture({ duration: 3.25 });
  const stream = f.make();
  let ended = 0;
  stream.onended = event => { assert.equal(event.target, stream); ended++; };
  stream.start(0.1);
  assert.deepEqual(f.nodes.map(n => n.duration), [2, 1.25]);
  f.advance(3.349);
  assert.equal(ended, 0);
  f.advance(3.35);
  f.advance(8);
  stream.stop();
  assert.equal(ended, 1);
  assert.equal(f.timers.size, 0);
  assert(f.nodes.every(n => n.connections.length === 0));
  assert.equal(f.gains[0].connections.length, 0);
});

test('short stems retain virtual silence until the complete song ends, without reads past EOF', () => {
  const f = fixture({ duration: 1.25, playbackDuration: 8 });
  const stream = f.make();
  let ended = 0;
  stream.onended = () => ended++;
  stream.start(0);
  assert.equal(f.nodes.length, 1);
  close(f.nodes[0].duration, 1.25);
  f.advance(7);
  assert.equal(ended, 0);
  assert.deepEqual(f.reads, []);
  f.advance(8);
  assert.equal(ended, 1);
});

test('loop boundaries split chunks and repeat at exact offsets without gaps', () => {
  const f = fixture({ duration: 10 });
  const stream = f.make();
  stream.loopStart = 1.25;
  stream.loopEnd = 3.5;
  stream.loop = true;
  stream.start(0.1, 0.5);
  assert.deepEqual(f.nodes.map(n => [n.buffer.id, n.offset, n.duration]), [[0, 0.5, 1.5], [1, 0, 1.5], [0, 1.25, 0.75], [1, 0, 1.5], [0, 1.25, 0.75]]);
  contiguous(f.nodes);
  f.advance(40);
  assert.equal(stream._ended, false);
  stream.stop();
});

test('looping over a short stem includes exact virtual silence and returns in time', () => {
  const f = fixture({ duration: 1, playbackDuration: 4 });
  const stream = f.make();
  stream.loop = true;
  stream.start(0);
  assert.deepEqual(f.nodes.map(n => [n.when, n.duration]), [[0, 1], [4, 1]]);
  assert.equal(f.reads.length, 0);
  stream.stop();
});

test('late chunks skip lost frames instead of shifting that stem out of sync', async () => {
  const f = fixture({ cached: false });
  const pending = new Map();
  f.descriptor.getChunk = index => {
    f.reads.push(index);
    if (!pending.has(index)) pending.set(index, deferred());
    return pending.get(index).promise;
  };
  const stream = f.make();
  stream.start(0);
  await flush();
  f.advance(3.001);
  pending.get(1).resolve(f.chunks.get(1));
  await flush();
  const n = f.nodes.find(n => n.buffer.id === 1);
  close(n.when, 3.001);
  close(n.offset, 1.001);
  close(n.duration, 0.999);
  assert(f.underruns.some(item => item.chunkIndex === 1 && item.skippedFrames === 1001));
  pending.get(0).resolve(f.chunks.get(0));
  await flush();
  assert(!f.nodes.some(n => n.buffer.id === 0));
  stream.stop();
});

test('immediate stop cancels all late chunk completions and frees timers and nodes', async () => {
  const f = fixture({ cached: false });
  const pending = deferred();
  f.descriptor.getChunk = () => pending.promise;
  const stream = f.make();
  let ended = 0;
  stream.onended = () => ended++;
  stream.start(1);
  stream.stop(0.25);
  f.advance(0.25);
  pending.resolve(f.chunks.get(0));
  await flush();
  assert.equal(f.nodes.length, 0);
  assert.equal(ended, 1);
  assert.equal(f.timers.size, 0);
});

test('future stop caps existing and asynchronously loaded audio at the same frame', async () => {
  const f = fixture();
  const pending = deferred();
  f.descriptor.peekChunk = index => index === 0 ? f.chunks.get(index) : null;
  f.descriptor.getChunk = index => index === 1 ? pending.promise : Promise.resolve(f.chunks.get(index));
  const stream = f.make();
  stream.start(0);
  stream.stop(2.5);
  pending.resolve(f.chunks.get(1));
  await flush();
  const second = f.nodes.find(n => n.buffer.id === 1);
  close(second.when, 2);
  close(second.duration, 0.5);
  assert(!f.nodes.some(n => n.buffer.id === 2));
  f.advance(2.5);
  assert.equal(stream._ended, true);
});

test('a second stop can shorten a deadline, but cannot revive it', () => {
  const f = fixture();
  const stream = f.make();
  stream.start(0);
  stream.stop(3);
  stream.stop(5);
  close(stream._stopAt, 3);
  stream.stop(2);
  close(stream._stopAt, 2);
  assert(f.nodes.every(n => n.stopAt === 2));
  f.advance(2);
  assert.equal(f.timers.size, 0);
});

test('storage read failures are caught and reported, including synchronous throws', async () => {
  const f = fixture({ cached: false });
  f.descriptor.getChunk = index => {
    if (index === 0) throw new Error('Storage unavailable');
    return Promise.reject(new Error('Read failed'));
  };
  const stream = f.make();
  stream.start(0);
  await flush();
  assert.equal(f.underruns.length, 3);
  assert(f.underruns.every(item => item.error instanceof Error));
  stream.stop();
});

test('loop changes replace future scheduling while preserving current media position', async () => {
  const f = fixture({ duration: 12 });
  const stream = f.make();
  stream.loopStart = 1;
  stream.loopEnd = 3;
  stream.loop = true;
  stream.start(0);
  f.advance(4);
  const before = f.nodes.length;
  stream.loop = false;
  await flush();
  const newNodes = f.nodes.slice(before);
  // At 4 seconds the loop is at 2; the transition occurs one quantum later.
  close(newNodes[0].when, 4.128);
  close(newNodes[0].offset, 0.128);
  assert.equal(newNodes[0].buffer.id, 1);
  contiguous(newNodes);
  f.advance(14);
  assert.equal(stream._ended, true);
});

test('queued live loop changes cannot restart an already stopped source', async () => {
  const f = fixture();
  const stream = f.make();
  stream.start(0);
  stream.loop = true;
  stream.stop();
  const count = f.nodes.length;
  await flush();
  assert.equal(f.nodes.length, count);
  assert.equal(f.timers.size, 0);
});

test('short loop requests the same pending chunk only once', async () => {
  const f = fixture({ cached: false });
  const pending = deferred();
  f.descriptor.getChunk = index => { f.reads.push(index); return pending.promise; };
  const stream = f.make();
  stream.loopStart = 0.05;
  stream.loopEnd = 0.1;
  stream.loop = true;
  stream.start(1, 0.05);
  await flush();
  assert.deepEqual(f.reads, [0]);
  pending.resolve(f.chunks.get(0));
  await flush();
  assert.equal(f.nodes.length, 120);
  contiguous(f.nodes);
  stream.stop();
});

test('uncached generated chunks are deferred outside the synchronous start task', async () => {
  const f = fixture();
  const calls = [];
  f.descriptor.peekChunk = index => index === 0 ? f.chunks.get(0) : null;
  f.descriptor.getChunk = index => { calls.push(index); return f.chunks.get(index); };
  const stream = f.make();
  stream.start(0.07);
  assert.equal(f.nodes.length, 1, 'the cached head is scheduled immediately');
  assert.deepEqual(calls, [], 'synchronous generation must not delay scheduling other stems');
  await flush();
  assert.deepEqual(calls, [1, 2]);
  assert.equal(f.nodes.length, 3);
  contiguous(f.nodes);
  stream.stop();
});

test('source lifecycle and invalid timestamps reject deterministically', () => {
  const f = fixture();
  const stream = f.make();
  assert.throws(() => stream.stop(), { name: 'InvalidStateError' });
  assert.throws(() => stream.start(-1), RangeError);
  assert.throws(() => stream.start(0, -1), RangeError);
  stream.start(0);
  assert.throws(() => stream.start(0), { name: 'InvalidStateError' });
  assert.throws(() => stream.stop(-1), RangeError);
  stream.stop();
});
