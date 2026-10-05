// Sprites are decoded once per AudioContext and only when that bank is used.
const banks = new WeakMap();

export async function loadSampleSprite(ctx, definition) {
  let cache = banks.get(ctx);
  if (!cache) { cache = new Map(); banks.set(ctx, cache); }
  if (!cache.has(definition.file)) {
    const pending = (async () => {
      const response = await fetch(new URL(`../audio/samples/${definition.file}`, import.meta.url));
      if (!response.ok) throw new Error('No se pudieron cargar los samples. Conéctate y actualiza Escena para descargarlos.');
      const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
      const data = buffer.getChannelData(0);
      return new Map(definition.index.map(item => {
        const start = Math.round(item.start * buffer.sampleRate);
        const end = Math.round((item.start + item.duration) * buffer.sampleRate);
        return [item.key, data.slice(start, end)];
      }));
    })();
    cache.set(definition.file, pending);
    pending.catch(() => { if (cache.get(definition.file) === pending) cache.delete(definition.file); });
  }
  return cache.get(definition.file);
}
