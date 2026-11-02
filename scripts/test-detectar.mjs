// Detección automática de acordes (www/js/detect.js): FFT, notas del espectro, afinación, y canciones sintéticas
// con acordes conocidos (bajo, teclado, guitarra, melodía y batería, con armónicos y ruido).
// Ejecutar: node --test scripts/test-detectar.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { SONGS, chordInfo, makeSong, songInfo, wavBytes } from './sinte-prueba.mjs';

const urls = new Map();
async function moduleURL(name) {
  if (urls.has(name)) return urls.get(name);
  let source = await readFile(new URL(`../www/js/${name}`, import.meta.url), 'utf8');
  for (const dependency of [...source.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)]) {
    source = source.replace(dependency[0], `from ${JSON.stringify(await moduleURL(dependency[1]))}`);
  }
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  urls.set(name, url);
  return url;
}
const detect = await import(await moduleURL('detect.js'));
const chart = await import(await moduleURL('chart.js'));

// ───────────── Piezas sueltas ─────────────

test('la FFT coincide con la transformada directa y coloca un tono en su casilla', () => {
  const n = 64;
  const re = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1) + (i % 5) / 9);
  const im = new Float64Array(n);
  const expectedRe = new Float64Array(n);
  const expectedIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    for (let t = 0; t < n; t++) {
      const angle = (-2 * Math.PI * k * t) / n;
      expectedRe[k] += re[t] * Math.cos(angle);
      expectedIm[k] += re[t] * Math.sin(angle);
    }
  }
  detect.fft(re, im);
  for (let k = 0; k < n; k++) {
    assert.ok(Math.abs(re[k] - expectedRe[k]) < 1e-9 && Math.abs(im[k] - expectedIm[k]) < 1e-9, `casilla ${k}`);
  }
  const tone = Float64Array.from({ length: 256 }, (_, i) => Math.cos((2 * Math.PI * 20 * i) / 256));
  const zero = new Float64Array(256);
  detect.fft(tone, zero);
  const mags = Array.from(tone, (v, k) => Math.hypot(v, zero[k]));
  assert.equal(mags.indexOf(Math.max(...mags.slice(0, 128))), 20);
  assert.throws(() => detect.fft(new Float64Array(100), new Float64Array(100)), /potencia de 2/);
});

test('al bajar la frecuencia de muestreo se conserva lo grave y se quita lo que no cabe', async () => {
  const rate = 44100;
  const tone = hz => Float32Array.from({ length: rate }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate));
  const rms = (data, from = 2000, to = data.length - 2000) => { let s = 0; for (let i = from; i < to; i++) s += data[i] * data[i]; return Math.sqrt(s / (to - from)); };
  const low = await detect.decimate(tone(1000), rate);
  assert.equal(low.rate, 22050);
  assert.equal(low.data.length, rate / 2);
  assert.ok(Math.abs(rms(low.data) - Math.SQRT1_2) < 0.03, `1 kHz conserva su nivel (${rms(low.data)})`);
  const high = await detect.decimate(tone(15000), rate);
  assert.ok(rms(high.data) < 0.03, `15 kHz se elimina en vez de plegarse (${rms(high.data)})`);
  assert.equal((await detect.decimate(new Float32Array(10), 22050)).rate, 22050, 'a 22 kHz no hace nada');
  assert.ok((await detect.decimate(new Float32Array(100000), 48000, 22050, { cancelled: () => true })) === null, 'se puede cancelar');
});

test('del espectro salen las notas con su afinación', () => {
  const size = 8192;
  const rate = 22050;
  const spectrum = (freqs) => {
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
      for (const [hz, amp] of freqs) re[i] += amp * Math.sin((2 * Math.PI * hz * i) / rate) * w;
    }
    detect.fft(re, im);
    return Float32Array.from({ length: size / 2 + 1 }, (_, k) => (Math.hypot(re[k], im[k]) * 2) / size);
  };
  const treble = new Float32Array(60);
  const bass = new Float32Array(60);
  const best = vector => vector.indexOf(Math.max(...vector));
  // La4 = 440 Hz: nota 9 (La), casilla 45, justo sobre la nota.
  const energy = detect.spectrumToFine(spectrum([[440, 1]]), rate / size, treble, bass);
  assert.ok(energy > 0);
  assert.equal(best(treble), 45);
  assert.equal(bass.reduce((a, b) => a + b, 0), 0, '440 Hz no es grave');
  // Mi2 = 82.41 Hz suena como bajo y su nota es Mi (4).
  detect.spectrumToFine(spectrum([[82.41, 1]]), rate / size, treble, bass);
  assert.equal(Math.round(best(bass) / 5), 4);
  // Una nota 30 centésimas alta cae entre casillas, del lado de arriba.
  detect.spectrumToFine(spectrum([[440 * 2 ** (0.3 / 12), 1]]), rate / size, treble, bass);
  assert.ok(best(treble) === 46 || best(treble) === 47, `casilla ${best(treble)}`);
  // El ruido sin picos no aporta.
  const noise = Float32Array.from({ length: size / 2 + 1 }, () => 0.001);
  assert.equal(detect.spectrumToFine(noise, rate / size, treble, bass), 0);
});

