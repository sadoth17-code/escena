// Recuperación de solicitudes: cada reintento conserva URL, cuerpo y número de parte.
export const TRANSFER_ATTEMPTS = 12;
export const pausedError = () => new DOMException('Transferencia pausada', 'AbortError');

export function waitForRetry(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(pausedError()); return; }
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(pausedError()); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function responseError(response) {
  const body = await response.text();
  let info; try { info = JSON.parse(body); } catch { /* Cloudflare también responde con HTML. */ }
  const code = body.match(/\b(?:error(?:\s+code)?|code)[\s:]+(1101|1102|1027)\b/i)?.[1];
  const messages = {
    1102: 'Cloudflare interrumpió la solicitud por un límite de recursos del Worker.',
    1101: 'Cloudflare detectó un error al ejecutar el Worker.',
    1027: 'Cloudflare indica que se alcanzó el límite de solicitudes del Worker.',
  };
  const message = messages[code] || (typeof info?.error === 'string' ? info.error.slice(0, 500) : `La nube respondió HTTP ${response.status}.`);
  const retryHeader = response.headers.get('retry-after');
  const retryAfter = retryHeader === null ? 0 : /^\d+$/.test(retryHeader) ? Number(retryHeader) * 1000 : Math.max(0, Date.parse(retryHeader) - Date.now()) || 0;
  return Object.assign(new Error(message), { status: response.status, code, retryAfter });
}

export async function cloudRequest(url, { method = 'GET', data, bytes, headers = {}, signal, binary = false, maxAttempts = 3, onRetry } = {}) {
  const body = data ? JSON.stringify(data) : bytes;
  const requestHeaders = { ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers };
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) throw pausedError();
      if (attempt > 1) onRetry?.({ attempt, maxAttempts, delay: 0 });
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      let timedOut = false, failure;
      const timeout = setTimeout(() => { timedOut = true; abort(); }, 180000);
      try {
        const response = await fetch(url, {
          method, mode: 'cors', cache: 'no-store', credentials: 'omit', redirect: 'error',
          signal: controller.signal, headers: requestHeaders, body,
        });
        if (!response.ok) throw await responseError(response);
        if (binary) return { bytes: await response.arrayBuffer(), status: response.status, range: response.headers.get('content-range') };
        return await response.json();
      } catch (error) {
        if (signal?.aborted) throw pausedError();
        failure = timedOut ? Object.assign(new Error('La nube no respondió dentro del tiempo de espera.'), { code: 'TIMEOUT' })
          : error instanceof TypeError ? Object.assign(new Error('No se pudo recibir una respuesta de la nube. Revisa la conexión; el servicio también puede estar interrumpido.'), { code: 'NETWORK' }) : error;
        failure.attempts = attempt;
      } finally {
        clearTimeout(timeout); signal?.removeEventListener('abort', abort);
      }
      const retryable = failure.code === 'NETWORK' || failure.code === 'TIMEOUT' || failure.status === 408 || failure.status === 429 || failure.status >= 500;
      // Un cupo diario conocido o una espera muy larga requieren intervención.
      if (!retryable || failure.code === '1027' || failure.retryAfter > 300000 || attempt === maxAttempts) throw failure;
      const delay = Math.max(failure.retryAfter || 0, Math.min(30000, 1000 * 2 ** (attempt - 1)));
      onRetry?.({ attempt: attempt + 1, maxAttempts, delay, message: failure.message, status: failure.status });
      await waitForRetry(delay, signal);
    }
  } finally { onRetry?.(null); }
}
