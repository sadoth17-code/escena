// Huella de los cambios que viajan con una canción. No representa permisos.
// Las fechas de guardado, los solos momentáneos y el enlace a la nube se omiten.
import { normalizeSong } from './library.js';
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
}

export function cloudSongContent(song) {
  const raw = JSON.parse(JSON.stringify(song));
  // Aplicar los mismos valores predeterminados que al volver a abrir Escena.
  // Una pista recién añadida aún puede no tener pitchEnabled, por ejemplo.
  raw.markers = (raw.markers || []).map((marker, index) => ({ ...marker, id: marker.id || `marker-${index}` }));
  raw.tracks = (raw.tracks || []).map((track, index) => ({ ...track, id: track.id || `track-${index}` }));
  const copy = normalizeSong(raw);
  delete copy.cloud; delete copy.id; delete copy.updatedAt; delete copy.createdAt;
  for (const track of copy.tracks || []) { track.solo = false; delete track.duration; }
  if (copy.click) copy.click.solo = false;
  if (copy.guide) copy.guide.solo = false;
  return JSON.stringify(sorted(copy));
}

export async function cloudSongHash(song) {
  const data = new TextEncoder().encode(cloudSongContent(song));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), byte => byte.toString(16).padStart(2, '0')).join('');
}
