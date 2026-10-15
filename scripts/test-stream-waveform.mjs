// Run with: node scripts/test-stream-waveform.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = await readFile(new URL('../www/js/stream-waveform.js', import.meta.url), 'utf8');
const { computeStreamWaveform } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const noWait = async () => {};

function audio(sampleRate, channels) {
  const arrays = channels.map(samples => Float32Array.from(samples));
  return {
    sampleRate,
    numberOfChannels: arrays.length,
    length: arrays[0].length,
    duration: arrays[0].length / sampleRate,
    getChannelData(channel) { return arrays[channel]; },
  };
}

function stream(buffer, { chunkSeconds = 2, read = () => {} } = {}) {
  const framesPerChunk = Math.max(1, Math.round(chunkSeconds * buffer.sampleRate));
  return {
    stream: true,
    sampleRate: buffer.sampleRate,
    length: buffer.length,
    duration: buffer.duration,
    numberOfChannels: buffer.numberOfChannels,
    chunkSeconds,
    framesPerChunk,
    async getChunk(index) {
      read(index);
      const first = index * framesPerChunk;
      return audio(buffer.sampleRate, Array.from({ length: buffer.numberOfChannels }, (_, channel) => {
        return buffer.getChannelData(channel).subarray(first, first + framesPerChunk);
      }));
    },
    getChannelData() { throw new Error('A streamed source must never materialize a full stem'); },
  };
}

function reference(buffers, duration) {
  const envelope = new Float32Array(Math.max(1, Math.ceil(duration * 2000)));
  for (const buffer of buffers) {
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let frame = 0; frame < samples.length && frame / buffer.sampleRate < duration; frame++) {
        const bucket = Math.floor(frame * 2000 / buffer.sampleRate);
        if (Math.abs(samples[frame]) > envelope[bucket]) envelope[bucket] = Math.abs(samples[frame]);
      }
    }
  }
  return envelope;
}

test('mixed sample rates and stereo combine by time, rather than frame index', async () => {
  const a = audio(44100, [new Float32Array(4413), new Float32Array(4413)]);
  const b = audio(48000, [new Float32Array(4805)]);
  a.getChannelData(0)[2205] = -0.75;
  a.getChannelData(1)[2206] = 0.875;
  b.getChannelData(0)[2400] = -0.5;
  b.getChannelData(0)[4799] = -1;
  const result = await computeStreamWaveform([{ buffer: a }, { buffer: stream(b) }], { duration: 0.101, pause: noWait });
  assert.deepEqual(result.channels[0], reference([a, b], 0.101));
  assert.equal(result.channels.length, 1);
  assert.equal(result.rate, 2000);
  assert.equal(result.block, 16);
  assert.equal(result.length, 202);
  assert.equal(result.top, 1);
});

test('all source frames contribute, preserving a one-frame attack at odd indices', async () => {
  for (const rate of [8000, 44100, 48000, 96000, 192000]) {
    const buffer = audio(rate, [new Float32Array(Math.ceil(rate * 0.03))]);
    buffer.getChannelData(0)[1] = -0.9;
    buffer.getChannelData(0)[Math.floor(rate * 0.011) + 1] = 0.6;
    const result = await computeStreamWaveform([{ buffer }], { pause: noWait });
    assert.deepEqual(result.channels[0], reference([buffer], buffer.duration));
    assert.equal(result.top, buffer.getChannelData(0)[1] * -1);
  }
});

test('chunk boundaries do not move or lose samples, including fractional bucket edges', async () => {
  for (const rate of [11025, 22050, 44100, 48000]) {
    const buffer = audio(rate, [new Float32Array(Math.ceil(rate * 4.001))]);
    for (const chunkSeconds of [2, 0.0037]) {
      const chunkFrames = Math.round(chunkSeconds * rate);
      for (let first = chunkFrames; first < buffer.length; first += chunkFrames) {
        buffer.getChannelData(0)[first - 1] = -0.95;
        buffer.getChannelData(0)[first] = 0.55;
      }
      const result = await computeStreamWaveform([{ buffer: stream(buffer, { chunkSeconds }) }], { pause: noWait });
      assert.deepEqual(result.channels[0], reference([buffer], buffer.duration));
    }
  }
});

test('coarse 16-frame envelope blocks contain the exact peaks and silence has top 1', async () => {
  const buffer = audio(4000, [new Float32Array(65)]);
  buffer.getChannelData(0)[31] = -0.5;
  buffer.getChannelData(0)[32] = 0.75;
  buffer.getChannelData(0)[64] = -0.25;
  const result = await computeStreamWaveform([{ buffer }], { pause: noWait });
  assert.deepEqual(result.data, Float32Array.from([0.5, 0.75, 0.25]));
  assert.equal(result.top, 0.75);
  const empty = await computeStreamWaveform([], { duration: 0.01, pause: noWait });
  assert.equal(empty.length, 20);
  assert.equal(empty.top, 1);
  assert(empty.channels[0].every(value => value === 0));
});

test('explicit duration truncates source reads and extends with silence', async () => {
  const buffer = audio(48000, [new Float32Array(48000 * 6)]);
  buffer.getChannelData(0)[24000] = 0.5;
  buffer.getChannelData(0)[144000] = 1;
  const reads = [];
  const result = await computeStreamWaveform([{ buffer: stream(buffer, { read: index => reads.push(index) }) }], { duration: 1, pause: noWait });
  assert.deepEqual(reads, [0]);
  assert.equal(result.length, 2000);
  assert.equal(result.top, 0.5);
  assert.deepEqual(result.channels[0], reference([buffer], 1));
  const extended = await computeStreamWaveform([{ buffer }], { duration: 7, pause: noWait });
  assert.equal(extended.length, 14000);
  assert(extended.channels[0].subarray(12000).every(value => value === 0));
});

test('cancellation before reading or during a pending chunk stops without further reads', async () => {
  const buffer = audio(48000, [new Float32Array(48000 * 5)]);
  const reads = [];
  let stopped = true;
  const streamed = stream(buffer, { read: index => { reads.push(index); stopped = true; } });
  assert.equal(await computeStreamWaveform([{ buffer: streamed }], { cancelled: () => stopped }), null);
  assert.deepEqual(reads, []);
  stopped = false;
  assert.equal(await computeStreamWaveform([{ buffer: streamed }], { cancelled: () => stopped, pause: noWait }), null);
  assert.deepEqual(reads, [0]);
});

test('waveform work yields between chunks and within large normal buffers', async () => {
  const buffer = audio(48000, [new Float32Array(48000 * 5)]);
  const events = [];
  await computeStreamWaveform([{ buffer: stream(buffer, { read: index => events.push(`read${index}`) }) }], { pause: async () => events.push('yield') });
  assert.deepEqual(events, ['read0', 'yield', 'read1', 'yield', 'read2', 'yield']);
  let yields = 0;
  const cancelled = await computeStreamWaveform([{ buffer }], { pause: async () => { yields++; }, cancelled: () => yields > 0 });
  assert.equal(cancelled, null);
  assert.equal(yields, 1);
});

test('errors from a disposed source are suppressed only after cancellation', async () => {
  let stopped = false;
  const buffer = stream(audio(48000, [new Float32Array(480)]));
  buffer.getChunk = async () => { throw new Error('Read failed'); };
  await assert.rejects(computeStreamWaveform([{ buffer }], { pause: noWait }), /Read failed/);
  buffer.getChunk = async () => { stopped = true; throw new Error('Disposed'); };
  assert.equal(await computeStreamWaveform([{ buffer }], { cancelled: () => stopped, pause: noWait }), null);
});