test('la afinación se estima y se corrige', () => {
  const make = (offset, spread = 0) => {
    const frames = new detect.FrameBuffer({ half: 0.1, hop: 0.1, capacity: 4 });
    const treble = new Float32Array(60);
    const bass = new Float32Array(60);
    for (let f = 0; f < 50; f++) {
      treble.fill(0);
      for (const pc of [0, 4, 7]) {
        const at = (pc + offset + (spread ? ((f * 37 + pc * 11) % 100) / 100 - 0.5 : 0)) * 5;
        const wrapped = ((at % 60) + 60) % 60;
        const i0 = Math.floor(wrapped);
        treble[i0 % 60] += 1 - (wrapped - i0);
        treble[(i0 + 1) % 60] += wrapped - i0;
      }
      frames.push(f * 0.1, treble, bass, 3);
    }
    return frames;
  };
  assert.ok(Math.abs(detect.estimateTuning(make(0.3)) - 0.3) < 0.03);
  assert.ok(Math.abs(detect.estimateTuning(make(-0.2)) + 0.2) < 0.03);
  assert.equal(detect.estimateTuning(make(0, true)), 0, 'notas repartidas al azar: no hay afinación que corregir');
  const folded = detect.foldFrames(make(0.3), 0.3);
  const sums = Array.from({ length: 12 }, (_, c) => { let s = 0; for (let f = 0; f < 50; f++) s += folded.treble[f * 12 + c]; return s; });
  const total = sums.reduce((a, b) => a + b, 0);
  assert.ok((sums[0] + sums[4] + sums[7]) / total > 0.85, 'tras corregir, casi toda la energía queda en Do, Mi y Sol');
  const unfixed = detect.foldFrames(make(0.3), 0);
  const loose = Array.from({ length: 12 }, (_, c) => { let s = 0; for (let f = 0; f < 50; f++) s += unfixed.treble[f * 12 + c]; return s; });
  assert.ok((loose[0] + loose[4] + loose[7]) / total < (sums[0] + sums[4] + sums[7]) / total, 'sin corregir queda más repartida');
});

test('qué pistas son armónicas, cuáles bajo y cuáles se dejan fuera', () => {
  for (const name of ['Bass', 'Bajo', 'Synth Bass', 'Bajo eléctrico']) assert.equal(detect.classifyTrack(name), 'bass', name);
  for (const name of ['Click', 'Guía', 'Guide', 'Batería', 'Drums', 'Bombo', 'Kick', 'Voz', 'Vox', 'Coros', 'Backing Vocals', 'Percusión', 'Loop', 'Cue']) assert.equal(detect.classifyTrack(name), 'skip', name);
  for (const name of ['Teclado', 'Keys', 'Pad', 'Guitarra 1', 'EG 2', 'Piano', 'Strings', 'Órgano']) assert.equal(detect.classifyTrack(name), 'harm', name);
  assert.equal(detect.classifyTrack('Bass Drum'), 'skip');
  assert.equal(detect.classifyTrack(), 'harm');
});

test('un compás se escribe con los acordes que tiene, sin repetir lo que se sostiene', () => {
  assert.equal(detect.barText(['G', 'G', 'G']), 'G');
  assert.equal(detect.barText(['G', 'G', 'D']), 'G . D');
  assert.equal(detect.barText(['G', 'G', 'G', 'D', 'D', 'D']), 'G D');
  assert.equal(detect.barText(['G', 'G', 'D', 'D', 'C', 'C']), 'G D C');
  assert.equal(detect.barText(['G', 'D']), 'G D');
  assert.equal(detect.barText(['G', 'G']), 'G');
  assert.equal(detect.barText(['G', 'G', 'G', 'G']), 'G');
  assert.equal(detect.barText(['C', 'C', 'G', 'G']), 'C G');
  assert.equal(detect.barText(['C', 'C', 'C', 'D']), 'C . . D');
  assert.equal(detect.barText(['C', 'G', 'G', 'G']), 'C G . .');
  assert.equal(detect.barText(['C', 'D', 'E', 'F']), 'C D E F');
  assert.equal(detect.barText(['', '', '', '']), '');
  assert.equal(detect.barText(['', '', 'C', 'C']), '. C');
});

test('el compás se divide según su numerador', () => {
  assert.deepEqual([2, 3, 4, 5, 6, 9, 12, 7, undefined].map(detect.meterSlots), [2, 3, 4, 5, 2, 3, 4, 4, 4]);
});

