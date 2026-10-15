// Click y guías se generan por bloques, sin reservar un AudioBuffer de toda la canción.
export function createGeneratedAudio(ctx, { duration, renderRange }) {
  const sampleRate = ctx.sampleRate;
  const length = Math.max(1, Math.ceil(duration * sampleRate));
  const chunkSeconds = 2;
  const chunkFrames = Math.max(1, Math.round(chunkSeconds * sampleRate));
  const chunkCount = Math.ceil(length / chunkFrames);
  const chunks = new Map();
  let disposed = false;

  function validIndex(index) {
    if (!Number.isInteger(index) || index < 0 || index >= chunkCount) throw new RangeError('Bloque de audio fuera de rango');
  }

  function touch(index, buffer) {
    chunks.delete(index);
    chunks.set(index, buffer);
    while (chunks.size > 4) {
      const oldest = [...chunks.keys()].find((key) => key !== 0);
      chunks.delete(oldest);
    }
    return buffer;
  }

  function readChunk(index) {
    if (disposed) throw new Error('Audio generado liberado');
    validIndex(index);
    const cached = chunks.get(index);
    if (cached) return touch(index, cached);
    const startFrame = index * chunkFrames;
    const frames = Math.min(chunkFrames, length - startFrame);
    let buffer = renderRange({ start: startFrame / sampleRate, duration: frames / sampleRate });
    // Al convertir frames/rate de vuelta a segundos, ceil(segundos*rate) puede añadir una
    // muestra por precisión binaria (p. ej. 13 frames a 44,1 kHz). El bloque EOF es exacto.
    if (buffer.length !== frames) {
      const exact = ctx.createBuffer(1, frames, sampleRate);
      exact.getChannelData(0).set(buffer.getChannelData(0).subarray(0, frames));
      buffer = exact;
    }
    return touch(index, buffer);
  }

  const descriptor = {
    stream: true,
    duration: length / sampleRate,
    length,
    sampleRate,
    numberOfChannels: 1,
    chunkSeconds,
    framesPerChunk: chunkFrames,
    getChunk(index) {
      try { return Promise.resolve(readChunk(index)); }
      catch (error) { return Promise.reject(error); }
    },
    peekChunk(index) {
      return disposed ? null : chunks.get(index) || null;
    },
    async ensure(start = 0, end = (Math.floor(start / chunkSeconds) + 2) * chunkSeconds) {
      if (disposed) throw new Error('Audio generado liberado');
      const first = Math.max(0, Math.min(chunkCount - 1, Math.floor(start / chunkSeconds)));
      const last = Math.max(first, Math.min(chunkCount - 1, Math.ceil(end / chunkSeconds) - 1));
      for (let index = first; index <= last; index++) readChunk(index);
    },
    memoryBytes() {
      let bytes = 0;
      for (const buffer of chunks.values()) bytes += buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
      return bytes;
    },
    trimToHead() {
      for (const index of chunks.keys()) if (index !== 0) chunks.delete(index);
    },
    dispose() {
      disposed = true;
      chunks.clear();
    },
  };
  // El primer golpe está disponible en la misma tarea de selección de canción.
  readChunk(0);
  return descriptor;
}
