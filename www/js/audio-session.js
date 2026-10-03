// Keep activation synchronous with the user's click/touch, before any await.
export function configureAudioSession() {
  try {
    if (!navigator.audioSession) return false;
    if (navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback';
    return true;
  } catch {
    return false;
  }
}

export async function resumeAudioContext(ctx, timeoutMs = 4000) {
  configureAudioSession();
  if (ctx.state === 'running') return;
  if (ctx.state === 'closed') throw new Error('El audio se cerró. Recarga Escena para volver a reproducir.');
  let timer;
  try {
    // Call resume now: deferring it can lose Safari's user activation.
    const resumed = ctx.resume();
    await Promise.race([
      resumed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('No se pudo activar el audio. Vuelve a tocar Reproducir con Escena en primer plano.')), timeoutMs);
      }),
    ]);
    if (ctx.state !== 'running') throw new Error('El audio sigue interrumpido. Vuelve a tocar Reproducir con Escena en primer plano.');
  } finally {
    clearTimeout(timer);
  }
}
