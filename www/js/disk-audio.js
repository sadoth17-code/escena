import { readWavHeader, WavAborted } from './wav.js';
import { store } from './store.js';
import { renderPitchBuffer } from './pitch-render.js';
import { normalizePitch } from './pitch-utils.js';

// Only a few seconds of each stem live in RAM. The original WAV (or an IndexedDB
// cache for compressed/retuned audio) remains the source of the rest of the song.
export const DISK_CHUNK_SECONDS = 2;
const CACHE_VERSION = 1;
const PEAK_COUNT = 1600;
// Cuánto del final de cada pista se mide para decidir el fade de salida (ver measureTail): lo que suena justo
// antes de que el archivo se corte es lo que se oye como un golpe o un zumbido que se apaga.
export const TAIL_SECONDS = 0.25;
const abortIf = cancelled => { if (cancelled?.()) throw new WavAborted(); };
// Decoders and pitch workers need a complete stem temporarily. Keep at most one
// such conversion alive, independently of the many cheap WAV/header readers.
let conversionQueue = Promise.resolve();

/** readChunk(index, firstFrame, frameCount) must return an AudioBuffer. */
export class DiskAudio {
  constructor({ ctx, length, sampleRate, numberOfChannels, sourceChannels = numberOfChannels, readChunk, peaks = null,
    peaksComplete = false, chunkSeconds = DISK_CHUNK_SECONDS, maxChunks = 8 }) {
    if (!Number.isSafeInteger(length) || length < 1 || !Number.isFinite(sampleRate) || sampleRate <= 0 ||
      !Number.isInteger(numberOfChannels) || numberOfChannels < 1 || typeof readChunk !== 'function') {
      throw new Error('No se pudo preparar la pista local');
    }
    this.stream = true;
    this.ctx = ctx;
    this.length = length;
    this.sampleRate = sampleRate;
    this.numberOfChannels = numberOfChannels;
    this.sourceChannels = sourceChannels;
    this.duration = length / sampleRate;
    this.chunkSeconds = chunkSeconds;
    this.framesPerChunk = Math.max(1, Math.round(chunkSeconds * sampleRate));
    this.chunkCount = Math.ceil(length / this.framesPerChunk);
    this.peaks = peaks;
    // Con la caché local los picos de toda la pista se calculan al prepararla. Con un WAV leído directamente se
    // van llenando a medida que se lee cada bloque; hasRead() dice cuáles faltan por leer.
    this.peaksComplete = Boolean(peaksComplete);
    this._read = new Set();
    this._readChunk = readChunk;
    this._maxChunks = Math.max(2, maxChunks);
    this._buffers = new Map();
    this._pending = new Map();
    this._pins = new Set([0]);
    this._disposed = false;
    this._epoch = 0;
  }

  _index(seconds) {
    const time = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    return Math.min(this.chunkCount - 1, Math.floor(time * this.sampleRate / this.framesPerChunk));
  }

  _trim() {
    for (const index of this._buffers.keys()) {
      if (this._buffers.size <= this._maxChunks) break;
      if (!this._pins.has(index)) this._buffers.delete(index);
    }
  }

  setPins(secondsArray = []) {
    this._pins = new Set([0]);
    for (const seconds of secondsArray) {
      if (this._pins.size >= this._maxChunks - 1) break;
      this._pins.add(this._index(seconds));
    }
    this._trim();
  }

  peekChunk(index) {
    return this._disposed ? null : this._buffers.get(index) || null;
  }

  getChunk(index) {
    if (this._disposed) return Promise.reject(new WavAborted());
    if (!Number.isInteger(index) || index < 0 || index >= this.chunkCount) return Promise.resolve(null);
    const buffered = this._buffers.get(index);
    if (buffered) {
      this._buffers.delete(index);
      this._buffers.set(index, buffered);
      return Promise.resolve(buffered);
    }
    if (this._pending.has(index)) return this._pending.get(index);
    const epoch = this._epoch;
    const first = index * this.framesPerChunk;
    const frames = Math.min(this.framesPerChunk, this.length - first);
    const pending = Promise.resolve().then(() => {
      if (this._disposed) throw new WavAborted();
      return this._readChunk(index, first, frames);
    }).then(buffer => {
      if (this._disposed) throw new WavAborted();
      if (!buffer || buffer.length !== frames || buffer.sampleRate !== this.sampleRate ||
        buffer.numberOfChannels !== this.numberOfChannels) throw new Error('El bloque de audio local está incompleto');
      if (index === 0 || epoch === this._epoch) {
        this._buffers.set(index, buffer);
        this._trim();
      }
      this._read.add(index);
      if (this._read.size >= this.chunkCount) this.peaksComplete = true;
      try { this.onChunk?.(index); } catch (error) { void error; }
      return buffer;
    }).finally(() => { if (this._pending.get(index) === pending) this._pending.delete(index); });
    this._pending.set(index, pending);
    return pending;
  }