test('los cuartos de compás siguen la rejilla y el último compás dura como el anterior', () => {
  const edges = detect.slotEdges({ bars: [0, 2, 4, 6], duration: 9 });
  assert.equal(edges.length, 4 * 4 + 1);
  assert.deepEqual(edges.slice(0, 5), [0, 0.5, 1, 1.5, 2]);
  assert.equal(edges[edges.length - 1], 8, 'la cola de audio después del último compás no se estira en el compás');
  assert.equal(detect.slotEdges({ bars: [], duration: 5 }).length, 0);
});

// ───────────── Canciones sintéticas ─────────────

const cache = new Map();
async function frames(name, options = {}, mode = 'stems') {
  const key = JSON.stringify([name, options, mode]);
  if (cache.has(key)) return cache.get(key);
  const song = makeSong({ ...SONGS[name], rate: 22050, seed: 11, ...options });
  let result;
  if (mode === 'mix') {
    result = await detect.analyzePCM(song.stems.mix, song.rate);
  } else {
    const harm = new detect.PCMGroup();
    const bass = new detect.PCMGroup();
    harm.add(song.stems.keys, song.rate);
    harm.add(song.stems.guitar, song.rate);
    bass.add(song.stems.bass, song.rate);
    result = await detect.framesFromGroups({ harm, bass });
  }
  song.stems = null; // el audio ya no hace falta y ocupa decenas de MB
  const entry = { song, frames: result };
  cache.set(key, entry);
  return entry;
}

