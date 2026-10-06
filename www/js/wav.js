// Lectura directa de archivos WAV, sin pasar por decodeAudioData.
//
// Las pistas de un multitrack casi siempre son WAV sin comprimir. decodeAudioData las trata como cualquier otro
// formato: abre el contenedor, convierte y deja varias copias de la pista en memoria a la vez, y una canción de
// doce pistas de unos 85 MB cada una tarda en cargar aunque dentro no haya nada que descomprimir. Aquí el archivo
// se lee en bloques y cada bloque se convierte directamente a los canales del AudioBuffer mientras ya se está
// leyendo el siguiente: el tiempo pasa a ser el de leer el disco, y la memoria que se usa de más mientras tanto
// son unos pocos megas en lugar de varias copias de la pista entera.
//
// Solo se hace cargo de lo que puede leer igual de bien: WAV PCM de 8, 16, 24 o 32 bits o flotante de 32 o 64
// bits, mono o estéreo, con la misma frecuencia que el motor de audio. Con cualquier otra cosa devuelve null y
// quien llama sigue con decodeAudioData, que también remuestrea y entiende el resto de formatos.

// Bloques grandes: cada lectura de un archivo guardado en el navegador es un viaje de ida y vuelta, y con bloques
// de 1 MB una canción de 12 pistas y 1 GB tardaba un 40 % más que con bloques de 8 MB.
export const CHUNK_BYTES = 8 * 1024 * 1024;
// La cabecera de un WAV cabe casi siempre en unos cientos de bytes; se lee de una vez este tramo del principio.
const HEADER_BYTES = 64 * 1024;
const MAX_CHUNKS_IN_HEADER = 64;
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export class WavAborted extends Error {
  constructor() {
    super('Lectura cancelada');
    this.name = 'WavAborted';
  }
}

// Cede el hilo principal entre bloque y bloque para que la pantalla y los controles sigan respondiendo.
function yieldNow() {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });
}

const tag = (view, offset) => String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));

// Cabecera de un WAV: { code, channels, rate, bits, blockAlign, dataStart, dataLength } o null si no se entiende.
export async function readWavHeader(blob) {
  try {
    if (!blob || typeof blob.slice !== 'function' || blob.size < 44) return null;
    const first = await blob.slice(0, Math.min(blob.size, HEADER_BYTES)).arrayBuffer();
    // `length` bytes desde `start`: del tramo ya leído si caben, y si no con otra lectura.
    const bytesAt = async (start, length) => {
      if (start + length <= first.byteLength) return new DataView(first, start, length);
      return new DataView(await blob.slice(start, Math.min(start + length, blob.size)).arrayBuffer());
    };
    const top = await bytesAt(0, 12);
    // RF64 (más de 4 GB) y cualquier otro contenedor se dejan a decodeAudioData.
    if (top.byteLength < 12 || tag(top, 0) !== 'RIFF' || tag(top, 8) !== 'WAVE') return null;
    let position = 12;
    let format = null;
    for (let guard = 0; guard < MAX_CHUNKS_IN_HEADER && position + 8 <= blob.size; guard++) {
      const head = await bytesAt(position, 8);
      if (head.byteLength < 8) return null;
      const id = tag(head, 0);
      const size = head.getUint32(4, true);
      const body = position + 8;
      if (id === 'fmt ') {
        if (size < 16) return null;
        const f = await bytesAt(body, Math.min(size, 40));
        if (f.byteLength < 16) return null;
        let code = f.getUint16(0, true);
        // WAVE_FORMAT_EXTENSIBLE: el formato de verdad son los dos primeros bytes del identificador al final.
        if (code === 0xfffe) {
          if (size < 40 || f.byteLength < 26) return null;
          code = f.getUint16(24, true);
        }
        format = { code, channels: f.getUint16(2, true), rate: f.getUint32(4, true), blockAlign: f.getUint16(12, true), bits: f.getUint16(14, true) };
      } else if (id === 'data') {
        if (!format) return null;
        const remaining = blob.size - body;
        // Las cabeceras de grabaciones sin terminar traen 0 o 0xFFFFFFFF; un archivo cortado trae más de lo que hay.
        const length = size === 0 || size === 0xffffffff || size > remaining ? remaining : size;
        return { ...format, dataStart: body, dataLength: length };
      }
      position = body + size + (size & 1);
    }
  } catch (error) {
    void error;
  }
  return null;
}

function supported(info) {
  if (!LITTLE_ENDIAN || !info || info.channels < 1 || info.channels > 2) return false;
  if (info.bits % 8 !== 0 || info.blockAlign !== info.channels * (info.bits / 8)) return false;
  if (info.code === 1) return info.bits === 8 || info.bits === 16 || info.bits === 24 || info.bits === 32;
  if (info.code === 3) return info.bits === 32 || info.bits === 64;
  return false;
}

