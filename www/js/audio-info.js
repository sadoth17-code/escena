// Read only small container headers. Compressed/unknown formats still use the normal decoder.
const MAX_CHUNKS = 256;
const MAX_HEADER_BYTES = 16384;

const textAt = (data, start, count) => String.fromCharCode(...data.subarray(start, start + count));
const viewOf = data => new DataView(data.buffer, data.byteOffset, data.byteLength);
const validInfo = (channels, duration) => Number.isInteger(channels) && channels > 0 && channels <= 256 && Number.isFinite(duration) && duration > 0;

function headerReader(blob) {
  let consumed = 0;
  return async (offset, length) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || offset + length > blob.size) return null;
    consumed += length;
    if (consumed > MAX_HEADER_BYTES) return null;
    const data = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
    return data.length === length ? data : null;
  };
}

async function readWave(read, header, size) {
  const limit = viewOf(header).getUint32(4, true) + 8;
  if (limit < 12 || limit > size) return null;
  let format = null;
  let dataBytes = 0;
  let offset = 12;
  for (let count = 0; offset < limit && count < MAX_CHUNKS; count++) {
    if (offset + 8 > limit) return null;
    const chunk = await read(offset, 8);
    if (!chunk) return null;
    const id = textAt(chunk, 0, 4);
    const length = viewOf(chunk).getUint32(4, true);
    const start = offset + 8;
    if (start + length > limit) return null;
    if (id === 'fmt ') {
      if (format || length < 16) return null;
      const data = await read(start, Math.min(length, 40));
      if (!data) return null;
      const view = viewOf(data);
      let encoding = view.getUint16(0, true);
      const channels = view.getUint16(2, true);
      const rate = view.getUint32(4, true);
      const byteRate = view.getUint32(8, true);
      const align = view.getUint16(12, true);
      const bits = view.getUint16(14, true);
      if (encoding === 0xfffe) {
        // WAVE_FORMAT_EXTENSIBLE: accept only the standard PCM / IEEE-float GUIDs.
        if (length < 40 || view.getUint16(16, true) < 22 || view.getUint16(16, true) + 18 > length) return null;
        encoding = view.getUint32(24, true);
        const guidTail = [0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113];
        if (guidTail.some((value, index) => data[28 + index] !== value)) return null;
        const validBits = view.getUint16(18, true);
        if (!validBits || validBits > bits) return null;
      }
      if (![1, 3].includes(encoding) || !channels || channels > 256 || !rate || rate > 1000000 || !bits || bits > 64) return null;
      if (encoding === 3 && ![32, 64].includes(bits)) return null;
      if (align !== channels * Math.ceil(bits / 8) || byteRate !== rate * align) return null;
      format = { channels, byteRate, align };
    } else if (id === 'data') {
      dataBytes += length;
    }
    offset = start + length + (length & 1);
    if (offset > limit) return null;
  }
  if (offset !== limit || !format || !dataBytes || dataBytes % format.align) return null;
  const duration = dataBytes / format.byteRate;
  return validInfo(format.channels, duration) ? { channels: format.channels, duration } : null;
}

async function readFlac(read, size) {
  if (size < 42) return null;
  const data = await read(4, 38);
  if (!data || (data[0] & 0x7f) !== 0 || data[1] !== 0 || data[2] !== 0 || data[3] !== 34) return null;
  const view = viewOf(data);
  const minBlock = view.getUint16(4, false);
  const maxBlock = view.getUint16(6, false);
  const rate = data[14] * 4096 + data[15] * 16 + (data[16] >>> 4);
  const channels = ((data[16] >>> 1) & 7) + 1;
  const bits = ((data[16] & 1) << 4) + (data[17] >>> 4) + 1;
  const samples = (data[17] & 15) * 4294967296 + view.getUint32(18, false);
  if (minBlock < 16 || maxBlock < minBlock || !rate || rate > 655350 || bits < 4 || bits > 32) return null;
  const duration = samples / rate;
  return validInfo(channels, duration) ? { channels, duration } : null;
}

function extendedRate(data) {
  const view = viewOf(data);
  const exponent = view.getUint16(8, false);
  if (!exponent || exponent >= 0x7fff) return NaN;
  const mantissa = view.getUint32(10, false) * 4294967296 + view.getUint32(14, false);
  return mantissa * 2 ** (exponent - 16383 - 63);
}

async function readAiff(read, header, size) {
  const limit = viewOf(header).getUint32(4, false) + 8;
  if (limit < 12 || limit > size) return null;
  const compressed = textAt(header, 8, 4) === 'AIFC';
  let format = null;
  let soundBytes = 0;
  let offset = 12;
  for (let count = 0; offset < limit && count < MAX_CHUNKS; count++) {
    if (offset + 8 > limit) return null;
    const chunk = await read(offset, 8);
    if (!chunk) return null;
    const id = textAt(chunk, 0, 4);
    const length = viewOf(chunk).getUint32(4, false);
    const start = offset + 8;
    if (start + length > limit) return null;
    if (id === 'COMM') {
      if (format || length < (compressed ? 22 : 18)) return null;
      const data = await read(start, compressed ? 22 : 18);
      if (!data) return null;
      const view = viewOf(data);
      const channels = view.getUint16(0, false);
      const frames = view.getUint32(2, false);
      const bits = view.getUint16(6, false);
      const rate = extendedRate(data);
      if (!channels || channels > 256 || !frames || !bits || bits > 64 || !Number.isFinite(rate) || rate <= 0 || rate > 1000000) return null;
      if (compressed && !['NONE', 'sowt', 'fl32', 'FL32', 'fl64', 'FL64'].includes(textAt(data, 18, 4))) return null;
      format = { channels, duration: frames / rate, bytes: frames * channels * Math.ceil(bits / 8) };
    } else if (id === 'SSND') {
      if (length < 8) return null;
      const data = await read(start, 8);
      if (!data) return null;
      const skip = viewOf(data).getUint32(0, false);
      if (skip > length - 8) return null;
      soundBytes += length - 8 - skip;
    }
    offset = start + length + (length & 1);
    if (offset > limit) return null;
  }
  if (offset !== limit || !format || soundBytes < format.bytes || !validInfo(format.channels, format.duration)) return null;
  return { channels: format.channels, duration: format.duration };
}

// Returns { channels, duration } in seconds, or null when metadata is unsupported/unreliable.
// Never calls blob.arrayBuffer() or decodeAudioData; at most 16 KiB of headers are read.
export async function readAudioInfo(blob) {
  try {
    if (!blob || !Number.isSafeInteger(blob.size) || blob.size < 12 || typeof blob.slice !== 'function') return null;
    const read = headerReader(blob);
    const header = await read(0, 12);
    if (!header) return null;
    const kind = textAt(header, 0, 4);
    if (kind === 'RIFF' && textAt(header, 8, 4) === 'WAVE') return await readWave(read, header, blob.size);
    if (kind === 'fLaC') return await readFlac(read, blob.size);
    if (kind === 'FORM' && ['AIFF', 'AIFC'].includes(textAt(header, 8, 4))) return await readAiff(read, header, blob.size);
  } catch (error) {
    // Metadata is optional: corrupt/truncated files fall back to the normal preparation path.
    void error;
  }
  return null;
}
