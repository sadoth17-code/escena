// Exact sample comparisons for the real Engine.decode and chunked WAV reader.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { MessageChannel } from 'node:worker_threads';
import { test } from 'node:test';
import vm from 'node:vm';

if (!vm.SourceTextModule) {
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(child.status ?? 1);
}

const context = vm.createContext({ console, MessageChannel });
const wavModule = new vm.SourceTextModule(await readFile(new URL('../www/js/wav.js', import.meta.url), 'utf8'), { context });
await wavModule.link(() => { throw new Error('Unexpected WAV dependency'); });
const stubs = {
  './util.js': { faderToGain() {}, FADER_DEFAULT: 0.75 },
  './voices.js': { loadVoiceBank() {}, DEFAULT_GUIDE_LANG: 'es' },
  './synth.js': { loadClickBank() {} },
  './player.js': { SongPlayer: class {} },
  './audio-session.js': { configureAudioSession() {}, resumeAudioContext() {} },
};
const engineModule = new vm.SourceTextModule(await readFile(new URL('../www/js/engine.js', import.meta.url), 'utf8'), { context });
await engineModule.link(specifier => {
  if (specifier === './wav.js') return wavModule;
  assert.ok(stubs[specifier], `Unexpected engine dependency ${specifier}`);
  const values = stubs[specifier];
  return new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value);
  }, { context });
});
await engineModule.evaluate();
const { Engine } = engineModule.namespace;

function fixture() {
  const buffers = [];
  const native = [];
  const fallback = { native: true };
  const engine = {
    ctx: {
      sampleRate: 48000,
      createBuffer(channels, length, sampleRate) {
        const data = Array.from({ length: channels }, () => new Float32Array(length));
        const buffer = { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: c => data[c] };
        buffers.push(buffer);
        return buffer;
      },
      async decodeAudioData(data) { native.push(data); return fallback; },
    },
  };
  return { engine, buffers, native, fallback, decode: (blob, options) => Engine.prototype.decode.call(engine, blob, options) };
}

function pcm({ bits = 16, code = 1, channels = 2, rate = 48000, frames = 5, extensible = false } = {}) {
  const fmtLength = extensible ? 40 : 16;
  const headerLength = 12 + 8 + fmtLength + 8;
  const align = channels * bits / 8;
  const bodyBytes = frames * align;
  const bytes = Buffer.alloc(headerLength + bodyBytes + (bodyBytes & 1));
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(fmtLength, 16);
  bytes.writeUInt16LE(extensible ? 0xfffe : code, 20); bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * align, 28);
  bytes.writeUInt16LE(align, 32); bytes.writeUInt16LE(bits, 34);
  if (extensible) {
    bytes.writeUInt16LE(22, 36); bytes.writeUInt16LE(bits, 38); bytes.writeUInt32LE(code, 44);
    Buffer.from([0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113]).copy(bytes, 48);
  }
  bytes.write('data', headerLength - 8); bytes.writeUInt32LE(bodyBytes, headerLength - 4);
  const expected = Array.from({ length: channels }, () => []);
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const value = [-1, -0.5, 0, 0.5, 0.75][(frame + channel) % 5];
      const offset = headerLength + (frame * channels + channel) * bits / 8;
      if (code === 3 && bits === 32) bytes.writeFloatLE(value, offset);
      else if (code === 3) bytes.writeDoubleLE(value, offset);
      else if (bits === 8) bytes.writeUInt8(Math.round(value * 128 + 128), offset);
      else bytes.writeIntLE(Math.round(value * 2 ** (bits - 1)), offset, bits / 8);
      expected[channel].push(value);
    }
  }
  return { bytes, expected, blob: new Blob([bytes]) };
}

for (const [code, bits] of [[1, 8], [1, 16], [1, 24], [1, 32], [3, 32], [3, 64]]) {
  test(`chunked WAV preserves exact samples, channels and duration (${code === 3 ? 'float' : 'PCM'} ${bits})`, async () => {
    for (const channels of [1, 2]) {
      const audio = pcm({ bits, code, channels });
      const f = fixture();
      const buffer = await f.decode(audio.blob);
      assert.equal(f.native.length, 0);
      assert.equal(buffer.numberOfChannels, channels);
      assert.equal(buffer.length, 5);
      assert.equal(buffer.sampleRate, 48000);
      for (let c = 0; c < channels; c++) assert.deepEqual(Array.from(buffer.getChannelData(c)), audio.expected[c]);
    }
  });
}

test('supported WAVE_FORMAT_EXTENSIBLE decodes; an unknown GUID uses the native decoder', async () => {
  const audio = pcm({ extensible: true });
  const f = fixture();
  const buffer = await f.decode(audio.blob);
  assert.deepEqual(Array.from(buffer.getChannelData(0)), audio.expected[0]);
  audio.bytes[59] ^= 1;
  const invalid = await f.decode(new Blob([audio.bytes]));
  assert.equal(invalid, f.fallback);
  assert.equal(f.native.length, 1);
});

test('WAV at a different sample rate and other formats retain the native resampling/decoder path', async () => {
  const f = fixture();
  assert.equal(await f.decode(pcm({ rate: 44100 }).blob), f.fallback);
  assert.equal(await f.decode(new Blob(['ID3 unsupported compressed data'])), f.fallback);
  assert.equal(f.native.length, 2);
});

test('inconsistent WAV header never enters the direct PCM path', async () => {
  const f = fixture();
  const audio = pcm();
  audio.bytes.writeUInt32LE(0xffff, 40); // data longer than the file
  assert.equal(await f.decode(new Blob([audio.bytes])), f.fallback);
  assert.equal(f.buffers.length, 0);
  assert.equal(f.native.length, 1);
});

test('a cancelled preparation does not allocate or start the native decoder', async () => {
  const f = fixture();
  await assert.rejects(f.decode(pcm().blob, { cancelled: () => true }), { name: 'WavAborted' });
  await assert.rejects(f.decode(new Blob(['compressed']), { cancelled: () => true }), { name: 'WavAborted' });
  assert.equal(f.buffers.length, 0);
  assert.equal(f.native.length, 0);
});

test('a WAV crossing the 8 MiB block boundary reads slices and never copies the entire file', async () => {
  const audio = pcm({ frames: 8 * 1024 * 1024 / 4 + 1 });
  const reads = [];
  const blob = {
    size: audio.blob.size,
    slice(start, end) { reads.push([start, end]); return audio.blob.slice(start, end); },
    arrayBuffer() { assert.fail('Direct WAV must not read the entire blob'); },
  };
  const f = fixture();
  const buffer = await f.decode(blob);
  assert.equal(buffer.length, 2097153);
  assert.deepEqual(Array.from(buffer.getChannelData(1).slice(-3)), audio.expected[1].slice(-3));
  assert.ok(reads.every(([start, end]) => end - start <= 8 * 1024 * 1024));
  assert.equal(f.native.length, 0);
});