  async ensure(seconds) {
    const index = this._index(seconds);
    await Promise.all([this.getChunk(index), this.getChunk(index + 1)]);
  }

  // ¿Ya se leyó este bloque alguna vez (aunque ahora no esté en memoria)?
  hasRead(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.chunkCount) return false;
    return this.peaksComplete || this._read.has(index);
  }

  // Lee un bloque que nunca se ha leído solo para que se complete su parte de `peaks` (un WAV leído directamente
  // la va llenando al leer cada bloque) y lo suelta: no lo guarda en memoria, así que no desplaza de la caché lo
  // que necesita la reproducción. Devuelve true si leyó algo y false si no hacía falta.
  async scanChunk(index) {
    if (this._disposed || this.peaksComplete || !Number.isInteger(index) || index < 0 || index >= this.chunkCount) return false;
    if (this._read.has(index)) return false;
    // Si ya se está leyendo por otro lado, se espera a esa lectura en vez de repetirla.
    if (this._pending.has(index)) {
      try { await this._pending.get(index); } catch (error) { void error; }
      return false;
    }
    const read = this._readChunk;
    if (!read) return false;
    const first = index * this.framesPerChunk;
    const frames = Math.min(this.framesPerChunk, this.length - first);
    await read(index, first, frames);
    if (this._disposed) return false;
    this._read.add(index);
    if (this._read.size >= this.chunkCount) this.peaksComplete = true;
    return true;
  }

  // Pico (valor absoluto, todos los canales) de los últimos `seconds` de la pista. El reproductor lo usa para
  // decidir cuánto dura el fade del final: una pista que ya acaba en silencio no lo necesita, y una que sigue
  // sonando cuando se acaba el archivo sí. Lee solo el último bloque (o los dos últimos, si la ventana cae a
  // caballo entre ambos) y guarda el resultado en `tailPeak`.
  async measureTail(seconds = TAIL_SECONDS) {
    const frames = Math.min(this.length, Math.max(1, Math.round(seconds * this.sampleRate)));
    const first = this.length - frames;
    let peak = 0;
    for (let index = Math.floor(first / this.framesPerChunk); index < this.chunkCount; index++) {
      const chunk = await this.getChunk(index);
      if (!chunk) continue;
      const from = Math.max(0, first - index * this.framesPerChunk);
      for (let c = 0; c < chunk.numberOfChannels; c++) {
        const data = chunk.getChannelData(c);
        for (let i = from; i < data.length; i++) {
          const value = data[i] < 0 ? -data[i] : data[i];
          if (value > peak) peak = value;
        }
      }
    }
    this.tailPeak = peak;
    return peak;
  }

  memoryBytes() {
    let bytes = 0;
    for (const buffer of this._buffers.values()) bytes += buffer.length * buffer.numberOfChannels * 4;
    return bytes;
  }

  // Keep a stopped song armed while releasing its playback read-ahead blocks.
  // Reads already in flight may complete, but cannot refill the retired cache.
  releaseExtra() {
    this._epoch++;
    this._pending.clear();
    this._pins = new Set([0]);
    for (const index of this._buffers.keys()) if (index !== 0) this._buffers.delete(index);
  }

  trimToHead() { this.releaseExtra(); }

  // Explicit escape hatch for offline editing only. Playback uses chunks.
  async materialize({ cancelled = null } = {}) {
    abortIf(cancelled);
    const buffer = this.ctx.createBuffer(this.numberOfChannels, this.length, this.sampleRate);
    for (let index = 0; index < this.chunkCount; index++) {
      abortIf(cancelled);
      const chunk = await this.getChunk(index);
      abortIf(cancelled);
      for (let c = 0; c < this.numberOfChannels; c++) buffer.getChannelData(c).set(chunk.getChannelData(c), index * this.framesPerChunk);
    }
    return buffer;
  }

  dispose() {
    this._disposed = true;
    this._buffers.clear();
    this._pins.clear();
    // Let an in-flight read finish; its result is discarded. Never delete the
    // persistent audio cache when leaving a song.
    this._readChunk = null;
  }
}

