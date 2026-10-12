#!/usr/bin/env python3
"""Convierte el paquete «Click and Guide Samples» en los sonidos ligeros de Escena.

Uso:
    python3 scripts/construir-sonidos.py "ruta/a/Click and Guide Samples" [carpeta-de-salida]

La carpeta de salida por defecto es www/audio. Requiere Python 3, numpy y ffmpeg.

Genera:
    audio/clicks.wav + audio/clicks.json            8 sonidos de click (acento, tiempo, corchea, semicorchea)
    audio/guias/<idioma>.wav + <idioma>.json         guías de voz por idioma (es, en, pt, fr)

Los audios originales (WAV estéreo de 16/24 bits, 44,1/48 kHz, 85 MB) son mono real: se
guardan en mono de 16 bits, sin silencios, con un volumen parejo y agrupados en un solo
archivo por idioma. Es el mismo formato de «voces.wav»: un WAV con un índice de inicios.
"""
import hashlib
import json
import re
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

CLICK_RATE = 44100
VOICE_RATE = 24000
CLICK_GAP = 0.06
VOICE_GAP = 0.08
VOICE_TARGET_RMS_DB = -16.5  # mismo volumen medio que la voz original de Escena
VOICE_PEAK_LIMIT = 0.9
CLICK_PEAK_LIMIT = 0.95

SOUNDS = ['blip', 'classic', 'cowbell', 'digital', 'gentle', 'percussive', 'saw', 'woodblock']
CLICK_KINDS = {'accent': 'accents', 'beat': 'quarter', 'eighth': 'eighth', 'sixteenth': 'sixteenth'}
# Si un sonido no trae alguno de los cuatro golpes, se usa el más parecido que sí tenga.
CLICK_FALLBACK = {
    'beat': ['sixteenth', 'eighth', 'accent'],
    'eighth': ['beat', 'sixteenth', 'accent'],
    'sixteenth': ['eighth', 'beat', 'accent'],
}

LANGUAGES = {
    'es': {'name': 'Español', 'folders': ['Spanish Guides/Song Sections', 'Spanish Guides/Guide Cues']},
    'en': {'name': 'English', 'folders': ['English Guides/Song Sections', 'English Guides/Dynamic Cues']},
    'pt': {'name': 'Português', 'folders': ['Portugese Guides/Song Sections', 'Portugese Guides/Dynamic Cues']},
    'fr': {'name': 'Français', 'folders': ['French Guides/Song Sections', 'French Guides/Dynamic Cues']},
}

# Nombre en inglés de cada voz del paquete -> clave interna de Escena.
CANON = {
    'Intro': 'intro', 'Outro': 'outro', 'Ending': 'final', 'Instrumental': 'instrumental',
    'Interlude': 'interludio', 'Solo': 'solo', 'Tag': 'tag', 'Turnaround': 'turnaround',
    'Vamp': 'vamp', 'Rap': 'rap', 'Refrain': 'estribillo', 'Exhortation': 'exhortacion',
    'Breakdown': 'breakdown', 'Acapella': 'acapella', 'A Capella': 'acapella',
    'Post Chorus': 'postcoro',
    'Verse': 'verso', 'Pre Chorus': 'precoro', 'Chorus': 'coro', 'Bridge': 'puente',
    'Ad Lib': 'adlib', 'All In': 'allin', 'Bass': 'bass', 'Big Ending': 'bigending',
    'Break': 'break', 'Build': 'build', 'Slowly Build': 'slowbuild', 'Drums In': 'drumsin',
    'Drums': 'drums', 'Guitar': 'guitar', 'Hits': 'hits', 'Hold': 'hold',
    'Key Change Down': 'keydown', 'Key Change Up': 'keyup', 'Keys': 'keys',
    'Last Time': 'lasttime', 'Pad': 'pad', 'Softly': 'softly', 'Swell': 'swell',
    'Worship Freely': 'freely',
}
for number in range(1, 8):
    CANON[str(number)] = f'n{number}'
for name, key in (('Verse', 'verso'), ('Pre Chorus', 'precoro'), ('Chorus', 'coro'), ('Bridge', 'puente')):
    for number in range(1, 7 if name == 'Verse' else 5):
        CANON[f'{name} {number}'] = f'{key}{number}'

