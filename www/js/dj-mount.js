// Conecta la pestaña DJ con el resto de Escena.
//
// Se carga solo la primera vez que se abre la pestaña: así, si algo fallara en el DJ,
// Escena (multitrack, setlist, escenario…) sigue arrancando y funcionando igual que antes.

import { createDj } from './dj.js';
import { createDjStore } from './dj-store.js';
import { DjEngine, probeAudio } from './dj-engine.js';
import { createDjView } from './ui/dj-view.js';

export async function mountDj({ app, panel, onBadge = () => {} }) {
  const store = createDjStore();
  const engine = new DjEngine();

  const host = {
    toast: (message, kind) => app.toast(message, kind),
    // Al empezar el DJ se pausa el multitrack, para que nunca suenen los dos a la vez.
    pauseMultitrack: () => {
      if (app.player && (app.player.state === 'playing' || app.playbackIntent)) app.pause();
    },
    // La salida de audio que se elige en Ajustes vale también para el DJ.
    getSinkId: () => app.settings.sinkId || '',
    onSinkChange: (callback) => app.on('settings', (key) => {
      if (key === 'sinkId') callback(app.settings.sinkId || '');
    }),
    memoryGB: (typeof navigator !== 'undefined' && navigator.deviceMemory) || 4,
  };

  const dj = createDj({ store, engine, probe: probeAudio, host });
  await dj.init();
  const view = createDjView({ dj });
  panel.replaceChildren(view.el);

  // Punto verde en la pestaña mientras suena el DJ y se está en otra pestaña.
  let badge = false;
  dj.on('change', () => {
    const on = dj.state.transport === 'playing';
    if (on !== badge) {
      badge = on;
      onBadge(on);
    }
  });

  // Si arranca el multitrack mientras suena el DJ, el DJ se pausa (con un fundido corto).
  app.on('transport', () => {
    const player = app.player;
    if (player && player.state === 'playing' && dj.state.transport === 'playing') dj.pause();
  });

  // Guardar al salir o al ocultar la página.
  const save = () => {
    dj.flush();
  };
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') save();
  });

  return {
    dj,
    view,
    setActive(on) {
      dj.setActive(on);
      view.setActive(on);
    },
    pause() {
      return dj.pause();
    },
  };
}