function wavSample(view, offset, info) {
  if (info.code === 3) return info.bits === 32 ? view.getFloat32(offset, true) : view.getFloat64(offset, true);
  if (info.bits === 8) return (view.getUint8(offset) - 128) / 128;
  if (info.bits === 16) return view.getInt16(offset, true) / 32768;
  if (info.bits === 32) return view.getInt32(offset, true) / 2147483648;
  const value = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
  return ((value << 8) >> 8) / 8388608;
}

function wavDescriptor(ctx, blob, info, mono) {
  const channels = mono ? 1 : info.channels;
  const length = info.dataLength / info.blockAlign;
  const peaks = new Float32Array(PEAK_COUNT);
  return new DiskAudio({
    ctx, length, sampleRate: info.rate, numberOfChannels: channels, sourceChannels: info.channels, peaks,
    async readChunk(index, first, frames) {
      const start = info.dataStart + first * info.blockAlign;
      const raw = await blob.slice(start, start + frames * info.blockAlign).arrayBuffer();
      if (raw.byteLength !== frames * info.blockAlign) throw new Error('La pista WAV local está incompleta');
      const view = new DataView(raw);
      const buffer = ctx.createBuffer(channels, frames, info.rate);
      const out = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
      const sampleBytes = info.bits / 8;
      for (let frame = 0, offset = 0; frame < frames; frame++, offset += info.blockAlign) {
        if (mono) {
          let value = 0;
          for (let c = 0; c < info.channels; c++) value += wavSample(view, offset + c * sampleBytes, info) / info.channels;
          out[0][frame] = value;
        } else {
          for (let c = 0; c < channels; c++) out[c][frame] = wavSample(view, offset + c * sampleBytes, info);
        }
        const peak = Math.min(peaks.length - 1, Math.floor((first + frame) * peaks.length / length));
        for (let c = 0; c < channels; c++) if (Number.isFinite(out[c][frame])) peaks[peak] = Math.max(peaks[peak], Math.abs(out[c][frame]));
      }
      return buffer;
    },
  });
}

const cacheKey = (fileId, mono, pitch) => `file:${fileId}:mono:${mono ? 1 : 0}:pitch:${pitch}`;
function validCache(index, key, blob) {
  return index?.id === key && index.version === CACHE_VERSION && index.sourceBytes === blob.size &&
    index.sourceType === (blob.type || '') && index.chunkSeconds === DISK_CHUNK_SECONDS &&
    Number.isSafeInteger(index.frames) && index.frames > 0 && Number.isInteger(index.rate) && index.rate > 0 &&
    Number.isInteger(index.channels) && index.channels > 0 && index.channels <= 32 &&
    index.chunks === Math.ceil(index.frames / Math.round(index.rate * DISK_CHUNK_SECONDS));
}

function cachedDescriptor(ctx, index) {
  return new DiskAudio({
    ctx, length: index.frames, sampleRate: index.rate, numberOfChannels: index.channels,
    sourceChannels: index.sourceChannels || index.channels, peaks: index.peaks || null, peaksComplete: Boolean(index.peaks),
    async readChunk(chunk, first, frames) {
      const row = await store.get('audioCache', `${index.id}:${chunk}`);
      if (!row?.blob || row.blob.size !== frames * index.channels * 4) throw new Error('Falta un bloque de audio preparado. Vuelve a preparar esta canción.');
      const raw = await row.blob.arrayBuffer();
      const view = new DataView(raw);
      const buffer = ctx.createBuffer(index.channels, frames, index.rate);
      // Persistent chunks are planar, little-endian Float32, independent of host endianness.
      for (let c = 0; c < index.channels; c++) {
        const out = buffer.getChannelData(c);
        const base = c * frames * 4;
        for (let frame = 0; frame < frames; frame++) out[frame] = view.getFloat32(base + frame * 4, true);
      }
      return buffer;
    },
  });
}

