export function renderPitchBuffer(ctx, buffer, semitones, { signal, onProgress = () => {} } = {}) {
  if (!semitones) return Promise.resolve(buffer);
  return new Promise((resolve, reject) => {
    const aborted = () => new DOMException('Cambio de tonalidad cancelado', 'AbortError');
    if (signal?.aborted) { reject(aborted()); return; }
    if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') {
      reject(new Error('Este navegador no permite cambiar la tonalidad. Usa un navegador actualizado.'));
      return;
    }
    let worker;
    let timer;
    const cleanup = () => { clearTimeout(timer); worker?.terminate(); signal?.removeEventListener('abort', cancel); };
    const fail = error => { cleanup(); reject(error); };
    const cancel = () => fail(aborted());
    const watchdog = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(new Error('El procesamiento no responde. Prueba de nuevo o usa menos pistas.')), 60000);
    };
    try {
      worker = new Worker(new URL('./pitch-worker.js', import.meta.url), { type: 'module' });
      signal?.addEventListener('abort', cancel, { once: true });
      worker.onerror = () => fail(new Error('No se pudo iniciar el módulo de tonalidad. Actualiza Escena y vuelve a intentarlo.'));
      worker.onmessageerror = () => fail(new Error('No se pudo recibir el audio procesado'));
      worker.onmessage = ({ data }) => {
        if (data.error) { fail(new Error(data.error)); return; }
        if (data.progress !== undefined) { watchdog(); onProgress(data.progress); return; }
        if (!data.channels) return;
        try {
          if (data.channels.length !== buffer.numberOfChannels || data.channels.some(c => c.length !== buffer.length)) throw new Error('El audio procesado no conserva su duración');
          const rendered = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
          data.channels.forEach((channel, c) => rendered.copyToChannel(channel, c));
          cleanup();
          resolve(rendered);
        } catch (error) { fail(error); }
      };
      // Copies are transferred; the original AudioBuffer must never be detached.
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice());
      watchdog();
      worker.postMessage({ channels, sampleRate: buffer.sampleRate, semitones }, channels.map(c => c.buffer));
    } catch (error) { fail(error); }
  });
}
