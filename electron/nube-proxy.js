'use strict';

// Puente entre la app de escritorio (Windows y Mac) y la nube de Escena (el Worker de Cloudflare).
//
// La ventana se sirve desde app://escena. Un fetch directo a https://….workers.dev sería una
// solicitud entre orígenes: el Worker solo la acepta si «app://escena» figura en su variable
// ALLOWED_ORIGINS y, si falta, el navegador bloquea la respuesta sin decir por qué. En pantalla se
// veía como «No se pudo recibir una respuesta de la nube» aunque la clave fuera correcta.
//
// Aquí las solicitudes salen del proceso principal, que no es un navegador: no llevan Origin y CORS
// no interviene. La clave sigue viajando en la cabecera Authorization y el Worker la comprueba igual
// que siempre; este puente no la guarda ni la registra.
//
// La página pide  app://escena/__nube__/<https|http>/<host>/<ruta>?<consulta>
// y el puente la envía a  <https|http>://<host>/<ruta>?<consulta>   (ver routeUrl en cloud-request.js).

const PREFIX = '/__nube__/';
// Solo se reenvían las cabeceras que la nube usa; nada de cookies, Origin ni Referer.
const SEND_HEADERS = ['authorization', 'content-type', 'range', 'x-chunk-sha256', 'accept'];
// Cabeceras que describen una codificación que ya no corresponde al cuerpo que se entrega.
const SKIP_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'proxy-authenticate', 'set-cookie', 'set-cookie2', 'trailer', 'upgrade']);
const NULL_BODY = new Set([101, 204, 205, 304]);
const METHODS = new Set(['GET', 'POST', 'PUT']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const HOST = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:]+\])(?::\d{1,5})?$/i;
const TIMEOUT_MS = 190000;

// Las respuestas que fabrica el propio puente (y no la nube) llevan esta marca. La página la usa para
// saber que el puente rechazó la solicitud y puede probar la conexión directa (ver cloud-request.js).
const BRIDGE_HEADER = 'x-escena-puente';

function failure(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', [BRIDGE_HEADER]: 'error' },
  });
}

// Devuelve null si la dirección no es del puente, { error } si lo es pero no es válida o
// { target: URL } con la dirección real de la nube.
function parseTarget(href) {
  let url;
  try {
    url = new URL(href);
  } catch (error) {
    return null;
  }
  if (!url.pathname.startsWith(PREFIX)) return null;
  const parts = url.pathname.slice(PREFIX.length).split('/');
  const scheme = parts.shift();
  const host = parts.shift();
  if (!['https', 'http'].includes(scheme) || !host || !HOST.test(host)) return { error: 'Dirección de la nube inválida' };
  let target;
  try {
    target = new URL(`${scheme}://${host}/${parts.join('/')}${url.search}`);
  } catch (error) {
    return { error: 'Dirección de la nube inválida' };
  }
  if (target.host !== host.toLowerCase() || target.username || target.password || target.hash) return { error: 'Dirección de la nube inválida' };
  // En claro solo se admite la máquina local (pruebas); la nube real va siempre por HTTPS.
  if (scheme === 'http' && !LOOPBACK.has(target.hostname)) return { error: 'La nube debe usar HTTPS' };
  return { target };
}

function originRefused(payload) {
  try {
    return JSON.parse(Buffer.from(payload).toString('utf8')).error === 'Origen no permitido';
  } catch (error) {
    return false;
  }
}

// fetch: función con la firma de fetch (en la app, net.fetch de Electron: respeta el proxy del
// sistema). fallbackFetch: segunda vía (fetch de Node) que solo se usa si la primera falla sin dar
// respuesta o hubiera añadido un Origin que el Worker rechaza.
function createNubeProxy({ fetch: send, fallbackFetch = null, timeoutMs = TIMEOUT_MS }) {
  return async function nubeProxy(request) {
    const parsed = parseTarget(request.url);
    if (!parsed || parsed.error) return failure(400, parsed ? parsed.error : 'Solicitud inválida');
    if (!METHODS.has(request.method)) return failure(405, 'Método no permitido');
    const headers = {};
    for (const name of SEND_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers[name] = value;
    }
    let body;
    try {
      body = request.method === 'GET' ? undefined : Buffer.from(await request.arrayBuffer());
    } catch (error) {
      return failure(400, 'No se pudo leer lo que la app quería enviar');
    }

    const attempt = async (sender) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const relay = () => controller.abort();
      const outer = request.signal;
      if (outer) {
        if (outer.aborted) controller.abort();
        else outer.addEventListener('abort', relay, { once: true });
      }
      try {
        const upstream = await sender(parsed.target.href, { method: request.method, headers, body, redirect: 'error', signal: controller.signal });
        const payload = NULL_BODY.has(upstream.status) ? null : await upstream.arrayBuffer();
        return { upstream, payload };
      } finally {
        clearTimeout(timer);
        if (outer) outer.removeEventListener('abort', relay);
      }
    };

    try {
      let result;
      let usedFallback = false;
      try {
        result = await attempt(send);
      } catch (error) {
        // Si la primera vía falla sin llegar a dar respuesta (y no es una cancelación ni el tiempo agotado), se prueba la
        // segunda. Repetir una solicitud de la nube es seguro: las partes llevan su huella y la app ya las reintenta.
        if (!fallbackFetch || (error && error.name === 'AbortError') || (request.signal && request.signal.aborted)) throw error;
        usedFallback = true;
        result = await attempt(fallbackFetch);
      }
      if (!usedFallback && fallbackFetch && result.upstream.status === 403 && originRefused(result.payload)) result = await attempt(fallbackFetch);
      const out = new Headers();
      for (const [name, value] of result.upstream.headers) if (!SKIP_HEADERS.has(name.toLowerCase())) out.append(name, value);
      out.set('cache-control', 'no-store');
      return new Response(result.payload, { status: result.upstream.status, headers: out });
    } catch (error) {
      const cause = (error && error.cause && (error.cause.code || error.cause.message)) || (error && error.name === 'AbortError' ? 'tiempo de espera agotado' : error && error.message) || 'error de red';
      return failure(502, `La app no pudo conectarse con la nube (${cause}). Revisa la conexión a internet.`);
    }
  };
}

module.exports = { PREFIX, BRIDGE_HEADER, parseTarget, createNubeProxy };
