// Run with: node scripts/test-audio-info.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = await readFile(new URL('../www/js/audio-info.js', import.meta.url), 'utf8');
const { readAudioInfo } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function chunk(id, data, little = true) {
  const head = Buffer.alloc(8);
  head.write(id);
  if (little) head.writeUInt32LE(data.length, 4);
  else head.writeUInt32BE(data.length, 4);
  return Buffer.concat([head, data, Buffer.alloc(data.length & 1)]);
}

function container(kind, type, chunks) {
  const body = Buffer.concat([Buffer.from(type), ...chunks]);
  const head = Buffer.alloc(8);
  head.write(kind);
  if (kind === 'RIFF') head.writeUInt32LE(body.length, 4);
  else head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}

function wav({ channels = 1, rate = 48000, bits = 16, code = 1, frames = 480, extra = [], extensible = false } = {}) {
  const fmt = Buffer.alloc(extensible ? 40 : 16);
  const align = channels * (bits / 8);
  fmt.writeUInt16LE(extensible ? 0xfffe : code, 0);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate * align, 8);
  fmt.writeUInt16LE(align, 12);
  fmt.writeUInt16LE(bits, 14);
  if (extensible) {
    fmt.writeUInt16LE(22, 16);
    fmt.writeUInt16LE(bits, 18);
    fmt.writeUInt32LE(code, 24);
    Buffer.from([0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113]).copy(fmt, 28);
  }
  return container('RIFF', 'WAVE', [...extra, chunk('fmt ', fmt), chunk('data', Buffer.alloc(frames * align))]);
}

function flac({ channels = 2, rate = 44100, bits = 24, frames = 441000 } = {}) {
  const data = Buffer.alloc(42);
  data.write('fLaC');
  data[4] = 0x80;
  data[7] = 34;
  data.writeUInt16BE(4096, 8);
  data.writeUInt16BE(4096, 10);
  const packed = (BigInt(rate) << 44n) | (BigInt(channels - 1) << 41n) | (BigInt(bits - 1) << 36n) | BigInt(frames);
  data.writeBigUInt64BE(packed, 18);
  return data;
}

function aiff({ channels = 2, frames = 441, rate = 44100, bits = 16, compression = null, extra = [] } = {}) {
  const comm = Buffer.alloc(compression ? 24 : 18);
  comm.writeUInt16BE(channels);
  comm.writeUInt32BE(frames, 2);
  comm.writeUInt16BE(bits, 6);
  const exponent = Math.floor(Math.log2(rate));
  comm.writeUInt16BE(exponent + 16383, 8);
  comm.writeBigUInt64BE(BigInt(rate) << BigInt(63 - exponent), 10);
  if (compression) comm.write(compression, 18);
  const sound = Buffer.alloc(8 + frames * channels * (bits / 8));
  return container('FORM', compression ? 'AIFC' : 'AIFF', [...extra, chunk('COMM', comm, false), chunk('SSND', sound, false)]);
}

test('WAV PCM and IEEE float metadata preserves exact channels and duration', async () => {
  for (const channels of [1, 2, 6]) {
    for (const bits of [8, 16, 24, 32]) {
      assert.deepEqual(await readAudioInfo(new Blob([wav({ channels, bits })])), { channels, duration: 0.01 });
    }
    for (const bits of [32, 64]) {
      assert.deepEqual(await readAudioInfo(new Blob([wav({ channels, bits, code: 3, rate: 96000, frames: 960 })])), { channels, duration: 0.01 });
    }
  }
});

test('WAV skips unknown odd-sized chunks and supports extensible PCM/float GUIDs', async () => {
  const extra = [chunk('JUNK', Buffer.alloc(7)), chunk('LIST', Buffer.from('INFO'))];
  for (const code of [1, 3]) {
    assert.deepEqual(await readAudioInfo(new Blob([wav({ channels: 2, bits: 32, code, extensible: true, extra })])), { channels: 2, duration: 0.01 });
  }
  const wrongGuid = wav({ extensible: true });
  wrongGuid[48] ^= 1;
  assert.equal(await readAudioInfo(new Blob([wrongGuid])), null);
});

