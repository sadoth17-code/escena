import { h, fmtBytes } from '../util.js';
import { app } from '../app.js';
import { store } from '../store.js';
import { OUTPUT_MODES } from '../engine.js';
import { controls, ACTIONS } from '../controls.js';
import { platform } from '../platform.js';
import { icon, openModal, createSegmented, createSwitch, createRange, settingRow, field, dbLabel, confirmDialog } from './kit.js';

const DIAGRAMS = {
  split: (swap) => (swap ? ['Pistas', 'Click y guía'] : ['Click y guía', 'Pistas']),
  monitor: (swap) => (swap ? ['Sala', 'Monitor: todo'] : ['Monitor: todo', 'Sala']),
  stereo: () => ['Mezcla estéreo', 'Mezcla estéreo'],
};

function section(title, detail, ...children) {
  return h('section', { class: 'settings-section' }, h('h3', { class: 'sub', text: title }), detail ? h('p', { class: 'field-hint', text: detail }) : null, ...children);
}

export function openSettings() {
  const output = app.settings.output;
  const unsubscribe = [];
  const modal = openModal({
    title: 'Ajustes',
    size: 'xl',
    className: 'settings',
    body: h('div', { class: 'settings-body' }),
    actions: [{ label: 'Listo', kind: 'primary', icon: 'check', onClick: (api) => api.close() }],
    onClose: () => {
      controls.cancelLearn();
      unsubscribe.forEach((fn) => fn());
    },
  });

  const cards = new Map();
  const modeGrid = h('div', { class: 'mode-grid', role: 'radiogroup', 'aria-label': 'Modo de salida' });
  const refreshModes = () => {
    for (const [id, card] of cards) {
      const on = output.mode === id;
      card.classList.toggle('active', on);
      card.setAttribute('aria-checked', on ? 'true' : 'false');
      const [left, right] = DIAGRAMS[id](output.swap);
      card.querySelector('.d-left').textContent = left;
      card.querySelector('.d-right').textContent = right;
    }
    swapRow.hidden = output.mode === 'stereo';
  };
  for (const mode of OUTPUT_MODES) {
    const card = h(
      'button',
      {
        type: 'button',
        class: 'mode-card',
        role: 'radio',
        onClick: () => {
          app.setOutput({ mode: mode.id });
          refreshModes();
        },
      },
      h('b', { text: mode.name }),
      h('span', { class: 'mode-detail', text: mode.detail }),
      h('div', { class: 'diagram' }, h('div', { class: 'd-cell' }, h('i', { text: 'L' }), h('span', { class: 'd-left' })), h('div', { class: 'd-cell' }, h('i', { text: 'R' }), h('span', { class: 'd-right' })))
    );
    cards.set(mode.id, card);
    modeGrid.append(card);
  }
  const swap = createSwitch({ value: output.swap, label: 'Invertir lados', onChange: (value) => { app.setOutput({ swap: value }); refreshModes(); } });
  const swapRow = settingRow('Invertir lados', 'Cambia qué lado lleva el click/monitor y cuál la sala', swap.el);

  const level = (label, key, hint) => {
    const range = createRange({ min: 0, max: 1, step: 0.005, value: output[key], label, format: (value) => `${dbLabel(value)} dB`, onInput: (value) => app.setOutput({ [key]: value }) });
    return field(label, range.el, hint);
  };
  const limiter = createSwitch({ value: output.limiter, label: 'Limitador', onChange: (value) => app.setOutput({ limiter: value }) });
  const delay = createRange({ min: -150, max: 150, step: 1, value: output.cueDelayMs, label: 'Desfase del click y guías', format: (value) => `${value > 0 ? '+' : ''}${value} ms`, onInput: (value) => app.setOutput({ cueDelayMs: value }) });

  const toneRow = h(
    'div',
    { class: 'tone-row' },
    ...[
      ['L', 'Izquierdo'],
      ['R', 'Derecho'],
      ['both', 'Ambos'],
    ].map(([side, label]) => h('button', { type: 'button', class: 'btn', onClick: () => app.engine.resume().then(() => app.engine.playTone(side)) }, icon('speaker', 18), label))
  );

  const deviceSelect = h('select', { class: 'select', 'aria-label': 'Dispositivo de salida' });
  const deviceBox = h('div', { class: 'device-box' });
  const loadDevices = async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices || typeof app.engine.ctx.setSinkId !== 'function') {
      deviceBox.replaceChildren(h('p', { class: 'field-hint', text: 'Este dispositivo usa la salida de audio que elijas en el sistema (Bluetooth, auriculares, interfaz).' }));
      return;
    }
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audiooutput');
    const labelled = devices.some((device) => device.label);
    deviceSelect.replaceChildren(h('option', { value: '', text: 'Predeterminado del sistema' }), ...devices.filter((device) => device.deviceId !== 'default').map((device, index) => h('option', { value: device.deviceId, text: device.label || `Salida ${index + 1}`, selected: device.deviceId === app.settings.sinkId })));
    deviceSelect.value = app.settings.sinkId || '';
    deviceBox.replaceChildren(
      deviceSelect,
      labelled
        ? null
        : h('button', {
            type: 'button',
            class: 'btn small',
            onClick: async () => {
              try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                stream.getTracks().forEach((track) => track.stop());
              } catch (error) {
                app.toast('No se concedió el permiso para ver los nombres', 'error');
              }
              loadDevices();
            },
          }, 'Mostrar nombres de los dispositivos')
    );
  };
  deviceSelect.addEventListener('change', async () => {
    app.setSetting('sinkId', deviceSelect.value);
    try {
      await app.engine.setSinkId(deviceSelect.value);
    } catch (error) {
      app.toast('No se pudo usar ese dispositivo', 'error');
    }
  });
  loadDevices();

  const outputSection = section(
    'Salida de audio',
    'Elige cómo se reparte el sonido entre los dos canales de tu salida.',
    modeGrid,
    swapRow,
    level('Nivel Master', 'master'),
    level('Nivel Sala (pistas)', 'mainLevel'),
    level('Nivel Cue (click y guías)', 'cueLevel'),
    settingRow('Limitador', 'Evita saturación en la salida (recomendado)', limiter.el),
    field('Desfase del cue', delay.el, 'Mueve el click y las guías respecto a las pistas, útil si usas auriculares inalámbricos.'),
    field('Prueba de canales', toneRow, 'Debes oír cada tono solo en el lado indicado.'),
    field('Dispositivo de salida', deviceBox)
  );
  refreshModes();

  const jump = createSegmented({
    options: [
      { value: 'bar', label: 'Compás' },
      { value: 'beat', label: 'Tiempo' },
      { value: 'now', label: 'Inmediato' },
    ],
    value: app.settings.jumpMode,
    label: 'Salto de sección',
    onChange: (value) => app.setSetting('jumpMode', value),
  });
  const after = createSegmented({
    options: [
      { value: 'stop', label: 'Detener' },
      { value: 'next', label: 'Siguiente canción' },
    ],
    value: app.settings.afterSong,
    label: 'Al terminar la canción',
    onChange: (value) => {
      app.setSetting('afterSong', value);
      gap.hidden = value !== 'next';
      app.discardNext();
      app.preloadNext();
    },
  });
  const gapRange = createRange({ min: 0, max: 15, step: 1, value: app.settings.gapSeconds, label: 'Pausa entre canciones', format: (value) => `${value} s`, onInput: (value) => app.setSetting('gapSeconds', value) });
  const gap = field('Pausa entre canciones', gapRange.el);
  gap.hidden = app.settings.afterSong !== 'next';
  const autoCount = createSwitch({ value: app.settings.autoCountIn, label: 'Pre-conteo automático', onChange: (value) => app.setSetting('autoCountIn', value) });
  const preload = createSwitch({
    value: app.settings.preloadNext,
    label: 'Precargar la siguiente canción',
    onChange: (value) => {
      app.setSetting('preloadNext', value);
      if (value) app.preloadNext();
      else app.discardNext();
    },
  });
  const awake = createSwitch({ value: app.settings.keepAwake, label: 'Mantener pantalla encendida', onChange: (value) => app.setSetting('keepAwake', value) });
  const playbackSection = section(
    'Reproducción',
    null,
    field('Saltos entre secciones', jump.el, 'Cuándo se ejecuta el salto al tocar una sección o usar el pedal.'),
    field('Al terminar la canción', after.el),
    gap,
    settingRow('Pre-conteo automático', 'Cuenta antes de empezar desde el inicio', autoCount.el),
    settingRow('Precargar la siguiente canción', 'Entrada sin cortes entre canciones; usa más memoria', preload.el),
    settingRow('Mantener pantalla encendida', 'Evita que el dispositivo se bloquee mientras tocas', awake.el)
  );

  const controlsBox = h('div', { class: 'controls-box' });
  const midiBox = h('div', { class: 'midi-box' });
  const renderControls = () => {
    const list = h('div', { class: 'bind-list' });
    for (const action of ACTIONS) {
      const triggers = controls.triggersFor(action.id);
      const chips = triggers.map((trigger) =>
        h('span', { class: 'bind-chip' }, controls.label(trigger), h('button', { type: 'button', class: 'bind-x', 'aria-label': 'Quitar', onClick: () => { controls.unassign(action.id, trigger); renderControls(); } }, icon('close', 12)))
      );
      const learn = h('button', { type: 'button', class: 'btn small', onClick: async () => {
        learnBtn.textContent = 'Pulsa tecla, pedal o nota MIDI…';
        learnBtn.classList.add('listening');
        const trigger = await controls.learn();
        if (trigger) controls.assign(action.id, trigger);
        renderControls();
      } }, icon('plus', 14), 'Asignar');
      const learnBtn = learn;
      list.append(h('div', { class: 'bind-row' }, h('span', { class: 'bind-name', text: action.name }), h('div', { class: 'bind-chips' }, chips, learn)));
    }
    controlsBox.replaceChildren(
      list,
      h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn small', onClick: () => { controls.reset(); renderControls(); } }, 'Restablecer atajos'), controls.learning ? h('button', { type: 'button', class: 'btn small', onClick: () => { controls.cancelLearn(); renderControls(); } }, 'Cancelar') : null)
    );
  };
  const renderMidi = () => {
    const midi = controls.midi;
    const statusText = {
      off: 'MIDI desactivado',
      unsupported: 'Este navegador no permite MIDI. Los pedales Bluetooth que actúan como teclado sí funcionan.',
      denied: 'No se concedió el permiso de MIDI',
      ready: midi.inputs.length ? `Conectado: ${midi.inputs.join(', ')}` : 'MIDI activo. Conecta un controlador o pedal MIDI',
    }[midi.status];
    const enable = createSwitch({
      value: app.settings.midiEnabled,
      label: 'Activar MIDI',
      onChange: (value) => {
        app.setSetting('midiEnabled', value);
        if (value) controls.enableMidi();
        else controls.disableMidi();
      },
    });
    const program = createSwitch({ value: app.settings.midiProgramChange, label: 'Cambio de programa selecciona canción', onChange: (value) => app.setSetting('midiProgramChange', value) });
    midiBox.replaceChildren(
      settingRow('Activar MIDI', statusText, enable.el),
      settingRow('Cambio de programa MIDI', 'El programa 1 carga la primera canción del setlist, el 2 la segunda…', program.el)
    );
  };
  unsubscribe.push(controls.on('midi', renderMidi), controls.on('learn', () => {}));
  renderControls();
  renderMidi();
  const controlsSection = section(
    'Teclado, pedal y MIDI',
    'Los pedales Bluetooth (AirTurn, PageFlip, iRig BlueTurn…) se comportan como un teclado: pulsa «Asignar» y pisa el pedal.',
    controlsBox,
    midiBox
  );

  const usageText = h('p', { class: 'field-hint', text: 'Calculando…' });
  const persistButton = h('button', { type: 'button', class: 'btn small', onClick: async () => {
    const ok = await store.requestPersistence();
    app.toast(ok ? 'Almacenamiento permanente activado' : 'El sistema no concedió almacenamiento permanente', ok ? 'info' : 'error');
    refreshUsage();
  } }, icon('shield', 16), 'Proteger mis canciones');
  const refreshUsage = async () => {
    const usage = await store.usage();
    const persistent = await store.isPersistent();
    usageText.textContent = `Canciones guardadas en este dispositivo: ${fmtBytes(usage.used)}${usage.quota ? ` de ${fmtBytes(usage.quota)} disponibles` : ''}. ${persistent ? 'Protegidas contra borrado automático.' : 'El sistema podría borrarlas si necesita espacio.'}`;
    persistButton.hidden = persistent;
  };
  refreshUsage();
  const installBox = h('div', { class: 'install-box' });
  const renderInstall = () => {
    const nodes = [];
    if (platform.native) {
      nodes.push(h('p', { class: 'field-hint', text: 'Estás usando la aplicación instalada.' }));
    } else if (platform.installed) {
      nodes.push(h('p', { class: 'field-hint', text: 'Estás usando la aplicación instalada.' }));
    } else if (platform.canInstall) {
      nodes.push(h('button', { type: 'button', class: 'btn primary', onClick: () => platform.install() }, icon('download', 18), 'Instalar aplicación'));
    } else if (platform.ios) {
      nodes.push(h('p', { class: 'field-hint', text: 'En iPhone/iPad: toca el botón Compartir de Safari y elige «Añadir a pantalla de inicio». Así funciona a pantalla completa y sin conexión.' }));
    } else {
      nodes.push(h('p', { class: 'field-hint', text: 'Puedes instalarla desde el menú de tu navegador («Instalar Escena» o «Añadir a pantalla de inicio»).' }));
    }
    installBox.replaceChildren(...nodes);
  };
  unsubscribe.push(platform.on('install', renderInstall));
  renderInstall();
  const appSection = section('Aplicación', null, installBox, usageText, persistButton, h('p', { class: 'field-hint', text: 'Escena 1.0 · Funciona sin conexión · ingvelarde.com' }));

  const wipe = h('button', {
    type: 'button',
    class: 'btn danger small',
    onClick: async () => {
      const ok = await confirmDialog({ title: 'Restablecer ajustes', message: 'Se restablecerán salida, atajos y preferencias. Tus canciones no se borran.', confirm: 'Restablecer', danger: true });
      if (!ok) return;
      app.resetSettings();
      modal.close();
      app.toast('Ajustes restablecidos');
    },
  }, 'Restablecer ajustes');

  modal.body.firstChild.replaceChildren(outputSection, playbackSection, controlsSection, appSection, h('div', { class: 'danger-zone' }, wipe));
  return modal;
}
