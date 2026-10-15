const ENVELOPE_RATE = 2000;
const WAVE_BLOCK = 16;
const SLICE_FRAMES = 131072;
const yieldNow = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Build a 0.5 ms peak envelope for the editor, rather than retaining raw audio.
 * Each source frame contributes its absolute peak to its global time bucket;
 * channels and stems combine by maximum. Only one streamed chunk is read at a
 * time, so the provider can keep its normal bounded playback cache.
 */
export async function computeStreamWaveform(tracks, { duration, cancelled = () => false, pause = yieldNow } = {}) {
  if (cancelled()) return null;
  const sources = tracks.map(track => track.buffer).filter(Boolean);
  const seconds = Number.isFinite(duration) && duration >= 0 ? duration : sources.reduce((end, source) => {
    return Math.max(end, source.length / source.sampleRate || 0);
  }, 0);
  const length = Math.max(1, Math.ceil(seconds * ENVELOPE_RATE));
  const envelope = new Float32Array(length);
  let spent = 0;

  for (const source of sources) {
    if (cancelled()) return null;
    const sampleRate = source.sampleRate;
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isSafeInteger(source.length) || source.length < 0) {
      throw new Error('La pista no tiene una frecuencia o longitud válida');
    }
    const frameLimit = Math.min(source.length, Math.ceil(seconds * sampleRate));
    const chunkFrames = source.stream ? Math.max(1, Math.round(source.framesPerChunk || (source.chunkSeconds || 2) * sampleRate)) : Math.max(1, source.length);
    const chunkCount = Math.ceil(frameLimit / chunkFrames);

    for (let index = 0; index < chunkCount; index++) {
      if (cancelled()) return null;
      let buffer;
      try {
        buffer = source.stream ? await source.getChunk(index) : source;
      } catch (error) {
        if (cancelled()) return null;
        throw error;
      }
      if (cancelled()) return null;
      const firstFrame = index * chunkFrames;
      const frames = Math.min(chunkFrames, frameLimit - firstFrame);
      if (!buffer || buffer.sampleRate !== sampleRate || buffer.length < frames) {
        throw new Error('No se pudo leer un bloque de la forma de onda');
      }
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const samples = buffer.getChannelData(channel);
        let localFrame = 0;
        while (localFrame < frames) {
          const globalFrame = firstFrame + localFrame;
          const bucket = Math.floor(globalFrame * ENVELOPE_RATE / sampleRate);
          if (bucket >= length) break;
          // ceil keeps fractional-rate bucket boundaries exact, including when
          // the same bucket straddles two streamed chunks.
          const end = Math.min(frames, Math.ceil((bucket + 1) * sampleRate / ENVELOPE_RATE) - firstFrame);
          let peak = envelope[bucket];
          const start = localFrame;
          for (; localFrame < end; localFrame++) {
            const value = Math.abs(samples[localFrame]);
            if (value > peak) peak = value;
          }
          envelope[bucket] = peak;
          spent += localFrame - start;
          if (spent >= SLICE_FRAMES) {
            spent = 0;
            await pause();
            if (cancelled()) return null;
          }
        }
      }
      // Even tiny chunks must let playback and song selection run between reads.
      if (source.stream) {
        spent = 0;
        await pause();
        if (cancelled()) return null;
      }
    }
  }

  const data = new Float32Array(Math.ceil(length / WAVE_BLOCK));
  let top = 0;
  for (let frame = 0; frame < length; frame++) {
    const peak = envelope[frame];
    const bucket = Math.floor(frame / WAVE_BLOCK);
    if (peak > data[bucket]) data[bucket] = peak;
    if (peak > top) top = peak;
  }
  return { rate: ENVELOPE_RATE, block: WAVE_BLOCK, data, top: top || 1, channels: [envelope], length };
}
