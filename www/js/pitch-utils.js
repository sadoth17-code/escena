export const MIN_PITCH = -12;
export const MAX_PITCH = 12;

export function keyPitchClass(key) {
  const match = /^(do|re|mi|fa|sol|la|si|[a-g])([#b♯♭]?)(\s*(?:m|min|maj|minor|major|menor|mayor)?)$/i.exec(String(key || '').trim());
  if (!match) return null;
  const notes = { c: 0, do: 0, d: 2, re: 2, e: 4, mi: 4, f: 5, fa: 5, g: 7, sol: 7, a: 9, la: 9, b: 11, si: 11 };
  return (notes[match[1].toLowerCase()] + (/[b♭]/.test(match[2]) ? -1 : match[2] ? 1 : 0) + 12) % 12;
}

export function normalizePitch(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(MAX_PITCH, Math.max(MIN_PITCH, Math.round(number))) : 0;
}

export function pitchLabel(value) {
  const semitones = normalizePitch(value);
  return `${semitones > 0 ? '+' : ''}${semitones} ${Math.abs(semitones) === 1 ? 'semitono' : 'semitonos'}`;
}

// Default only; the user can override every imported track in the pitch panel.
export function defaultPitchEnabled(track) {
  const name = String(track.name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return track.dest !== 'cue' && !/(^|[^a-z])(click|clic|metronomo|metro|cue|cues|guia|guias|guide|guides|count|conteo|cuenta|drums?|bateria|percussion|percusion|perc|kick|snare|hihat|hi hat|cymbals?|platillos|toms?|shaker|tambourine|pandereta)([^a-z]|$)/.test(name);
}

export function transposeKey(key, value) {
  const semitones = normalizePitch(value);
  const text = String(key || '').trim();
  if (!text || !semitones) return text;
  const match = /^(do|re|mi|fa|sol|la|si|[a-g])([#b♯♭]?)(\s*(?:m|min|maj|minor|major|menor|mayor)?)$/i.exec(text);
  if (!match) return text; // Never guess a key from an unrecognised free-text label.
  const notes = { c: 0, do: 0, d: 2, re: 2, e: 4, mi: 4, f: 5, fa: 5, g: 7, sol: 7, a: 9, la: 9, b: 11, si: 11 };
  const flat = /[b♭]/.test(match[2]);
  const accidental = flat ? -1 : match[2] ? 1 : 0;
  const index = ((notes[match[1].toLowerCase()] + accidental + semitones) % 12 + 12) % 12;
  const solfege = match[1].length > 1;
  const names = solfege
    ? flat ? ['Do', 'Re♭', 'Re', 'Mi♭', 'Mi', 'Fa', 'Sol♭', 'Sol', 'La♭', 'La', 'Si♭', 'Si'] : ['Do', 'Do♯', 'Re', 'Re♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si']
    : flat ? ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'] : ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  return names[index] + match[3];
}

export function songPitchText(song) {
  const semitones = normalizePitch(song.pitchSemitones);
  const key = transposeKey(song.key, semitones);
  return [key ? `Tono ${key}` : '', semitones ? pitchLabel(semitones) : ''].filter(Boolean).join(' · ');
}
