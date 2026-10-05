import { h, fmtBytes, isIOS } from '../util.js';
import { app } from '../app.js';
import { store } from '../store.js';
import { OUTPUT_MODES, ROUTE_KEYS, normalizeRoutes } from '../engine.js';
import { controls, ACTIONS } from '../controls.js';
import { platform } from '../platform.js';
import { icon, openModal, createSegmented, createSwitch, createRange, createGuideLanguageSelect, settingRow, field, dbLabel, confirmDialog } from './kit.js';

const DIAGRAMS = {
  split: (swap) => (swap ? ['Pistas', 'Click y guía'] : ['Click y guía', 'Pistas']),
  monitor: (swap) => (swap ? ['Sala', 'Monitor: todo'] : ['Monitor: todo', 'Sala']),
  stereo: () => ['Mezcla estéreo', 'Mezcla estéreo'],
};

const ROUTE_ROWS = [
  { key: 'salaL', label: 'Pistas · izquierda', color: '#35c9ff' },
  { key: 'salaR', label: 'Pistas · derecha', color: '#35c9ff' },
  { key: 'cue', label: 'Click y guía', color: '#ffb020' },
];

const PHONE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || isIOS();

function rangesText(list) {
  const parts = [];
  let start = list[0];
  let prev = list[0];
  for (let i = 1; i <= list.length; i++) {
    if (list[i] === prev + 1) {
      prev = list[i];
      continue;
    }
    parts.push(start === prev ? String(start + 1) : `${start + 1}-${prev + 1}`);
    start = list[i];
    prev = list[i];
  }
  return parts.join(', ');
}

function outputsText(list) {
  if (!list.length) return 'Sin salida';
  return `${list.length > 1 ? 'Salidas' : 'Salida'} ${rangesText(list)}`;
}

function section(title, detail, ...children) {
  return h('section', { class: 'settings-section' }, h('h3', { class: 'sub', text: title }), detail ? h('p', { class: 'field-hint', text: detail }) : null, ...children);
}

