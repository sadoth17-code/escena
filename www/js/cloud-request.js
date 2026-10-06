// Recuperación de solicitudes: cada reintento conserva URL, cuerpo y número de parte.
export const TRANSFER_ATTEMPTS = 12;
export const pausedError = () => new DOMException('Transferencia pausada', 'AbortError');

// En la app de escritorio la página se sirve desde app://escena y las solicitudes a la nube salen por
// el proceso principal (electron/nube-proxy.js). Así no dependen de CORS ni de que el Worker tenga
// «app://escena» en ALLOWED_ORIGINS: sin ese origen el navegador bloquea la respuesta y solo dice que
// no hubo respuesta, aunque la clave sea correcta. En la web y en el APK la dirección no cambia.
export const APP_PROXY_PREFIX = '/__nube__/';
export function routeUrl(url, where = globalThis.location) {
  if (!where || where.protocol !== 'app:') return url;
  let target;
  try { target = new URL(url); } catch { return url; }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return url;
  return `${where.origin}${APP_PROXY_PREFIX}${target.protocol.slice(0, -1)}/${target.host}${target.pathname}${target.search}`;
}

// Red de seguridad del puente: si el puente rechaza la solicitud por algo suyo (400 o 405 con su marca,
// por ejemplo no poder leer el cuerpo) o ni siquiera contesta (TypeError), el mismo intento se repite
// directo. Así la conexión funciona si funciona el puente o si el Worker admite app://escena. Un 502 del
// puente (no pudo llegar a la nube) no se repite: ya lo intentó por dos vías y su mensaje explica la causa.
const BRIDGE_HEADER = 'x-escena-puente';
const bridgeRefused = response => (response.status === 400 || response.status === 405) && response.headers.has(BRIDGE_HEADER);

// Servicios que ya contestaron alguna vez desde esta página: si uno falla después, no es un problema de origen.
const reached = new Set();
const originOf = url => { try { return new URL(url).origin; } catch { return ''; } };

// Un fetch que falla con TypeError no dice por qué: sin internet, servicio caído o respuesta bloqueada
// por CORS se ven igual. Una solicitud «no-cors» no está sujeta a CORS: si esa sí llega, la nube está
// ahí y lo que se bloquea es la respuesta, casi siempre por un origen que falta en ALLOWED_ORIGINS.
async function serviceAnswers(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    await fetch(new URL('/v1/ping', url).href, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: controller.signal });
    return true;
  } catch { return false; } finally { clearTimeout(timer); }
}

async function explainNetworkFailure(url, failure, direct = false) {
  const where = globalThis.location;
  const origin = where && where.origin && where.origin !== 'null' ? where.origin : '';
  const target = originOf(url);
  // Por el puente (app de escritorio) CORS no interviene; solo si se intentó directo puede ser el origen.
  if (!origin || !target || target === origin || reached.has(target) || (routeUrl(url) !== url && !direct)) return failure;
  if (!await serviceAnswers(url)) return failure;
  const error = new Error(`La nube respondió, pero el navegador bloqueó la respuesta. Lo más probable es que el origen de Escena (${origin}) no esté en ALLOWED_ORIGINS del Worker de Cloudflare: agrégalo (separado por comas) y vuelve a publicar el Worker. Si ya está, el Worker puede estar fallando.`);
  return Object.assign(error, { code: 'CORS', origin, attempts: failure.attempts });
}

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
      let timedOut = false, failure, direct = false;
      const timeout = setTimeout(() => { timedOut = true; abort(); }, 180000);
      const send = target => fetch(target, {
        method, mode: 'cors', cache: 'no-store', credentials: 'omit', redirect: 'error',
        signal: controller.signal, headers: requestHeaders, body,
      });
      try {
        const routed = routeUrl(url);
        let response;
        try {
          response = await send(routed);
          if (routed !== url && bridgeRefused(response)) { direct = true; response = await send(url); }
        } catch (error) {
          // El puente ni contestó: la app todavía puede hablar con la nube directamente.
          if (routed === url || direct || !(error instanceof TypeError) || controller.signal.aborted) throw error;
          direct = true;
          response = await send(url);
        }
        reached.add(originOf(url));
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
      if (failure.code === 'NETWORK' && attempt === maxAttempts && !signal?.aborted) failure = await explainNetworkFailure(url, failure, direct);
      const retryable = failure.code === 'NETWORK' || failure.code === 'TIMEOUT' || failure.status === 408 || failure.status === 429 || failure.status >= 500;
      // Un cupo diario conocido o una espera muy larga requieren intervención.
      if (!retryable || failure.code === '1027' || failure.retryAfter > 300000 || attempt === maxAttempts) throw failure;
      const delay = Math.max(failure.retryAfter || 0, Math.min(30000, 1000 * 2 ** (attempt - 1)));
      onRetry?.({ attempt: attempt + 1, maxAttempts, delay, message: failure.message, status: failure.status });
      await waitForRetry(delay, signal);
    }
  } finally { onRetry?.(null); }
}