const basic = symbol => {
  const m = /^([A-G][#b]?)(maj7|m7|m|7|sus4)?(?:\/[A-G][#b]?)?$/.exec(symbol);
  return m ? m[1] + (m[2] === 'm' || m[2] === 'm7' ? 'm' : '') : symbol;
};

function score(song, result, { extended = false, rootsOnly = false } = {}) {
  let ok = 0;
  let total = 0;
  result.bars.forEach((bar, index) => {
    for (let slot = 0; slot < bar.symbols.length; slot++) {
      const wanted = song.truth[index - song.silentBars]?.[slot];
      if (wanted === undefined) continue;
      total++;
      let got = extended ? bar.symbols[slot] : basic(bar.symbols[slot]); // en las triadas, la inversión no cuenta
      let want = extended ? wanted : basic(wanted);
      if (rootsOnly) { got = (got.match(/^[A-G][#b]?/) || [''])[0]; want = (want.match(/^[A-G][#b]?/) || [''])[0]; }
      if (got === want || (rootsOnly && got && want && chordInfo(got).root === chordInfo(want).root)) ok++;
    }
  });
  return ok / total;
}

test('canciones con pistas sueltas: acierta casi todos los acordes y el tono', async () => {
  for (const [name, key] of [['sol', 'G'], ['lam', 'Am'], ['sib', 'Bb'], ['dos', 'G'], ['ritmo', 'E']]) {
    const { song, frames: f } = await frames(name);
    const result = detect.detectChart(f, songInfo(song));
    const accuracy = score(song, result);
    assert.ok(accuracy >= (name === 'dos' ? 0.9 : 0.97), `${name}: ${(accuracy * 100).toFixed(1)} %`);
    if (name !== 'dos') assert.equal(result.key.text, key, `tono de ${name}`);
    assert.equal(result.bars.length, song.bars.length);
    assert.ok(result.covered > 0.95);
  }
});

test('con la mezcla completa (voces, batería y todo junto) también acierta', async () => {
  for (const name of ['sol', 'lam', 'sib', 'ritmo']) {
    const { song, frames: f } = await frames(name, {}, 'mix');
    const accuracy = score(song, detect.detectChart(f, songInfo(song)));
    assert.ok(accuracy >= 0.96, `${name}: ${(accuracy * 100).toFixed(1)} %`);
  }
});

test('una grabación desafinada se corrige sola', async () => {
  for (const cents of [-35, 30, 45]) {
    const { song, frames: f } = await frames('sol', { detune: cents }, 'mix');
    const result = detect.detectChart(f, songInfo(song));
    assert.ok(score(song, result) >= 0.96, `${cents} centésimas: ${(score(song, result) * 100).toFixed(1)} %`);
    assert.ok(Math.abs(result.tuning * 100 - cents) < 12 || Math.abs(Math.abs(result.tuning * 100 - cents) - 100) < 12, `afinación estimada ${Math.round(result.tuning * 100)}`);
  }
});

test('si la rejilla de compases va algo desfasada del audio, sigue acertando', async () => {
  const { song, frames: f } = await frames('lam');
  for (const shift of [-0.2, 0.15, 0.2]) {
    const info = songInfo(song);
    info.bars = info.bars.map(t => t + shift);
    const accuracy = score(song, detect.detectChart(f, info));
    assert.ok(accuracy >= 0.9, `desfase ${shift}: ${(accuracy * 100).toFixed(1)} %`);
  }
});

test('un silencio al principio no inventa acordes', async () => {
  const { song, frames: f } = await frames('sol', { silentBars: 2 });
  // Como hace Escena cuando el primer marcador no está en el compás 1: una sección «Inicio» hasta el marcador.
  const info = { ...songInfo(song), sections: [{ n: 'Inicio', b: 1 }, ...song.sections] };
  const result = detect.detectChart(f, info);
  assert.deepEqual(result.bars.slice(0, 2).map(bar => bar.text), ['', '']);
  assert.ok(score(song, result) >= 0.97);
  assert.match(result.text, /^Tono: G\n\n\[Inicio\]\n\| {8}\| {8}\|\n\n\[Intro\]\n\| G /);
});

test('con acordes de potencia (sin tercera) las raíces salen bien aunque mayor o menor sea dudoso', async () => {
  const { song, frames: f } = await frames('sol', { power: true });
  const result = detect.detectChart(f, songInfo(song));
  assert.ok(score(song, result, { rootsOnly: true }) >= 0.95, `raíces: ${(score(song, result, { rootsOnly: true }) * 100).toFixed(1)} %`);
  assert.ok(score(song, result) >= 0.8, `completo: ${(score(song, result) * 100).toFixed(1)} %`);
});

test('las 7ª solo se marcan si se piden, y sin inventarlas en las triadas', async () => {
  const { song, frames: f } = await frames('sol');
  const plain = detect.detectChart(f, songInfo(song));
  assert.ok(!/7|sus/.test(plain.text.replace(/\[[^\]]*\]/g, '')), 'por defecto solo mayores y menores');
  const extended = detect.detectChart(f, songInfo(song), { extended: true });
  assert.ok(!/maj7|7|sus4/.test(extended.text.replace(/\[[^\]]*\]/g, '')), 'las triadas no se vuelven acordes con 7ª');
  const jazz = await frames('jazz');
  const withSevenths = detect.detectChart(jazz.frames, songInfo(jazz.song), { extended: true });
  assert.ok(score(jazz.song, withSevenths, { extended: true }) >= 0.7, `jazz: ${(score(jazz.song, withSevenths, { extended: true }) * 100).toFixed(1)} %`);
  for (const wanted of ['Am7', 'Dm7', 'G7']) assert.ok(withSevenths.text.includes(wanted), `aparece ${wanted}`);
});

test('el texto que sale lo lee el cifrado: mismas secciones, compases y acordes', async () => {
  const { song, frames: f } = await frames('sol');
  const info = songInfo(song);
  const result = detect.detectChart(f, info);
  assert.match(result.text, /^Tono: G\n/);
  const layout = chart.buildLayout(info, chart.parseChart(result.text));
  assert.ok(layout.hasChords);
  assert.equal(layout.items.length, info.sections.length);
  layout.items.forEach((item, index) => {
    const wanted = (info.sections[index + 1] ? info.sections[index + 1].b : info.bars.length + 1) - info.sections[index].b;
    assert.equal(item.span, wanted, `la sección ${item.name} cubre ${wanted} compases`);
  });
  // Cada compás del cifrado lee los mismos acordes que el detector.
  let bar = 0;
  for (const item of layout.items) {
    for (const parsed of item.bars.slice(0, item.span)) {
      const named = parsed.slots.map(slot => (slot.chord ? chart.formatChord(slot.chord, {}) : ''));
      // Un compás con 1, 2 o 4 acordes los reparte en cuatro cuartos iguales.
      const read = named.length === 1 ? Array(4).fill(named[0]) : named.length === 2 ? [named[0], named[0], named[1], named[1]] : named;
      const got = result.bars[bar].symbols;
      assert.deepEqual(read.map(r => r.replace('♯', '#')), got.map(g => g.replace('♯', '#')), `compás ${bar + 1}`);
      bar++;
    }
  }
  assert.equal(bar, info.bars.length);
});

test('una sección que se repite igual se escribe una vez, y una que cambia se escribe cada vez', async () => {
  const { song, frames: f } = await frames('sol');
  const result = detect.detectChart(f, songInfo(song));
  assert.equal((result.text.match(/\[Verso\]/g) || []).length, 1, 'el verso se repite idéntico');
  assert.equal((result.text.match(/\[Coro\]/g) || []).length, 2, 'el último coro termina distinto');
  const off = detect.detectChart(f, songInfo(song), { unifyRepeats: false });
  assert.ok(off.text.includes('[Coro]'));
});

test('sin marcadores, todo el cifrado va en una sola sección', async () => {
  const { song, frames: f } = await frames('lam');
  const info = { bars: song.bars, duration: song.duration, sections: [{ n: 'Canción', b: 1 }] };
  const result = detect.detectChart(f, info);
  assert.match(result.text, /\[Canción\]\n\| /);
  assert.equal(result.text.split('\n').filter(line => line.startsWith('|')).length, Math.ceil(song.bars.length / 4));
});

test('audio vacío o sin canción: no inventa nada', async () => {
  const empty = await detect.analyzePCM(new Float32Array(22050 * 6), 22050);
  assert.equal(detect.detectChart(empty, { bars: [0, 2, 4], duration: 6, sections: [{ n: 'A', b: 1 }] }), null);
  assert.equal(detect.detectChart(null, { bars: [0, 2], duration: 4 }), null);
  const { song, frames: f } = await frames('lam');
  assert.equal(detect.detectChart(f, { bars: [], duration: 5, sections: [] }), null);
});

test('los compases dudosos se marcan', async () => {
  const { song, frames: f } = await frames('sol');
  const clean = detect.detectChart(f, songInfo(song));
  const noisy = makeSong({ ...SONGS.sol, rate: 22050, seed: 5, melody: true });
  const mix = new Float32Array(noisy.stems.mix.length);
  let state = 12345;
  for (let i = 0; i < mix.length; i++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; mix[i] = noisy.stems.mix[i] * 0.2 + ((state / 4294967296) * 2 - 1) * 0.6; }
  const hard = detect.detectChart(await detect.analyzePCM(mix, 22050), songInfo(noisy));
  assert.ok(hard.confidence < clean.confidence, 'con mucho ruido la confianza baja');
  assert.ok(hard.uncertain.length > clean.uncertain.length, 'y salen más compases por revisar');
});

test('el progreso del análisis avanza y se puede cancelar', async () => {
  const song = makeSong({ plan: [{ name: 'A', bars: ['C', 'G', 'Am', 'F'] }], bpm: 120, rate: 22050, seed: 3 });
  const harm = new detect.PCMGroup();
  const bass = new detect.PCMGroup();
  harm.add(song.stems.keys, 22050);
  bass.add(song.stems.bass, 22050);
  const seen = [];
  const done = await detect.framesFromGroups({ harm, bass }, { onProgress: p => seen.push(p) });
  assert.ok(done.count > 20);
  assert.ok(seen.length > 2 && seen.every((p, i) => i === 0 || p >= seen[i - 1] - 0.5), 'dos pasadas, cada una de 0 a 1 (mitad y mitad)');
  assert.ok(Math.max(...seen) <= 1 && Math.min(...seen) >= 0);
  assert.ok((await detect.framesFromGroups({ harm, bass }, { cancelled: () => true })) === null);
});

test('un WAV de 16 bits se escribe como pide el formato', () => {
  const bytes = wavBytes(Float32Array.from([0, 0.5, -0.5, 1]), 22050);
  const text = at => String.fromCharCode(...bytes.slice(at, at + 4));
  assert.equal(text(0), 'RIFF');
  assert.equal(text(8), 'WAVE');
  assert.equal(text(36), 'data');
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(24, true), 22050);
  assert.equal(view.getInt16(46, true), 16383);
  assert.equal(bytes.length, 44 + 8);
});

test('al tocar con el tono cambiado se deshace la transposición del cromagrama', () => {
  const fine = new Float32Array(60);
  fine[5 * 7] = 1; // Sol
  const out = new Float32Array(60);
  detect.LiveListener.unshift(fine, 2, out); // la canción suena 2 semitonos arriba: Sol sonando es Fa
  assert.equal(out.indexOf(1), 5 * 5);
  detect.LiveListener.unshift(fine, -3, out);
  assert.equal(out.indexOf(1), 5 * 10);
  detect.LiveListener.unshift(fine, 0, out);
  assert.equal(out.indexOf(1), 5 * 7);
});

test('en compases de 3 tiempos se usan 3 partes y se acierta igual', async () => {
  const { song, frames: f } = await frames('vals');
  assert.equal(song.slots, 3);
  const info = songInfo(song);
  const result = detect.detectChart(f, info, { slots: 3 });
  assert.equal(result.slots, 3);
  assert.equal(result.bars.length, song.bars.length);
  assert.ok(score(song, result) >= 0.93, `vals: ${(score(song, result) * 100).toFixed(1)} %`);
  assert.ok(result.text.includes('D . G') || result.text.includes('D D G'), 'el cambio a mitad de compás aparece en su sitio');
  // El cifrado lo lee con la misma división: un acorde por tiempo.
  const layout = chart.buildLayout(info, chart.parseChart(result.text));
  const bar = layout.items[0].bars[6];
  assert.deepEqual(bar.slots.map(slot => chart.formatChord(slot.chord, {})), ['D', 'D', 'G']);
});

// ───────────── Pistas «por bloques» (el motor local de Escena) ─────────────

// Doble de una pista por bloques con la forma que usa el reproductor de Escena (ver test-stream-player.mjs): se lee
// con getChunk(i), cada bloque es un AudioBuffer de `framesPerChunk` muestras (el último, más corto), y
// trimToHead() libera todos los bloques menos el primero.
function fakeStream(channelData, rate, { framesPerChunk = rate * 2 } = {}) {
  const length = channelData[0].length;
  const cache = new Map();
  const stats = { reads: 0, trims: 0, maxCached: 0 };
  const chunk = index => {
    const start = index * framesPerChunk;
    if (start >= length) return null;
    const end = Math.min(length, start + framesPerChunk);
    const parts = channelData.map(data => data.subarray(start, end));
    return { length: end - start, sampleRate: rate, numberOfChannels: parts.length, duration: (end - start) / rate, getChannelData: channel => parts[channel] };
  };
  return {
    stream: true, preparedPitch: true, sampleRate: rate, numberOfChannels: channelData.length, length, duration: length / rate,
    playbackDuration: length / rate, framesPerChunk, chunkSeconds: framesPerChunk / rate, stats, cache,
    peekChunk: index => cache.get(index) || null,
    async getChunk(index) {
      await Promise.resolve(); // el almacenamiento real es asíncrono
      if (!cache.has(index)) {
        const made = chunk(index);
        if (!made) return null;
        stats.reads++;
        cache.set(index, made);
        stats.maxCached = Math.max(stats.maxCached, cache.size);
      }
      return cache.get(index);
    },
    async ensure(position) { await this.getChunk(Math.floor((position * rate) / framesPerChunk)); },
    trimToHead() { stats.trims++; for (const index of [...cache.keys()]) if (index !== 0) cache.delete(index); },
    memoryBytes: () => cache.size * framesPerChunk * channelData.length * 4,
    dispose() { cache.clear(); },
  };
}

const concat = parts => {
  const out = new Float32Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};

test('el decimador por tandas da lo mismo que decimate() con cualquier reparto en bloques', async () => {
  let seed = 7;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (const [rate, length] of [[44100, 60001], [48000, 33333], [22050, 4000], [96000, 40001], [44100, 40]]) {
    const x = Float32Array.from({ length }, (_, i) => Math.sin(i * 0.031) * 0.5 + (random() - 0.5) * 0.2);
    const want = await detect.decimate(x, rate);
    for (const piece of [1, 7, 513, 2000, 44100, length]) {
      const decimator = new detect.StreamDecimator(rate);
      const parts = [];
      for (let at = 0; at < length; at += piece) parts.push(decimator.push(x.subarray(at, Math.min(length, at + piece))));
      parts.push(decimator.finish());
      const got = concat(parts);
      assert.equal(got.length, want.data.length, `${rate} Hz, bloques de ${piece}: largo`);
      assert.equal(decimator.rate, want.rate);
      let worst = 0;
      for (let i = 0; i < got.length; i++) worst = Math.max(worst, Math.abs(got[i] - want.data[i]));
      assert.ok(worst < 1e-6, `${rate} Hz, bloques de ${piece}: diferencia ${worst}`);
    }
  }
});

test('una pista por bloques se lee igual que si estuviera entera, sin acumular memoria', async () => {
  const rate = 44100;
  const length = rate * 30 + 123;
  const left = Float32Array.from({ length }, (_, i) => Math.sin(i * 0.02) * 0.4);
  const right = Float32Array.from(left, (value, i) => value * 0.5 + Math.sin(i * 0.011) * 0.1);
  const stream = fakeStream([left, right], rate);
  const seen = [];
  const got = await detect.streamToMono(stream, { onProgress: p => seen.push(p) });
  const whole = await detect.bufferToMono({ numberOfChannels: 2, sampleRate: rate, length, getChannelData: channel => [left, right][channel] });
  assert.equal(got.rate, whole.rate);
  assert.equal(got.data.length, whole.data.length);
  let worst = 0;
  for (let i = 0; i < got.data.length; i++) worst = Math.max(worst, Math.abs(got.data[i] - whole.data[i]));
  assert.ok(worst < 1e-6, `diferencia ${worst}`);
  assert.equal(stream.stats.reads, 16, 'lee cada bloque una vez (15 enteros y un último con las muestras que sobran)');
  assert.ok(stream.stats.maxCached <= 5, `nunca tiene más de unos pocos bloques en memoria (${stream.stats.maxCached})`);
  assert.ok(stream.cache.size <= 1, 'al terminar solo queda la cabeza, como cuando el reproductor se detiene');
  assert.ok(seen.length === 16 && seen.every((p, i) => i === 0 || p >= seen[i - 1]) && seen[seen.length - 1] === 1, 'el progreso avanza hasta 1');
});

test('leer una pista por bloques se puede cancelar y deja la memoria como estaba', async () => {
  const rate = 22050;
  const stream = fakeStream([new Float32Array(rate * 20)], rate);
  let calls = 0;
  const result = await detect.streamToMono(stream, { cancelled: () => ++calls > 4 });
  assert.ok(result === null);
  assert.ok(stream.stats.reads <= 4);
  assert.ok(stream.cache.size <= 1 && stream.stats.trims >= 1);
});

test('canciones por bloques: se lee el audio de cada pista y se acierta igual', async () => {
  for (const [name, rate, key] of [['sol', 22050, 'G'], ['ritmo', 44100, 'E']]) {
    const song = makeSong({ ...SONGS[name], rate, seed: 11 });
    const harm = new detect.PCMGroup();
    const bass = new detect.PCMGroup();
    for (const stem of [song.stems.keys, song.stems.guitar]) {
      const mono = await detect.streamToMono(fakeStream([stem, stem], rate));
      harm.add(mono.data, mono.rate);
    }
    const low = await detect.streamToMono(fakeStream([song.stems.bass, song.stems.bass], rate));
    bass.add(low.data, low.rate);
    const result = detect.detectChart(await detect.framesFromGroups({ harm, bass }), songInfo(song));
    const accuracy = score(song, result);
    assert.ok(accuracy >= 0.97, `${name} por bloques: ${(accuracy * 100).toFixed(1)} %`);
    assert.equal(result.key.text, key);
  }
});

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const raise = (symbol, semitones) => {
  const [, root, rest] = /^([A-G][#b]?)(.*)$/.exec(symbol);
  return NOTE_NAMES[(chordInfo(root).root + semitones + 12) % 12] + rest;
};

test('con el tono de la canción cambiado en Escena, el cifrado sale en el tono original', async () => {
  const original = makeSong({ ...SONGS.sol, rate: 22050, seed: 11 });
  const plan = SONGS.sol.plan.map(section => ({ ...section, bars: section.bars.map(chord => raise(chord, 2)) }));
  const raised = makeSong({ ...SONGS.sol, plan, rate: 22050, seed: 11 }); // lo que suena con el tono subido 2 semitonos
  const run = async unshift => {
    const harm = new detect.PCMGroup();
    const bass = new detect.PCMGroup();
    harm.add(raised.stems.keys, 22050);
    harm.add(raised.stems.guitar, 22050);
    bass.add(raised.stems.bass, 22050);
    harm.unshift = unshift;
    bass.unshift = unshift;
    return detect.detectChart(await detect.framesFromGroups({ harm, bass }), songInfo(raised));
  };
  const fixed = await run(2);
  assert.ok(score(original, fixed) >= 0.95, `${(score(original, fixed) * 100).toFixed(1)} %`);
  assert.equal(fixed.key.text, 'G');
  const raw = await run(0);
  assert.equal(raw.key.text, 'A', 'sin deshacerlo, el cifrado saldría 2 semitonos arriba');
});

test('unshiftFrames rota los cuadros y no hace nada con 0 o 12 semitonos', () => {
  const frames = { count: 2, treble: new Float32Array(120), bass: new Float32Array(120) };
  frames.treble[5 * 7] = 1; // Sol, en el primer cuadro
  frames.bass[60 + 5 * 2] = 1; // Re, en el segundo
  detect.unshiftFrames(frames, 2);
  assert.equal(frames.treble.indexOf(1), 5 * 5, 'Sol 2 semitonos arriba era Fa');
  assert.equal(frames.bass.indexOf(1), 60 + 5 * 0, 'Re 2 semitonos arriba era Do');
  detect.unshiftFrames(frames, 12);
  detect.unshiftFrames(frames, 0);
  assert.equal(frames.treble.indexOf(1), 5 * 5);
  assert.equal(detect.unshiftFrames(null, 3), null);
});


// ───────────── Inversiones, armónicos y cifrado de referencia ─────────────

// «Somos» (Majo y Dan) según su cifrado: Db/F, Cm/Eb, Bb y Bbm/Db. El bajo toca la tercera, y las armónicas del bajo y
// del teclado dejan energía en Do, Mib y La (Fa menor y Lab mayor). Con el detector anterior salía Fm, Eb y Ab.
const exact = (song, result) => {
  let ok = 0;
  let total = 0;
  result.bars.forEach((bar, index) => bar.symbols.forEach((symbol, slot) => {
    const wanted = song.truth[index - song.silentBars]?.[slot];
    if (wanted === undefined) return;
    total++;
    if (symbol === wanted) ok++;
  }));
  return ok / total;
};

test('acordes invertidos (Db/F, Cm/Eb): se leen bien y se escriben como en el cifrado', async () => {
  const { song, frames: f } = await frames('somos');
  const result = detect.detectChart(f, songInfo(song));
  assert.ok(score(song, result) >= 0.97, `triadas: ${(score(song, result) * 100).toFixed(1)} %`);
  assert.ok(exact(song, result) >= 0.95, `con inversión: ${(exact(song, result) * 100).toFixed(1)} %`);
  for (const wanted of ['Db/F', 'Cm/Eb', 'Bbm/Db']) assert.ok(result.text.includes(wanted), `aparece ${wanted}`);
  assert.ok(!result.text.includes('Bb/'), 'el Bb en estado fundamental no lleva inversión');
  // El texto vuelve a leerse como cifrado, con su bajo.
  const parsed = chart.parseChart(result.text);
  const chords = parsed.sections.flatMap(section => section.bars.flatMap(bar => bar.chords.map(item => item.raw)));
  assert.ok(chords.includes('Db/F') && chart.parseChord('Db/F').bass, 'Db/F se entiende como acorde con bajo');
});

test('sin marcar inversiones salen las triadas, sin bajo', async () => {
  const { song, frames: f } = await frames('somos');
  const result = detect.detectChart(f, songInfo(song), { inversions: false });
  assert.ok(score(song, result) >= 0.97, `${(score(song, result) * 100).toFixed(1)} %`);
  assert.ok(!result.text.includes('/'), 'ninguna inversión escrita');
});

test('las armónicas de timbres brillantes o apagados no confunden los acordes', async () => {
  for (const brightness of [-0.7, 0.7, 1.4]) {
    const { song, frames: f } = await frames('somos', { brightness });
    const result = detect.detectChart(f, songInfo(song));
    assert.ok(score(song, result) >= 0.97, `somos con brillo ${brightness}: ${(score(song, result) * 100).toFixed(1)} %`);
  }
  for (const name of ['sol', 'sib', 'dos']) {
    const { song, frames: f } = await frames(name, { brightness: 0.7 });
    const result = detect.detectChart(f, songInfo(song));
    assert.ok(score(song, result) >= (name === 'dos' ? 0.9 : 0.97), `${name} brillante: ${(score(song, result) * 100).toFixed(1)} %`);
  }
});

test('en canciones con los acordes en estado fundamental no se inventan inversiones', async () => {
  for (const name of ['sol', 'lam', 'sib', 'ritmo']) {
    const { frames: f, song } = await frames(name);
    const result = detect.detectChart(f, songInfo(song));
    assert.ok(!result.text.includes('/'), `${name}: ${result.text.split('\n').filter(line => line.includes('/')).join(' ')}`);
  }
});

const PDF = `Somos por Somos
Majo y Dan
INTRO

Db/F Cm/Eb

VERSO 1

Db/F      Cm/Eb

En la soledad

          Db/F Cm/Eb

Escuché un suspiro

CORO

    Bb             Bbm/Db

Que bailan a la luz de una vela

INTRO x2

//Db/F Cm/Eb //

INSTRUMENTAL

Db/F Cm/Eb Bb Bbm/Db

Mi
`;

test('de un PDF pegado salen solo los acordes, no la letra', () => {
  const found = detect.chordsFromText(PDF);
  assert.deepEqual(found.map(c => c.text).sort(), ['Bb', 'Bbm/Db', 'Cm/Eb', 'Db/F']);
  const db = found.find(c => c.text === 'Db/F');
  assert.deepEqual([db.root, db.minor, db.bass, db.count], [1, false, 5, 5]);
  const bbm = found.find(c => c.text === 'Bbm/Db');
  assert.deepEqual([bbm.root, bbm.minor, bbm.bass], [10, true, 1]);
  assert.equal(found.find(c => c.text === 'Bb').count, 2);
  assert.deepEqual(detect.chordsFromText('Hola, esto es una letra sin acordes\nLa vida es bella\nA').map(c => c.text), []);
  assert.deepEqual(detect.chordsFromText('Intro: G D Em7 C (x2)\n[Verso] G C/E D').map(c => c.text).sort(), ['C', 'C/E', 'D', 'Em7', 'G']);
  assert.deepEqual(detect.chordsFromText('Sol Re Mim Do').map(c => c.text), ['G', 'D', 'Em', 'C']);
});

test('con el cifrado de referencia, una mezcla con ruido sale igual que el original', async () => {
  const { song, frames: f } = await frames('somos', {}, 'mix');
  const free = detect.detectChart(f, songInfo(song));
  const guided = detect.detectChart(f, songInfo(song), { allowed: detect.chordsFromText(PDF) });
  assert.ok(guided.guide && guided.guide.shift === 0 && guided.guide.chords === 4, JSON.stringify(guided.guide));
  assert.ok(exact(song, guided) >= 0.97, `guiado: ${(exact(song, guided) * 100).toFixed(1)} %`);
  assert.ok(exact(song, guided) >= exact(song, free), `guiado ${(exact(song, guided) * 100).toFixed(1)} % frente a ${(exact(song, free) * 100).toFixed(1)} % sin guía`);
  // Con un solo acorde repetido no hay guía que valga.
  assert.equal(detect.detectChart(f, songInfo(song), { allowed: detect.chordsFromText('Db/F Db/F') }).guide, null);
});

test('si el cifrado de referencia está en otro tono que el audio, se mueve', async () => {
  const { song, frames: f } = await frames('sol'); // G D Em C
  const lower = detect.chordsFromText('F C Dm Bb'); // el mismo cifrado un tono más abajo
  const result = detect.detectChart(f, songInfo(song), { allowed: lower });
  assert.equal(result.guide.shift, 2, JSON.stringify(result.guide));
  assert.ok(score(song, result) >= 0.97, `${(score(song, result) * 100).toFixed(1)} %`);
  assert.ok(result.text.includes('Em') && !result.text.includes('Dm'), result.text.slice(0, 160));
});
