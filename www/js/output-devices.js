// Lectura de las salidas de audio que ve el navegador y mensajes para cuando no enseña sus nombres.
//
// Chrome y Edge no entregan identificadores ni nombres de los dispositivos de audio hasta que la página tiene el
// permiso del micrófono. Antes de eso enumerateDevices() devuelve una sola entrada por tipo, con deviceId y label
// vacíos. Por eso la interfaz de audio conectada no aparecía con su nombre (ni siquiera aparecía) y tampoco había
// forma de pedir el permiso que lo arregla.

const SYSTEM_PREFIX = /^(?:default|predeterminad[oa]|por defecto)\s+[-–—]\s+(.+)$/i;
const SYSTEM_WORD = /^(?:default|predeterminad[oa]|por defecto)$/i;

// Chrome etiqueta la salida del sistema como «Default - Nombre del dispositivo» (o «Predeterminado - …»).
// Se deja solo el nombre del dispositivo que está sonando por defecto.
export function cleanDefaultLabel(label) {
  const text = String(label || '').trim();
  if (!text || SYSTEM_WORD.test(text)) return '';
  const match = SYSTEM_PREFIX.exec(text);
  return match ? match[1].trim() : text;
}

// list: lo que devuelve navigator.mediaDevices.enumerateDevices().
//   devices     salidas que se pueden usar (tienen identificador)
//   named       alguna de ellas trae su nombre; si es false, falta el permiso del micrófono
//   defaultName nombre del dispositivo que usa el sistema por defecto, si el navegador lo dice
export function summarizeOutputs(list) {
  const outputs = Array.isArray(list) ? list.filter((device) => device && device.kind === 'audiooutput') : [];
  const devices = outputs.filter((device) => device.deviceId);
  const named = devices.some((device) => device.label);
  const system = devices.find((device) => device.deviceId === 'default');
  return { devices, named, defaultName: cleanDefaultLabel(system && system.label) };
}

// Qué decirle a la persona cuando getUserMedia() no concede el permiso que muestra los nombres.
export function nameAccessMessage(error) {
  const name = error && error.name;
  // Chrome usa el mismo error si cierras el aviso sin responder («Permission dismissed») que si lo bloqueas.
  if (name === 'NotAllowedError' && /dismiss/i.test(String(error.message || ''))) {
    return 'Cerraste el aviso del navegador sin responder. Pulsa de nuevo y elige «Permitir».';
  }
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return 'El micrófono está bloqueado para este sitio. Pulsa el candado junto a la dirección, permite el micrófono y vuelve a intentarlo.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    return 'El navegador no encuentra ningún micrófono y lo pide para poder mostrar los nombres. Conecta tu interfaz con su entrada activa y vuelve a intentarlo.';
  }
  if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') {
    return 'Otra aplicación está usando el micrófono. Ciérrala y vuelve a intentarlo.';
  }
  if (name === 'NotSupportedError' || name === 'TypeError') {
    return 'Este navegador no deja pedir ese permiso desde la página. Prueba en Chrome o Edge.';
  }
  return 'No se pudo pedir el permiso del micrófono. Revisa los permisos del sitio y vuelve a intentarlo.';
}

// Qué decir cuando selectAudioOutput() (el selector propio del navegador) no devuelve una salida.
// Cerrar la ventana sin elegir no es un error: no se dice nada.
export function selectOutputMessage(error) {
  const name = error && error.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return '';
  if (name === 'NotFoundError') return 'El navegador no encontró otras salidas de audio.';
  return 'No se pudo abrir la lista de salidas del navegador.';
}