NAME_PATTERN = re.compile(r'^(?:Spanish|English Female|Portugese|French)(?: Guide)? +- +(.+)$')


def decode(path, rate=None):
    """Lee un WAV como mono float32 (promedia canales; no hay ganancia añadida)."""
    probe = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'stream=channels', '-of', 'csv=p=0', str(path)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    channels = int(probe)
    command = ['ffmpeg', '-v', 'error', '-i', str(path)]
    if channels > 1:
        mix = '+'.join(f'{1 / channels}*c{i}' for i in range(channels))
        command += ['-af', f'pan=mono|c0={mix}']
    if rate:
        command += ['-ar', str(rate)]
    command += ['-f', 'f32le', '-']
    raw = subprocess.run(command, capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def smooth_rms(x, rate, milliseconds):
    width = max(1, int(rate * milliseconds / 1000))
    return np.sqrt(np.convolve(x * x, np.ones(width) / width, mode='same'))


def trim(x, rate, lead_db, tail_db, preroll_ms, tail_ms, fade_ms, fade_in_ms=0.0, max_seconds=None):
    """Quita el silencio inicial y final y aplica un cierre suave."""
    peak = float(np.abs(x).max())
    if peak == 0:
        return x[:1]
    above = np.where(np.abs(x) >= peak * 10 ** (lead_db / 20))[0]
    start = max(0, int(above[0]) - int(rate * preroll_ms / 1000))
    envelope = smooth_rms(x, rate, 3.0)
    loud = np.where(envelope >= envelope.max() * 10 ** (tail_db / 20))[0]
    end = min(len(x), int(loud[-1]) + int(rate * tail_ms / 1000))
    if max_seconds:
        end = min(end, start + int(rate * max_seconds))
    out = x[start:end].copy()
    fade = min(len(out), max(1, int(rate * fade_ms / 1000)))
    out[-fade:] *= 0.5 * (1 + np.cos(np.linspace(0, np.pi, fade)))
    if fade_in_ms:
        fade_in = min(len(out), max(1, int(rate * fade_in_ms / 1000)))
        out[:fade_in] *= 0.5 * (1 - np.cos(np.linspace(0, np.pi, fade_in)))
    return out


def write_wav(path, samples, rate):
    path.parent.mkdir(parents=True, exist_ok=True)
    data = np.clip(np.round(samples * 32767), -32768, 32767).astype('<i2')
    with wave.open(str(path), 'wb') as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(data.tobytes())


class Sprite:
    """Une audios en un solo archivo y recuerda dónde empieza cada uno."""

    def __init__(self, rate, gap):
        self.rate = rate
        self.gap = int(rate * gap)
        self.parts = [np.zeros(self.gap, dtype=np.float32)]
        self.length = self.gap
        self.seen = {}

    def add(self, samples):
        digest = hashlib.sha1(np.round(samples * 32767).astype('<i2').tobytes()).hexdigest()
        if digest in self.seen:  # el mismo audio no se guarda dos veces
            return self.seen[digest]
        slot = [round(self.length / self.rate, 5), round(len(samples) / self.rate, 5)]
        self.parts.append(samples.astype(np.float32))
        self.parts.append(np.zeros(self.gap, dtype=np.float32))
        self.length += len(samples) + self.gap
        self.seen[digest] = slot
        return slot

    def audio(self):
        return np.concatenate(self.parts)


def build_clicks(source, target):
    folder = source / 'Click Tracks'
    sprite = Sprite(CLICK_RATE, CLICK_GAP)
    index = {}
    print('\nCLICKS')
    for sound in SOUNDS:
        hits = {}
        for kind, label in CLICK_KINDS.items():
            file = folder / f'New Click -  {sound.capitalize()}-{label}.wav'
            if file.exists():
                hits[kind] = trim(decode(file, CLICK_RATE), CLICK_RATE, lead_db=-54, tail_db=-60,
                                  preroll_ms=0, tail_ms=4, fade_ms=6, max_seconds=0.3)
        replaced = []
        for kind in ('beat', 'eighth', 'sixteenth'):
            if kind not in hits:
                source_kind = next(other for other in CLICK_FALLBACK[kind] if other in hits)
                hits[kind] = hits[source_kind]
                replaced.append(f'{kind}<-{source_kind}')
        # El acento se toca encima del tiempo. Se cuida que la suma no sature.
        size = max(len(hits['beat']), len(hits['accent']))
        mix = np.zeros(size, dtype=np.float32)
        mix[:len(hits['beat'])] += hits['beat']
        mix[:len(hits['accent'])] += hits['accent']
        scale = min(1.0, CLICK_PEAK_LIMIT / float(np.abs(mix).max()))
        index[sound] = {kind: sprite.add(hits[kind] * scale) for kind in ('accent', 'beat', 'eighth', 'sixteenth')}
        print(f'  {sound:11s} acento+tiempo pico {np.abs(mix).max() * scale:.2f}  ganancia {scale:.2f}'
              + (f'  (sin archivo propio: {", ".join(replaced)})' if replaced else ''))
    audio = sprite.audio()
    write_wav(target / 'clicks.wav', audio, CLICK_RATE)
    meta = {'version': 1, 'rate': CLICK_RATE, 'sounds': index}
    (target / 'clicks.json').write_text(json.dumps(meta, separators=(',', ':')) + '\n')
    print(f'  -> clicks.wav {(target / "clicks.wav").stat().st_size / 1024:.0f} KB')


def voice_files(source, folders):
    found = {}
    skipped = []
    for folder in folders:
        for file in sorted((source / folder).glob('*.wav')):
            match = NAME_PATTERN.match(file.stem)
            if not match:
                skipped.append(file.name)
                continue
            name = re.sub(r'\s+', ' ', match.group(1)).strip()
            candidates = [name]
            paren = re.match(r'^(.*?) \((.*)\)$', name)
            if paren:
                candidates = [paren.group(1).strip(), paren.group(2).strip()]
            key = next((CANON[c] for c in candidates if c in CANON), None)
            if key is None:
                skipped.append(file.name)
            elif key not in found:  # si una voz está repetida, gana la de «Song Sections»
                found[key] = file
    return found, skipped


def build_voices(source, target):
    print('\nGUÍAS DE VOZ')
    for lang, info in LANGUAGES.items():
        files, skipped = voice_files(source, info['folders'])
        words = {}
        for key, file in files.items():
            words[key] = trim(decode(file, VOICE_RATE), VOICE_RATE, lead_db=-40, tail_db=-45,
                              preroll_ms=4, tail_ms=10, fade_ms=12, fade_in_ms=2)
        sprite = Sprite(VOICE_RATE, VOICE_GAP)
        index = {}
        gains = []
        for key in sorted(words, key=lambda k: (not k.startswith('n') or not k[1:].isdigit(), k)):
            samples = words[key]
            rms = float(np.sqrt(np.mean(samples ** 2)))
            peak = float(np.abs(samples).max())
            gain = min(max(10 ** (VOICE_TARGET_RMS_DB / 20) / rms, 0.5), 2.0)
            gain = min(gain, VOICE_PEAK_LIMIT / peak)
            gains.append(20 * np.log10(gain))
            index[key] = sprite.add(samples * gain)
        audio = sprite.audio()
        write_wav(target / 'guias' / f'{lang}.wav', audio, VOICE_RATE)
        meta = {'version': 1, 'lang': lang, 'name': info['name'], 'rate': VOICE_RATE, 'voices': index}
        (target / 'guias' / f'{lang}.json').write_text(json.dumps(meta, separators=(',', ':'), ensure_ascii=False) + '\n')
        size = (target / 'guias' / f'{lang}.wav').stat().st_size
        print(f'  {lang}: {len(index):3d} voces, {len(audio) / VOICE_RATE:5.1f} s, {size / 1024:6.0f} KB, '
              f'ajuste de volumen {min(gains):+.1f}..{max(gains):+.1f} dB'
              + (f'  (omitidas: {", ".join(skipped)})' if skipped else ''))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    source = Path(sys.argv[1])
    target = Path(sys.argv[2]) if len(sys.argv) > 2 else Path('www/audio')
    if not (source / 'Click Tracks').is_dir():
        sys.exit(f'No se encontró «Click Tracks» dentro de {source}')
    build_clicks(source, target)
    build_voices(source, target)
    print('\nListo.')


if __name__ == '__main__':
    main()
