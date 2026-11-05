// Matemática pura de la pestaña DJ: sin audio ni DOM, para poder probarla en Node.
//
// Una mezcla de DJ sube la canción que entra mientras baja la que sale. Se usa potencia constante
// (seno / coseno): la suma de las dos potencias vale siempre 1, así que el volumen que se oye no
// se hunde en medio de la mezcla, que es lo que pasa con una mezcla lineal entre dos canciones distintas.

export const MIN_FADE = 0.06; // la mezcla más corta (un "corte" sin clic), en segundos
export const MAX_FADE = 12;
export const DEFAULT_FADE = 4;
export const START_FADE = 0.2; // entrada suave al arrancar desde el silencio
export const PAUSE_FADE = 0.18; // bajada al pausar y subida al reanudar
export const PANIC_FADE = 0.05; // silencio inmediato sin clic

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Segundos de mezcla válidos. 0 (o menos) significa "corte": una rampa mínima que evita el clic.
export function fadeSeconds(value, fallback = DEFAULT_FADE) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  if (number <= 0) return MIN_FADE;
  return clamp(number, MIN_FADE, MAX_FADE);
}

export function dbToGain(db) {
  const number = Number(db);
  if (!Number.isFinite(number)) return 1;
  return Math.pow(10, clamp(number, -24, 12) / 20);
}

// Nivel durante una mezcla de potencia constante entre `from` y `to` (progreso de 0 a 1).
//   canción que entra:  from = 0   -> to = 1   => sin(x·π/2)
//   canción que sale:   from = l   -> to = 0   => l·cos(x·π/2)
//   una que ya sonaba a medias y vuelve a entrar se mezcla en potencia, sin saltos.
export function blendLevel(from, to, progress) {
  const x = (clamp(Number.isFinite(progress) ? progress : 0, 0, 1) * Math.PI) / 2;
  const c = Math.cos(x);
  const s = Math.sin(x);
  return Math.sqrt(from * from * c * c + to * to * s * s);
}

// Un plan es lo que se programó en el reloj de audio: empieza en t0, dura dur y va de from a to.
export function makePlan(t0, duration, from, to) {
  return { t0, dur: fadeSeconds(duration), from, to };
}

export function planProgress(plan, time) {
  if (!plan) return 1;
  return clamp((time - plan.t0) / plan.dur, 0, 1);
}

export function planLevel(plan, time) {
  if (!plan) return 0;
  if (time <= plan.t0) return plan.from;
  const progress = planProgress(plan, time);
  return progress >= 1 ? plan.to : blendLevel(plan.from, plan.to, progress);
}

export function planDone(plan, time) {
  return !plan || time >= plan.t0 + plan.dur - 1e-6;
}

// Puntos [segundos desde t0, nivel] para encadenar rampas lineales cortas que siguen la curva.
// El primer punto (t0, from) lo pone quien programa con setValueAtTime.
export function fadePoints(plan, { maxStep = 0.04, minSegments = 24 } = {}) {
  const count = Math.max(minSegments, Math.ceil(plan.dur / maxStep));
  const points = [];
  for (let i = 1; i <= count; i++) {
    const progress = i / count;
    points.push([plan.dur * progress, i === count ? plan.to : blendLevel(plan.from, plan.to, progress)]);
  }
  return points;
}

// Limitador de seguridad: deja pasar sin tocar todo lo que no llega al techo y redondea suavemente lo
// que pasa. Trabaja con la señal a la mitad (ganancia 0.5 antes y 2 después) para que dos canciones
// muy fuertes sumadas en la mezcla no se recorten antes de llegar al limitador.
// El techo real es 0.97 (0.485 × 2, unos −0,26 dB): deja margen para el pequeño rebote del filtro de
// sobremuestreo del navegador, así la salida nunca pasa de 1.0 (medido en Chrome: sin margen llegaba a 1.003).
export function makeLimiterCurve(size = 4097, knee = 0.44, ceiling = 0.485) {
  const curve = new Float32Array(size);
  const room = ceiling - knee;
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + room * Math.tanh((a - knee) / room);
    curve[i] = x < 0 ? -y : y;
  }
  return curve;
}

// ---------------------------------------------------------------- tiempo

export function fmtClock(seconds) {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

// "83", "1:23", "01:02:03", "1,5" -> segundos. Devuelve NaN si no se entiende.
export function parseClock(text) {
  const raw = String(text ?? '').trim().replace(',', '.');
  if (!raw) return NaN;
  const parts = raw.split(':');
  if (parts.length > 3 || parts.some((part) => !/^\d+(\.\d+)?$/.test(part))) return NaN;
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

// ---------------------------------------------------------------- programa

// Segundo de la canción en el que debe terminar este participante.
//   - con duración máxima: desde el segundo de inicio + esa duración (sin pasar del final de la canción)
//   - sin duración máxima: el final de la canción
export function itemEnd(item, trackDuration) {
  const known = Number.isFinite(trackDuration) && trackDuration > 0 ? trackDuration : 0;
  const start = Math.max(0, Number(item?.start) || 0);
  const max = Math.max(0, Number(item?.maxDur) || 0);
  if (max > 0) return known ? Math.min(known, start + max) : start + max;
  return known;
}

// Segundos que le quedan a lo que suena. Sin duración conocida devuelve null.
export function remainingSeconds(item, position, trackDuration) {
  const end = itemEnd(item, trackDuration);
  return end > 0 ? Math.max(0, end - position) : null;
}

export function indexOfItem(items, id) {
  return items.findIndex((item) => item.id === id);
}

// Qué suena al pulsar "Siguiente": la canción que se marcó como "Sigue" o, si no hay, la que viene después.
export function resolveNextItem(items, nowId, cueId) {
  if (!items.length) return null;
  const cue = cueId ? items.find((item) => item.id === cueId) : null;
  if (cue && cue.id !== nowId) return cue;
  return items[indexOfItem(items, nowId) + 1] || null;
}

export function resolvePrevItem(items, nowId) {
  const now = indexOfItem(items, nowId);
  return now > 0 ? items[now - 1] : null;
}

export function moveItem(list, index, delta) {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length || !delta) return list.slice();
  const next = list.slice();
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

// ¿Ya toca empezar la mezcla hacia la siguiente para que termine justo cuando acaba esta?
export function shouldStartMix({ position, end, fade }) {
  return end > 0 && position >= end - fade - 0.03;
}

// ---------------------------------------------------------------- perillas

// Toma de control suave: una perilla física casi nunca está en la posición del volumen de la pantalla.
// Hasta que la perilla no llega al valor actual (o lo cruza) se ignora, para que no haya un salto de volumen.
export function softTakeover(state, value, current, window = 0.04) {
  if (state.engaged) {
    state.last = value;
    return true;
  }
  const near = Math.abs(value - current) <= window;
  const crossed = state.last !== null && state.last !== undefined && ((state.last < current && value >= current) || (state.last > current && value <= current));
  state.last = value;
  if (near || crossed) {
    state.engaged = true;
    return true;
  }
  return false;
}

export function newTakeover() {
  return { engaged: false, last: null };
}