// Devuelve (raw, canales, desde, cuántos) => void: convierte `n` fotogramas del bloque a los canales de salida.
function makeConverter(info) {
  const stereo = info.channels === 2;
  const samples = (n) => n * info.channels;
  if (info.code === 3 && info.bits === 32) {
    return (raw, outs, at, n) => {
      const src = new Float32Array(raw, 0, samples(n));
      if (!stereo) {
        outs[0].set(src, at);
        return;
      }
      const left = outs[0];
      const right = outs[1];
      for (let i = 0, j = at, k = 0; i < n; i++, j++, k += 2) {
        left[j] = src[k];
        right[j] = src[k + 1];
      }
    };
  }
  if (info.code === 3) {
    return (raw, outs, at, n) => {
      const src = new Float64Array(raw, 0, samples(n));
      const left = outs[0];
      const right = outs[1];
      for (let i = 0, j = at, k = 0; i < n; i++, j++, k += info.channels) {
        left[j] = src[k];
        if (stereo) right[j] = src[k + 1];
      }
    };
  }
  if (info.bits === 16) {
    const scale = 1 / 32768;
    return (raw, outs, at, n) => {
      const src = new Int16Array(raw, 0, samples(n));
      const left = outs[0];
      const right = outs[1];
      for (let i = 0, j = at, k = 0; i < n; i++, j++, k += info.channels) {
        left[j] = src[k] * scale;
        if (stereo) right[j] = src[k + 1] * scale;
      }
    };
  }
  if (info.bits === 32) {
    const scale = 1 / 2147483648;
    return (raw, outs, at, n) => {
      const src = new Int32Array(raw, 0, samples(n));
      const left = outs[0];
      const right = outs[1];
      for (let i = 0, j = at, k = 0; i < n; i++, j++, k += info.channels) {
        left[j] = src[k] * scale;
        if (stereo) right[j] = src[k + 1] * scale;
      }
    };
  }
  if (info.bits === 24) {
    const scale = 1 / 8388608;
    return (raw, outs, at, n) => {
      const src = new Uint8Array(raw, 0, samples(n) * 3);
      const left = outs[0];
      const right = outs[1];
      for (let i = 0, j = at, p = 0; i < n; i++, j++) {
        left[j] = (((src[p] | (src[p + 1] << 8) | (src[p + 2] << 16)) << 8) >> 8) * scale;
        p += 3;
        if (stereo) {
          right[j] = (((src[p] | (src[p + 1] << 8) | (src[p + 2] << 16)) << 8) >> 8) * scale;
          p += 3;
        }
      }
    };
  }
  // PCM de 8 bits: sin signo, el silencio es 128.
  const scale = 1 / 128;
  return (raw, outs, at, n) => {
    const src = new Uint8Array(raw, 0, samples(n));
    const left = outs[0];
    const right = outs[1];
    for (let i = 0, j = at, k = 0; i < n; i++, j++, k += info.channels) {
      left[j] = (src[k] - 128) * scale;
      if (stereo) right[j] = (src[k + 1] - 128) * scale;
    }
  };
}

// Lee `blob` como WAV y devuelve un AudioBuffer con la frecuencia del motor, o null si no se puede hacer así.
// `cancelled` es una función que devuelve true cuando ya no hace falta el resultado (entonces lanza WavAborted).
// `notes` (opcional) recibe `rate` cuando el archivo es un WAV que se sabría leer pero está a otra frecuencia que el
// motor de audio: lo remuestrea decodeAudioData, que es más lento, y así quien llama puede explicarlo.
export async function decodeWav(blob, ctx, { cancelled = null, notes = null } = {}) {
  const info = await readWavHeader(blob);
  if (!info || !supported(info)) return null;
  if (info.rate !== ctx.sampleRate) {
    if (notes) notes.rate = info.rate;
    return null;
  }
  const frames = Math.floor(info.dataLength / info.blockAlign);
  if (frames < 1) return null;
  if (cancelled && cancelled()) throw new WavAborted();
  const buffer = ctx.createBuffer(info.channels, frames, info.rate);
  const outs = [];
  for (let c = 0; c < info.channels; c++) outs.push(buffer.getChannelData(c));
  const convert = makeConverter(info);
  const perChunk = Math.max(1, Math.floor(CHUNK_BYTES / info.blockAlign));
  const chunks = Math.ceil(frames / perChunk);
  const read = (index) => {
    const first = index * perChunk;
    const n = Math.min(perChunk, frames - first);
    const start = info.dataStart + first * info.blockAlign;
    const promise = blob.slice(start, start + n * info.blockAlign).arrayBuffer();
    // Si se cancela o falla otra cosa antes de esperarla, que no quede un rechazo sin atender.
    promise.catch(() => {});
    return { first, n, promise };
  };
  let current = read(0);
  for (let index = 0; index < chunks; index++) {
    const next = index + 1 < chunks ? read(index + 1) : null;
    const raw = await current.promise;
    if (raw.byteLength !== current.n * info.blockAlign) throw new Error('El archivo terminó antes de lo que decía su cabecera');
    if (cancelled && cancelled()) throw new WavAborted();
    convert(raw, outs, current.first, current.n);
    current = next;
    if (next) await yieldNow();
  }
  return buffer;
}
