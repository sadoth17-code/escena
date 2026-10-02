const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export async function listZip(blob) {
  const size = blob.size;
  const tailLength = Math.min(size, 65557);
  const tail = new DataView(await blob.slice(size - tailLength, size).arrayBuffer());
  let eocd = -1;
  for (let i = tailLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('El archivo ZIP no es válido');
  const total = tail.getUint16(eocd + 10, true);
  const centralSize = tail.getUint32(eocd + 12, true);
  const centralOffset = tail.getUint32(eocd + 16, true);
  if (centralOffset === 0xffffffff || total === 0xffff) {
    throw new Error('Este ZIP es demasiado grande (ZIP64). Divide las pistas en varios ZIP');
  }
  const central = new DataView(await blob.slice(centralOffset, centralOffset + centralSize).arrayBuffer());
  const decoder = new TextDecoder('utf-8');
  const entries = [];
  let pointer = 0;
  for (let n = 0; n < total && pointer + 46 <= central.byteLength; n++) {
    if (central.getUint32(pointer, true) !== SIG_CENTRAL) break;
    const method = central.getUint16(pointer + 10, true);
    const compressedSize = central.getUint32(pointer + 20, true);
    const size = central.getUint32(pointer + 24, true);
    const nameLength = central.getUint16(pointer + 28, true);
    const extraLength = central.getUint16(pointer + 30, true);
    const commentLength = central.getUint16(pointer + 32, true);
    const headerOffset = central.getUint32(pointer + 42, true);
    const nameBytes = new Uint8Array(central.buffer, central.byteOffset + pointer + 46, nameLength);
    const name = decoder.decode(nameBytes);
    entries.push({ name, method, compressedSize, size, headerOffset, directory: name.endsWith('/') });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export async function extractEntry(blob, entry) {
  const head = new DataView(await blob.slice(entry.headerOffset, entry.headerOffset + 30).arrayBuffer());
  if (head.getUint32(0, true) !== SIG_LOCAL) throw new Error('El archivo ZIP está dañado');
  const nameLength = head.getUint16(26, true);
  const extraLength = head.getUint16(28, true);
  const start = entry.headerOffset + 30 + nameLength + extraLength;
  const data = blob.slice(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Este navegador no puede abrir ZIP comprimidos. Actualiza el navegador o usa archivos sueltos');
    }
    return new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
  }
  throw new Error('Este ZIP usa una compresión no soportada');
}
