import { app } from './app.js';
import { isIOS, isNative, isStandalone, createEmitter } from './util.js';
import { configureAudioSession } from './audio-session.js';

const bus = createEmitter();

const state = {
  installEvent: null,
  wake: null,
  audio: null,
  registration: null,
  audioStarting: false,
  reloadOnChange: false,
  barsHidden: false,
};

function nativeBars() {
  const capacitor = window.Capacitor;
  if (!capacitor || typeof capacitor.isNativePlatform !== 'function' || !capacitor.isNativePlatform()) return null;
  return (capacitor.Plugins && capacitor.Plugins.SystemBars) || null;
}

async function setBars(visible) {
  const bars = nativeBars();
  if (!bars) return;
  state.barsHidden = !visible;
  try {
    await (visible ? bars.show() : bars.hide());
  } catch (error) {
    void error;
  }
}

function silentWavUrl() {
  const rate = 8000;
  const samples = rate;
  const buffer = new ArrayBuffer(44 + samples);
  const view = new DataView(buffer);
  const text = (offset, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, 'data');
  view.setUint32(40, samples, true);
  new Uint8Array(buffer, 44).fill(128);
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

function startSilentAudio() {
  if (state.audioStarting || (state.audio && !state.audio.paused)) return;
  let audio = state.audio;
  if (!audio) {
    audio = document.createElement('audio');
    audio.src = silentWavUrl();
    audio.loop = true;
    audio.setAttribute('playsinline', '');
    audio.setAttribute('aria-hidden', 'true');
    audio.volume = 1;
    audio.style.display = 'none';
    document.body.append(audio);
    state.audio = audio;
  }
  state.audioStarting = true;
  // A denied first touch or an interruption must not disable future attempts.
  Promise.resolve(audio.play()).catch(() => {}).finally(() => { state.audioStarting = false; });
}

function ensureRunning() {
  const engine = app.engine;
  if (!engine || engine.offline) return;
  if (engine.ctx.state !== 'running') engine.resume().catch(() => {});
}

function unlock() {
  const sessionConfigured = configureAudioSession();
  if (!sessionConfigured && (isIOS() || /Android/i.test(navigator.userAgent))) startSilentAudio();
  ensureRunning();
}

async function syncWake() {
  if (!('wakeLock' in navigator)) return;
  const wanted = app.settings.keepAwake && document.visibilityState === 'visible';
  if (wanted && !state.wake) {
    try {
      state.wake = await navigator.wakeLock.request('screen');
      state.wake.addEventListener('release', () => {
        state.wake = null;
      });
    } catch (error) {
      state.wake = null;
    }
  } else if (!wanted && state.wake) {
    try {
      await state.wake.release();
    } catch (error) {
      void error;
    }
    state.wake = null;
  }
}

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const entry = app.current;
  try {
    if (!entry) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
      return;
    }
    const song = entry.song;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title,
      artist: song.artist || 'Escena',
      album: app.activeSetlist().name,
      artwork: [{ src: new URL('icons/icon-512.png', document.baseURI).href, sizes: '512x512', type: 'image/png' }],
    });
    navigator.mediaSession.playbackState = entry.player.state === 'playing' ? 'playing' : 'paused';
  } catch (error) {
    void error;
  }
}

function installMediaHandlers() {
  if (!('mediaSession' in navigator)) return;
  const handlers = {
    play: () => app.play(),
    pause: () => app.pause(),
    stop: () => app.stop(),
    previoustrack: () => app.previousSong(),
    nexttrack: () => app.nextSong(),
    seekbackward: () => app.previousSection(),
    seekforward: () => app.nextSection(),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(name, handler);
    } catch (error) {
      void error;
    }
  }
}

async function registerWorker() {
  if (!('serviceWorker' in navigator) || isNative() || !/^https?:$/.test(location.protocol)) return;
  try {
    const registration = await navigator.serviceWorker.register(new URL('sw.js', document.baseURI), { scope: new URL('./', document.baseURI).pathname });
    state.registration = registration;
    const announce = () => {
      if (registration.waiting && navigator.serviceWorker.controller) bus.emit('update');
    };
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      if (worker) worker.addEventListener('statechange', announce);
    });
    announce();
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (state.reloadOnChange) location.reload();
    });
  } catch (error) {
    console.warn(error);
  }
}

export const platform = {
  on: bus.on,
  get canInstall() {
    return Boolean(state.installEvent);
  },
  get installed() {
    return isStandalone() || isNative();
  },
  get native() {
    return isNative();
  },
  get ios() {
    return isIOS();
  },
  async install() {
    if (!state.installEvent) return false;
    state.installEvent.prompt();
    const choice = await state.installEvent.userChoice.catch(() => null);
    state.installEvent = null;
    bus.emit('install');
    return Boolean(choice && choice.outcome === 'accepted');
  },
  applyUpdate() {
    const waiting = state.registration && state.registration.waiting;
    if (!waiting) return;
    state.reloadOnChange = true;
    waiting.postMessage('skip');
  },
  async toggleFullscreen() {
    if (nativeBars()) {
      await setBars(state.barsHidden);
      return;
    }
    const root = document.documentElement;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (root.requestFullscreen) await root.requestFullscreen();
    } catch (error) {
      void error;
    }
  },
  async enterFullscreen() {
    if (nativeBars()) {
      await setBars(false);
      return;
    }
    const root = document.documentElement;
    try {
      if (!document.fullscreenElement && root.requestFullscreen) await root.requestFullscreen();
    } catch (error) {
      void error;
    }
  },
  async exitFullscreen() {
    if (nativeBars()) {
      await setBars(true);
      return;
    }
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
    } catch (error) {
      void error;
    }
  },
  syncWake,
};

export function installPlatform() {
  for (const type of ['pointerdown', 'touchend', 'keydown', 'click']) {
    window.addEventListener(type, unlock, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      ensureRunning();
      syncWake();
    }
  });
  window.addEventListener('focus', ensureRunning);
  app.engine.ctx.addEventListener('statechange', () => {
    const playing = app.player && app.player.state === 'playing';
    if (app.engine.ctx.state !== 'running' && playing) {
      app.toast('El audio se interrumpió. Toca la pantalla para continuar', 'error');
    }
  });
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.installEvent = event;
    bus.emit('install');
  });
  window.addEventListener('appinstalled', () => {
    state.installEvent = null;
    bus.emit('install');
  });
  if (!isNative()) {
    window.addEventListener('beforeunload', (event) => {
      if (app.player && app.player.state === 'playing') {
        event.preventDefault();
        event.returnValue = '';
      }
    });
  }
  installMediaHandlers();
  app.on('song:loaded', updateMediaSession);
  app.on('song:unloaded', updateMediaSession);
  app.on('transport', updateMediaSession);
  app.on('settings', (key) => {
    if (key === 'keepAwake') syncWake();
  });
  syncWake();
  registerWorker();
}
