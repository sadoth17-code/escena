import createWasm from './vendor/signalsmith-stretch/SignalsmithStretchWasm.mjs';
import { normalizePitch } from './pitch-utils.js';

// Runs in a dedicated Worker. Processing equal input/output counts preserves tempo.
// Strip the algorithm's measured latency; zero-pad its tail, never the song itself.
export async function renderPitchChannels(channels, sampleRate, value, onProgress = () => {}) {
  const semitones = normalizePitch(value);
  const length = channels[0]?.length || 0;
  if (!length || channels.some(channel => channel.length !== length)) throw new Error('Pistas de audio no válidas');
  if (!semitones) return channels;
  const wasm = await createWasm();
  wasm._configure(channels.length, Math.round(sampleRate * 0.17), Math.round(sampleRate * 0.02125), false);
  wasm._reset();
  // Disable nonlinear high-frequency mapping: musical tuning uses a uniform ratio.
  wasm._setTransposeSemitones(semitones, 0);
  wasm._setFormantSemitones(0, false);
  const latency = wasm._inputLatency() + wasm._outputLatency();
  const block = 1024;
  const pointer = wasm._setBuffers(channels.length, block);
  const outputs = channels.map(() => new Float32Array(length));
  const total = length + latency;
  let lastProgress = -1;
  for (let start = 0; start < total; start += block) {
    const count = Math.min(block, total - start);
    let memory = wasm.HEAP8.buffer;
    channels.forEach((channel, c) => {
      const input = new Float32Array(memory, pointer + c * block * 4, count);
      input.fill(0);
      if (start < length) input.set(channel.subarray(start, Math.min(length, start + count)));
    });
    wasm._process(count, count);
    memory = wasm.HEAP8.buffer;
    const outputStart = Math.max(0, start - latency);
    const skip = Math.max(0, latency - start);
    if (skip < count) outputs.forEach((output, c) => {
      const rendered = new Float32Array(memory, pointer + (c + channels.length) * block * 4, count);
      output.set(rendered.subarray(skip), outputStart);
    });
    const progress = Math.floor((start + count) / total * 100);
    if (progress !== lastProgress) { lastProgress = progress; onProgress(progress / 100); }
  }
  return outputs;
}