test('WAV rejects invalid sizes, alignment, sample rate and unsupported encodings', async () => {
  const original = wav();
  const damaged = [];
  const align = Buffer.from(original); align.writeUInt16LE(4, 32); damaged.push(align);
  const rate = Buffer.from(original); rate.writeUInt32LE(0, 24); damaged.push(rate);
  const bytes = Buffer.from(original); bytes.writeUInt32LE(10, 28); damaged.push(bytes);
  const channels = Buffer.from(original); channels.writeUInt16LE(0, 22); damaged.push(channels);
  const oversized = Buffer.from(original); oversized.writeUInt32LE(0x7fffffff, 40); damaged.push(oversized);
  const riff = Buffer.from(original); riff.writeUInt32LE(0x7fffffff, 4); damaged.push(riff);
  const partialFrame = Buffer.from(original); partialFrame.writeUInt32LE(original.length - 45, 40); damaged.push(partialFrame);
  damaged.push(original.subarray(0, original.length - 1), wav({ code: 6 }), wav({ code: 3, bits: 16 }), wav({ frames: 0 }));
  for (const data of damaged) assert.equal(await readAudioInfo(new Blob([data])), null);
});

test('WAV reads small headers and skips a 330 MiB data chunk without reading payload', async () => {
  const header = wav({ channels: 2, bits: 24, frames: 0 });
  const frames = 48000 * 1200;
  const size = 44 + frames * 6;
  header.writeUInt32LE(size - 8, 4);
  header.writeUInt32LE(size - 44, 40);
  const reads = [];
  const largeBlob = {
    size,
    arrayBuffer() { throw new Error('Must never read the full file'); },
    slice(start, end) {
      reads.push([start, end]);
      assert(end <= 44, 'Audio payload must not be read');
      return new Blob([header.subarray(start, end)]);
    },
  };
  assert.deepEqual(await readAudioInfo(largeBlob), { channels: 2, duration: 1200 });
  assert.equal(reads.reduce((bytes, [start, end]) => bytes + end - start, 0), 44);
});

test('FLAC STREAMINFO decodes packed fields including a 36-bit sample count', async () => {
  for (const channels of [1, 2, 8]) {
    const frames = 4294967296 + 123;
    assert.deepEqual(await readAudioInfo(new Blob([flac({ channels, frames })])), { channels, duration: frames / 44100 });
  }
  assert.equal(await readAudioInfo(new Blob([flac({ frames: 0 })])), null);
  assert.equal(await readAudioInfo(new Blob([flac({ rate: 0 })])), null);
  const wrongBlock = flac(); wrongBlock[4] = 0x81;
  assert.equal(await readAudioInfo(new Blob([wrongBlock])), null);
  assert.equal(await readAudioInfo(new Blob([flac().subarray(0, 41)])), null);
});

test('AIFF and uncompressed AIFC metadata support padding and 80-bit sample rates', async () => {
  for (const compression of [null, 'NONE', 'sowt', 'fl32', 'fl64']) {
    const bits = compression === 'fl32' ? 32 : compression === 'fl64' ? 64 : 16;
    const data = aiff({ compression, bits, extra: [chunk('ANNO', Buffer.from('abc'), false)] });
    assert.deepEqual(await readAudioInfo(new Blob([data])), { channels: 2, duration: 0.01 });
  }
  assert.deepEqual(await readAudioInfo(new Blob([aiff({ channels: 1, rate: 96000, frames: 960 })])), { channels: 1, duration: 0.01 });
  assert.equal(await readAudioInfo(new Blob([aiff({ compression: 'ulaw' })])), null);
  const invalid = aiff(); invalid.writeUInt16BE(0x7fff, 28);
  assert.equal(await readAudioInfo(new Blob([invalid])), null);
  assert.equal(await readAudioInfo(new Blob([aiff().subarray(0, 50)])), null);
});

test('unknown, malformed and unreadable inputs return null; pathological chunks are bounded', async () => {
  for (const input of [null, {}, new Blob([]), new Blob([Buffer.alloc(100)]), new Blob([Buffer.from('ID3 unknown MP3')])]) {
    assert.equal(await readAudioInfo(input), null);
  }
  assert.equal(await readAudioInfo({ size: 44, slice() { throw new Error('Unavailable'); } }), null);
  const pathological = container('RIFF', 'WAVE', Array.from({ length: 300 }, () => chunk('JUNK', Buffer.alloc(0))));
  let bytesRead = 0;
  const wrapped = {
    size: pathological.length,
    slice(start, end) { bytesRead += end - start; return new Blob([pathological.subarray(start, end)]); },
  };
  assert.equal(await readAudioInfo(wrapped), null);
  assert(bytesRead <= 16384);
});