export function openSettings() {
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
  const current = () => app.settings.output;

  const cards = new Map();
  const modeGrid = h('div', { class: 'mode-grid', role: 'radiogroup', 'aria-label': 'Modo de salida' });
  const diagramFor = (id) => {
    const output = current();
    if (id === 'multi') {
      const pistas = Array.from(new Set([...output.routes.salaL, ...output.routes.salaR])).sort((a, b) => a - b);
      return { tags: ['Pistas', 'Click y guía'], texts: [outputsText(pistas), outputsText(output.routes.cue)] };
    }
    return { tags: ['L', 'R'], texts: DIAGRAMS[id](output.swap) };
  };
  const multiDetail = (mode) => {
    const output = current();
    const max = app.engine.maxChannels;
    if (app.engine.multiAvailable) return `${mode.detail}. Tu salida tiene ${max} canales.`;
    if (output.mode === 'multi') return `En espera: la salida actual tiene ${max} canales. Suena como Dividido hasta que conectes tu interfaz.`;
    return `Necesita una salida con más de 2 canales. La actual tiene ${max}.`;
  };
  const refreshModes = () => {
    const output = current();
    for (const mode of OUTPUT_MODES) {
      const card = cards.get(mode.id);
      const on = output.mode === mode.id;
      card.classList.toggle('active', on);
      card.setAttribute('aria-checked', on ? 'true' : 'false');
      const { tags, texts } = diagramFor(mode.id);
      card.querySelector('.d-tag-left').textContent = tags[0];
      card.querySelector('.d-tag-right').textContent = tags[1];
      card.querySelector('.d-left').textContent = texts[0];
      card.querySelector('.d-right').textContent = texts[1];
      if (mode.id === 'multi') {
        card.disabled = !app.engine.multiAvailable && output.mode !== 'multi';
        card.querySelector('.mode-detail').textContent = multiDetail(mode);
      }
    }
    swapRow.hidden = output.mode === 'stereo' || output.mode === 'multi';
  };
  for (const mode of OUTPUT_MODES) {
    const card = h(
      'button',
      {
        type: 'button',
        class: `mode-card${mode.id === 'multi' ? ' wide' : ''}`,
        role: 'radio',
        onClick: () => {
          app.setOutput({ mode: mode.id });
          refreshAll();
        },
      },
      h('b', { text: mode.name }),
      h('span', { class: 'mode-detail', text: mode.detail }),
      h(
        'div',
        { class: 'diagram' },
        h('div', { class: 'd-cell' }, h('i', { class: 'd-tag-left' }), h('span', { class: 'd-left' })),
        h('div', { class: 'd-cell' }, h('i', { class: 'd-tag-right' }), h('span', { class: 'd-right' }))
      )
    );
    cards.set(mode.id, card);
    modeGrid.append(card);
  }
  const swap = createSwitch({ value: current().swap, label: 'Invertir lados', onChange: (value) => { app.setOutput({ swap: value }); refreshAll(); } });
  const swapRow = settingRow('Invertir lados', 'Cambia qué lado lleva el click/monitor y cuál la sala', swap.el);

  const level = (label, key, hint) => {
    const range = createRange({ min: 0, max: 1, step: 0.005, value: current()[key], label, format: (value) => `${dbLabel(value)} dB`, onInput: (value) => app.setOutput({ [key]: value }) });
    return field(label, range.el, hint);
  };
  const limiter = createSwitch({ value: current().limiter, label: 'Limitador', onChange: (value) => app.setOutput({ limiter: value }) });
  const delay = createRange({ min: -150, max: 150, step: 1, value: current().cueDelayMs, label: 'Desfase del click y guías', format: (value) => `${value > 0 ? '+' : ''}${value} ms`, onInput: (value) => app.setOutput({ cueDelayMs: value }) });

  const routeBox = h('div', { class: 'route-box' });
  const routeHint = h('span', { class: 'field-hint' });
  const routeField = h('div', { class: 'field route-field' }, h('span', { class: 'field-label', text: 'Salidas de tu interfaz' }), routeBox, routeHint);
  const toggleRoute = (key, index) => {
    const routes = current().routes;
    const next = new Set(routes[key]);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    app.setOutput({ routes: normalizeRoutes({ ...routes, [key]: Array.from(next) }) });
    refreshAll();
  };
  const renderRoutes = () => {
    const output = current();
    routeField.hidden = output.mode !== 'multi';
    if (routeField.hidden) return;
    const routes = output.routes;
    const available = app.engine.maxChannels;
    const highest = Math.max(-1, ...ROUTE_KEYS.flatMap((key) => routes[key]));
    const columns = Math.max(available, highest + 1, 2);
    const grid = h('div', { class: 'route-grid', style: { '--cols': String(columns) }, role: 'group', 'aria-label': 'Salidas de tu interfaz para cada señal' });
    grid.append(h('span', { class: 'route-corner' }));
    for (let k = 0; k < columns; k++) grid.append(h('span', { class: `route-col${k >= available ? ' off' : ''}`, text: String(k + 1) }));
    for (const row of ROUTE_ROWS) {
      grid.append(h('span', { class: 'route-name', style: { '--c': row.color }, text: row.label }));
      for (let k = 0; k < columns; k++) {
        const on = routes[row.key].includes(k);
        grid.append(
          h(
            'button',
            {
              type: 'button',
              class: `route-cell${on ? ' on' : ''}${k >= available ? ' off' : ''}`,
              style: { '--c': row.color },
              'aria-pressed': on ? 'true' : 'false',
              'aria-label': `${row.label} por la salida ${k + 1}`,
              title: k >= available ? 'Esta salida no existe en el dispositivo actual' : `${row.label} · salida ${k + 1}`,
              onClick: () => toggleRoute(row.key, k),
            },
            on ? icon('check', 16) : null
          )
        );
      }
    }
    routeBox.replaceChildren(grid);
    const empty = ROUTE_ROWS.filter((row) => !routes[row.key].length).map((row) => row.label.toLowerCase());
    const beyond = highest >= available;
    const parts = ['Marca por qué salidas de tu interfaz suena cada fila; puedes marcar varias. Ejemplo: pistas por 1 y 2 para la sala, y click y guía por 3 para el baterista.'];
    if (empty.length) parts.push(`Sin salida asignada, no se oirá: ${empty.join(', ')}.`);
    if (beyond) parts.push('Hay rutas hacia salidas que el dispositivo actual no tiene; se ignoran hasta que conectes tu interfaz.');
    if (new Set(routes.salaL).size && routes.salaL.some((k) => routes.salaR.includes(k))) parts.push('Si izquierda y derecha comparten una salida, esa salida lleva las pistas en mono.');
    routeHint.textContent = parts.join(' ');
  };

  const toneLabel = h('span', { class: 'field-label' });
  const toneBox = h('div', { class: 'tone-row' });
  const toneHint = h('span', { class: 'field-hint' });
  const toneField = h('div', { class: 'field' }, toneLabel, toneBox, toneHint);
  const play = (fn) => app.engine.resume().then(fn).catch((error) => app.toast(error.message, 'error'));
  const renderTones = () => {
    if (app.engine.multiActive && current().mode === 'multi') {
      toneLabel.textContent = 'Prueba de salidas';
      toneHint.textContent = 'Pulsa un número: suena un tono solo por esa salida de tu interfaz. Compruébalo con tus audífonos o altavoces conectados.';
      const count = app.engine.multi.count;
      toneBox.replaceChildren(...Array.from({ length: count }, (_, k) => h('button', { type: 'button', class: 'btn tone-n', 'aria-label': `Probar la salida ${k + 1}`, onClick: () => play(() => app.engine.playChannelTone(k)) }, icon('speaker', 16), String(k + 1))));
      return;
    }
    toneLabel.textContent = 'Prueba de canales';
    toneHint.textContent = 'Debes oír cada tono solo en el lado indicado.';
    toneBox.replaceChildren(
      ...[
        ['L', 'Izquierdo'],
        ['R', 'Derecho'],
        ['both', 'Ambos'],
      ].map(([side, label]) => h('button', { type: 'button', class: 'btn', onClick: () => play(() => app.engine.playTone(side)) }, icon('speaker', 18), label))
    );
  };

  const deviceSelect = h('select', { class: 'select', 'aria-label': 'Dispositivo de salida' });
  const deviceNote = h('span', { class: 'field-hint' });
  const deviceBox = h('div', { class: 'device-box' });
  const renderNote = () => {
    const max = app.engine.maxChannels;
    if (app.sinkState === 'missing') {
      deviceNote.className = 'field-hint warn';
      deviceNote.textContent = `${app.settings.sinkLabel || 'La salida guardada'} no está conectada. Mientras tanto suena por la salida del sistema; cuando la conectes se usa sola.`;
      return;
    }
    deviceNote.className = 'field-hint';
    deviceNote.textContent = max > 2 ? `Esta salida tiene ${max} canales (salidas 1 a ${max}).` : 'Esta salida tiene 2 canales (estéreo).';
  };
  const loadDevices = async () => {
    if (PHONE || !app.canPickDevice || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      deviceBox.replaceChildren(h('p', { class: 'field-hint', text: 'Este dispositivo usa la salida de audio que elijas en el sistema (Bluetooth, auriculares, interfaz USB).' }));
      return;
    }
    const found = await app.outputDevices();
    const devices = found.filter((device) => device.deviceId !== 'default' && device.deviceId !== 'communications');
    const labelled = found.some((device) => device.label);
    const saved = app.settings.sinkId;
    const options = [h('option', { value: '', text: 'Predeterminado del sistema' })];
    devices.forEach((device, index) => options.push(h('option', { value: device.deviceId, text: device.label || `Salida ${index + 1}` })));
    if (saved && !devices.some((device) => device.deviceId === saved)) options.push(h('option', { value: saved, text: `${app.settings.sinkLabel || 'Salida guardada'} (no conectada)` }));
    deviceSelect.replaceChildren(...options);
    deviceSelect.value = saved || '';
    renderNote();
    const showNames = h('button', {
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
    }, 'Mostrar nombres de los dispositivos');
    deviceBox.replaceChildren(...[deviceSelect, deviceNote, devices.length && !labelled ? showNames : null].filter(Boolean));
  };
  deviceSelect.addEventListener('change', () => {
    const label = deviceSelect.selectedOptions.length ? deviceSelect.selectedOptions[0].textContent : '';
    app.chooseSink(deviceSelect.value, label);
  });

  const refreshAll = () => {
    refreshModes();
    renderRoutes();
    renderTones();
    if (deviceNote.isConnected) renderNote();
  };
  unsubscribe.push(
    app.on('outputs', () => {
      refreshAll();
      loadDevices();
    })
  );
  loadDevices();

  const audioStatus = h('span', { class: 'field-hint', role: 'status' });
  const renderAudioStatus = () => {
    audioStatus.textContent = {
      running: 'Audio activo. Usa «Ambos» para comprobar que se escucha.',
      suspended: 'Audio en espera. Toca Reactivar audio o Reproducir.',
      interrupted: 'Audio interrumpido por el dispositivo. Vuelve a Escena y toca Reactivar audio.',
      closed: 'Audio cerrado. Recarga Escena para continuar.',
    }[app.engine.ctx.state] || 'Comprueba el audio con la prueba de canales.';
  };
  app.engine.ctx.addEventListener('statechange', renderAudioStatus);
  unsubscribe.push(() => app.engine.ctx.removeEventListener('statechange', renderAudioStatus));
  renderAudioStatus();
  const outputSection = section(
    'Salida de audio',
    'Elige tu dispositivo de audio y cómo se reparte el sonido entre sus salidas.',
    field('Dispositivo de salida', deviceBox),
    field('Estado de audio', h('div', { class: 'row-actions' }, audioStatus, h('button', { type: 'button', class: 'btn small', onClick: () => play(renderAudioStatus) }, 'Reactivar audio'))),
    modeGrid,
    routeField,
    swapRow,
    level('Nivel Master', 'master'),
    level('Nivel Sala (pistas)', 'mainLevel'),
    level('Nivel Cue (click y guías)', 'cueLevel'),
    settingRow('Limitador', 'Evita saturación en la salida (recomendado)', limiter.el),
    field('Desfase del cue', delay.el, 'Mueve el click y las guías respecto a las pistas, útil si usas auriculares inalámbricos.'),
    toneField
  );
  refreshAll();

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
    field('Saltos entre secciones', jump.el, 'Compás: sigue tocando y cambia al terminar el compás actual. Se aplica a pantalla, teclado y MIDI; se guarda en este dispositivo.'),
    field('Al terminar la canción', after.el),
    gap,
    settingRow('Pre-conteo automático', 'Cuenta antes de empezar desde el inicio', autoCount.el),
    settingRow('Precargar la siguiente canción', 'Entrada sin cortes entre canciones; usa más memoria', preload.el),
    settingRow('Mantener pantalla encendida', 'Evita que el dispositivo se bloquee mientras tocas', awake.el)
  );

  const guideLanguage = createGuideLanguageSelect({
    value: app.settings.guideLang,
    onChange: async (value) => {
      await app.setGuideLanguage(value);
      app.previewVoice('coro');
    },
  });
  const guideListen = h('button', { type: 'button', class: 'btn small', onClick: () => app.previewVoice('coro') }, icon('speaker', 16), 'Escuchar');
  const guideSection = section(
    'Guía de voz',
    'En qué idioma dice la guía el nombre de cada sección. Se aplica a todas las canciones de este dispositivo y se oye al instante.',
    field(
      'Idioma de la guía',
      h('div', { class: 'inline' }, guideLanguage, guideListen),
      'Español viene incluido. Inglés, portugués y francés se descargan la primera vez que los eliges (unos 2,5 MB cada uno) y quedan guardados para usarlos sin internet. «Voz original» es la voz sintética que tenía Escena. Algunas indicaciones no existen en todos los idiomas: el editor lo avisa en la lista de voces.'
    )
  );

  const controlsBox = h('div', { class: 'controls-box' });
  const midiBox = h('div', { class: 'midi-box' });
  const renderControls = () => {
    const list = h('div', { class: 'bind-list' });
    const sections = controls.sectionActions();
    for (const action of [...ACTIONS, ...sections]) {
      if (action === sections[0]) list.append(
        h('h4', { class: 'sub', text: `Secciones de «${app.current.song.title}»` }),
        h('p', { class: 'field-hint', text: 'Pulsa Asignar y luego un botón del controlador. Cada asignación sigue a esta sección aunque cambies su nombre u orden. Se guarda para esta canción en este dispositivo.' })
      );
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
      list.append(h('div', { class: 'bind-row', 'data-action': action.id }, h('span', { class: 'bind-name', text: action.name }), h('div', { class: 'bind-chips' }, chips, learn)));
    }
    if (!sections.length) list.append(h('p', { class: 'field-hint', text: 'Carga una canción para asignar MIDI a sus secciones.' }));
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
  unsubscribe.push(controls.on('midi', renderMidi), app.on('song:loaded', renderControls), app.on('song:unloaded', renderControls));
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
  const appSection = section('Aplicación', null, installBox, usageText, persistButton, h('p', { class: 'field-hint', text: 'Escena · Nube v5 · Click y guías · ingvelarde.com' }));

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

  modal.body.firstChild.replaceChildren(outputSection, playbackSection, guideSection, controlsSection, appSection, h('div', { class: 'danger-zone' }, wipe));
  return modal;
}
