// El audio generado por bloques tiene que ser idéntico al render completo, incluso al buscar
// dentro de una palabra o atravesar un cambio de tempo con muestras de click superpuestas.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import vm from 'node:vm';

if (!vm.SourceTextModule) {
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(child.status ?? 1);
}

const context = vm.createContext({ console });
const modules = new Map();
async function load(relative) {
  const url = new URL(relative, import.meta.url);
  if (modules.has(url.href)) return modules.get(url.href);
  const module = new vm.SourceTextModule(await readFile(url, 'utf8'), { context, identifier: url.href });
  modules.set(url.href, module);
  await module.link((specifier, referring) => load(new URL(specifier, referring.identifier).href));
  await module.evaluate();
  return module;
}
const synth = (await load('../www/js/synth.js')).namespace;
const { TempoMap } = (await load('../www/js/tempo.js')).namespace;
const { createGeneratedAudio } = (await load('../www/js/generated-audio.js')).namespace;

function audioContext(sampleRate = 8000) {
  return {
    sampleRate,
    createBuffer(numberOfChannels, length, rate) {
      const channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
      return { numberOfChannels, length, sampleRate: rate, duration: length / rate, getChannelData: (index) => channels[index] };
    },
  };
}

function wave(length, phase = 0) {
  return Float32Array.from({ length }, (_, index) => Math.sin(index * 0.09 + phase) * (1 - index / length));
}

const tempo = new TempoMap([
  { bar: 1, bpm: 123, num: 4, den: 4 },
  { bar: 3, bpm: 91, num: 6, den: 8 },
  { bar: 6, bpm: 171, num: 3, den: 4 },
]);

function assertSlices(full, renderRange, starts) {
  for (const start of starts) {
    const firstFrame = Math.round(start * full.sampleRate);
    const duration = Math.min(2, full.duration - firstFrame / full.sampleRate);
    const range = renderRange({ start, duration });
    const expected = full.getChannelData(0).slice(firstFrame, firstFrame + range.length);
    assert.equal(range.length, expected.length, `Length at ${start}`);
    assert.deepEqual(Array.from(range.getChannelData(0)), Array.from(expected), `Exact samples at ${start}`);
  }
}

for (const sound of ['madera', 'beep', 'cencerro', 'hihat', 'classic', 'missing']) {
  for (const offset of [-0.15, -0.078, 0.137]) {
    test(`click ranges match complete render: ${sound}, offset ${offset}`, () => {
      const ctx = audioContext();
      const bank = { rate: ctx.sampleRate, sounds: new Map([['classic', {
        beat: wave(8800), accent: wave(21000, 0.4), eighth: wave(5000, 1), sixteenth: wave(3600, 2),
      }]]) };
      const options = { duration: 30, offset, sound, subdivision: 4, bank };
      const full = synth.renderClickBuffer(ctx, tempo, options);
      assertSlices(full, (range) => synth.renderClickRange(ctx, tempo, { ...options, ...range }),
        [0, 0.099, 0.501, 1.999, 2, 3.95, 4.01, 8.12345, 15.81, 23.999, 28]);
    });
  }
}

for (const counting of [false, true]) {
  test(`guide ranges preserve words and counting across boundaries: ${counting}`, () => {
    const ctx = audioContext();
    const voices = new Map([
      ['verse', wave(21000)], ['chorus', wave(1000, 2)],
      ...Array.from({ length: 12 }, (_, index) => [`n${index + 1}`, wave(8000, index)]),
    ]);
    const markers = [
      { bar: 1, voice: 'verse' }, { bar: 2, voice: 'verse' }, { bar: 3, voice: 'chorus' },
      { bar: 4, voice: 'chorus' }, { bar: 7, voice: 'verse' }, { bar: 8, voice: 'missing' },
    ];
    for (const offset of [-0.2, 0, 0.147]) {
      for (const leadBars of [0, 1]) {
        const options = { duration: 30, offset, leadBars, counting };
        const full = synth.renderGuideBuffer(ctx, tempo, markers, voices, options);
        assertSlices(full, (range) => synth.renderGuideRange(ctx, tempo, markers, voices, { ...options, ...range }),
          [0, 0.93, 1.999, 2, 2.34, 3.99, 4.03, 6.1, 9.17, 12.00001, 18.4, 28]);
      }
    }
  });
}