async function materialize(engine, blob, key, { mono, pitch, cancelled, onProgress }) {
  // A completed index is the commit marker. An interrupted conversion leaves no
  // usable index, and subsequent preparation overwrites its partial chunk rows.
  await store.remove('audioCache', key);
  abortIf(cancelled);
  onProgress?.(0);
  let buffer = await engine.decode(blob, { cancelled });
  abortIf(cancelled);
  const sourceChannels = buffer.numberOfChannels;
  if (mono && buffer.numberOfChannels > 1) buffer = engine.monoDownmix(buffer);
  if (pitch) {
    const controller = new AbortController();
    const timer = setInterval(() => { if (cancelled?.()) controller.abort(); }, 40);
    try {
      buffer = await renderPitchBuffer(engine.ctx, buffer, pitch, {
        signal: controller.signal, onProgress: value => {
          if (cancelled?.()) { controller.abort(); return; }
          onProgress?.(value * 0.7);
        },
      });
    } finally { clearInterval(timer); }
    abortIf(cancelled);
  }
  const framesPerChunk = Math.round(buffer.sampleRate * DISK_CHUNK_SECONDS);
  const chunks = Math.ceil(buffer.length / framesPerChunk);
  const peaks = new Float32Array(PEAK_COUNT);
  for (let chunk = 0; chunk < chunks; chunk++) {
    abortIf(cancelled);
    const first = chunk * framesPerChunk;
    const frames = Math.min(framesPerChunk, buffer.length - first);
    const raw = new ArrayBuffer(frames * buffer.numberOfChannels * 4);
    const view = new DataView(raw);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const input = buffer.getChannelData(c);
      const base = c * frames * 4;
      for (let frame = 0; frame < frames; frame++) {
        const value = input[first + frame];
        view.setFloat32(base + frame * 4, value, true);
        const peak = Math.min(peaks.length - 1, Math.floor((first + frame) * peaks.length / buffer.length));
        if (Number.isFinite(value)) peaks[peak] = Math.max(peaks[peak], Math.abs(value));
      }
    }
    await store.put('audioCache', { id: `${key}:${chunk}`, blob: new Blob([raw]) });
    abortIf(cancelled);
    onProgress?.((pitch ? 0.7 : 0) + (chunk + 1) / chunks * (pitch ? 0.3 : 1));
  }
  const index = { id: key, version: CACHE_VERSION, sourceBytes: blob.size, sourceType: blob.type || '',
    frames: buffer.length, rate: buffer.sampleRate, channels: buffer.numberOfChannels, sourceChannels, chunks,
    chunkSeconds: DISK_CHUNK_SECONDS, peaks };
  abortIf(cancelled);
  try {
    await store.put('audioCache', index);
  } catch (error) {
    // IndexedDB rolls an aborted transaction back; also invalidate explicitly so
    // alternative storage adapters cannot expose an ambiguous commit marker.
    await store.remove('audioCache', key).catch(() => {});
    throw error;
  }
  abortIf(cancelled);
  return index;
}

function queuedMaterialize(engine, blob, key, options) {
  const task = conversionQueue.then(async () => {
    abortIf(options.cancelled);
    // Another queued caller can already have completed this exact source and
    // processing variant. Reuse that commit without sharing either cancellation.
    const index = await store.get('audioCache', key);
    abortIf(options.cancelled);
    if (validCache(index, key, blob)) return index;
    return materialize(engine, blob, key, options);
  });
  // A failed/cancelled conversion must not poison the next independent request.
  conversionQueue = task.then(() => {}, () => {});
  return task;
}

/**
 * WAV PCM/float: read header + the first 2 seconds only, even at another sample
 * rate. Compressed or retuned audio: decode/render once, persist planar chunks,
 * then release the full AudioBuffer. Later opens never decode those files again.
 */
export async function createDiskAudio(engine, blob, { fileId, mono = false, pitchSemitones = 0,
  pitchEnabled = false, cancelled = null, onProgress = null } = {}) {
  abortIf(cancelled);
  const pitch = pitchEnabled ? normalizePitch(pitchSemitones) : 0;
  const key = fileId == null ? null : cacheKey(fileId, mono, pitch);
  let descriptor;
  try {
    if (!pitch) {
      const info = await readWavHeader(blob);
      abortIf(cancelled);
      if (info && info.channels >= 1 && info.channels <= 2) descriptor = wavDescriptor(engine.ctx, blob, info, mono);
    }
    if (!descriptor) {
      if (!key) throw new Error('La pista necesita un identificador local para prepararse');
      let index = await store.get('audioCache', key);
      abortIf(cancelled);
      if (!validCache(index, key, blob)) index = await queuedMaterialize(engine, blob, key, { mono, pitch, cancelled, onProgress });
      descriptor = cachedDescriptor(engine.ctx, index);
    }
    // The song can be armed after this small read. The player requests upcoming
    // blocks via ensure(), rather than loading every minute of all seven songs.
    await descriptor.getChunk(0);
    abortIf(cancelled);
    descriptor.reprocess = (semitones, { pitchEnabled: enabled = true, signal, onProgress: progress = null } = {}) =>
      createDiskAudio(engine, blob, { fileId, mono, pitchSemitones: semitones, pitchEnabled: enabled,
        cancelled: () => Boolean(signal?.aborted), onProgress: progress });
    onProgress?.(1);
    return descriptor;
  } catch (error) {
    descriptor?.dispose();
    throw error;
  }
}