test('generated descriptor renders first chunk synchronously, retains head, and bounds cache', async () => {
  const ctx = audioContext(48000);
  const requests = [];
  const descriptor = createGeneratedAudio(ctx, { duration: 601.7, renderRange(range) {
    requests.push(range);
    return synth.renderClickRange(ctx, tempo, { ...range, offset: 0.23, sound: 'madera', subdivision: 2 });
  } });
  assert.equal(descriptor.stream, true);
  assert.equal(descriptor.chunkSeconds, 2);
  assert.equal(descriptor.framesPerChunk, 96000);
  assert.equal(requests.length, 1);
  const head = descriptor.peekChunk(0);
  assert.ok(head);
  assert.equal(descriptor.memoryBytes(), 96000 * 4);
  assert.equal(await descriptor.getChunk(0), head);
  assert.equal(requests.length, 1);
  for (let index = 1; index < 30; index++) {
    await descriptor.getChunk(index);
    assert.equal(descriptor.peekChunk(0), head);
    assert.ok(descriptor.memoryBytes() <= 4 * 96000 * 4);
  }
  assert.equal(descriptor.peekChunk(1), null);
  await descriptor.ensure(9.9);
  assert.ok(descriptor.peekChunk(4));
  assert.ok(descriptor.peekChunk(5));
  assert.equal(descriptor.peekChunk(6), null);
  assert.ok(descriptor.memoryBytes() <= 4 * 96000 * 4);
  const last = await descriptor.getChunk(300);
  assert.equal(last.length, descriptor.length - 300 * descriptor.framesPerChunk);
  await assert.rejects(descriptor.getChunk(-1), { name: 'RangeError' });
  await assert.rejects(descriptor.getChunk(301), { name: 'RangeError' });
  descriptor.dispose();
  assert.equal(descriptor.memoryBytes(), 0);
  assert.equal(descriptor.peekChunk(0), null);
  await assert.rejects(descriptor.getChunk(0), /liberado/);
});

test('generated chunks concatenate to the exact full guide render', async () => {
  const ctx = audioContext(44100);
  const duration = 11.0023;
  const voices = new Map([['long', wave(44100 * 3)], ['n4', wave(30000)]]);
  const markers = [{ bar: 1, voice: 'long' }, { bar: 2, voice: 'long' }, { bar: 3, voice: 'long' }];
  const options = { duration, offset: 0.11, leadBars: 0, counting: true };
  const full = synth.renderGuideBuffer(ctx, tempo, markers, voices, options);
  const descriptor = createGeneratedAudio(ctx, { duration, renderRange: (range) => synth.renderGuideRange(ctx, tempo, markers, voices, { ...options, ...range }) });
  const joined = new Float32Array(full.length);
  for (let index = 0; index < Math.ceil(descriptor.duration / 2); index++) {
    const chunk = await descriptor.getChunk(index);
    joined.set(chunk.getChannelData(0), index * descriptor.framesPerChunk);
  }
  assert.deepEqual(Array.from(joined), Array.from(full.getChannelData(0)));
});

test('generated EOF length stays exact when seconds round up one frame', async () => {
  for (const [rate, tail] of [[8000, 2007], [44100, 13], [48000, 7], [96000, 7]]) {
    const ctx = audioContext(rate);
    const duration = (rate * 4 + tail - 0.1) / rate;
    const descriptor = createGeneratedAudio(ctx, { duration, renderRange: (range) => synth.renderClickRange(ctx, tempo, { ...range, offset: 0, sound: 'beep' }) });
    assert.equal(descriptor.length, rate * 4 + tail);
    assert.equal((await descriptor.getChunk(2)).length, tail);
  }
});
