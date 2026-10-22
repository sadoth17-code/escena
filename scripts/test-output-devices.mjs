// Run with: node scripts/test-output-devices.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = await readFile(new URL('../www/js/output-devices.js', import.meta.url), 'utf8');
const { cleanDefaultLabel, summarizeOutputs, nameAccessMessage, selectOutputMessage } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const device = (kind, deviceId, label = '') => ({ kind, deviceId, label, groupId: '' });

test('Chrome sin permiso del micrófono: una entrada vacía por tipo no cuenta como salida usable', () => {
  // Es lo que devuelve un Chrome real la primera vez que se abre Escena (medido en Chromium 141).
  const report = summarizeOutputs([device('audioinput', ''), device('videoinput', ''), device('audiooutput', '')]);
  assert.deepEqual(report.devices, []);
  assert.equal(report.named, false);
  assert.equal(report.defaultName, '');
});

test('con el permiso concedido se ven la salida del sistema y la interfaz con su nombre', () => {
  const report = summarizeOutputs([
    device('audioinput', 'default', 'Default - Micrófono (Focusrite USB Audio)'),
    device('audiooutput', 'default', 'Default - Altavoces (Realtek(R) Audio)'),
    device('audiooutput', 'communications', 'Communications - Altavoces (Realtek(R) Audio)'),
    device('audiooutput', 'a1b2', 'Altavoces (Realtek(R) Audio)'),
    device('audiooutput', 'c3d4', 'Salida 1-2 (Focusrite USB Audio)'),
  ]);
  assert.equal(report.named, true);
  assert.deepEqual(report.devices.map((item) => item.deviceId), ['default', 'communications', 'a1b2', 'c3d4']);
  assert.equal(report.defaultName, 'Altavoces (Realtek(R) Audio)');
});

test('identificadores sin nombre (otros navegadores) siguen pidiendo mostrar los nombres', () => {
  const report = summarizeOutputs([device('audiooutput', 'x1'), device('audiooutput', 'x2')]);
  assert.equal(report.devices.length, 2);
  assert.equal(report.named, false);
});

test('una lista inválida o vacía no rompe nada', () => {
  for (const value of [undefined, null, [], {}, 'x', [null, undefined, 3]]) {
    const report = summarizeOutputs(value);
    assert.deepEqual(report.devices, []);
    assert.equal(report.named, false);
    assert.equal(report.defaultName, '');
  }
});

test('cleanDefaultLabel deja solo el nombre del dispositivo', () => {
  assert.equal(cleanDefaultLabel('Default - Altavoces (Realtek(R) Audio)'), 'Altavoces (Realtek(R) Audio)');
  assert.equal(cleanDefaultLabel('Predeterminado - Auriculares USB'), 'Auriculares USB');
  assert.equal(cleanDefaultLabel('Predeterminada – Salida 1-2 (USB-Audio 2.0)'), 'Salida 1-2 (USB-Audio 2.0)');
  assert.equal(cleanDefaultLabel('Focusrite USB Audio'), 'Focusrite USB Audio');
  assert.equal(cleanDefaultLabel('Default'), '');
  assert.equal(cleanDefaultLabel(''), '');
  assert.equal(cleanDefaultLabel(undefined), '');
});

test('el mensaje del permiso dice qué hacer en cada caso', () => {
  const blocked = nameAccessMessage({ name: 'NotAllowedError' });
  const missing = nameAccessMessage({ name: 'NotFoundError' });
  const busy = nameAccessMessage({ name: 'NotReadableError' });
  const unsupported = nameAccessMessage({ name: 'NotSupportedError' });
  const other = nameAccessMessage({ name: 'Algo' });
  const dismissed = nameAccessMessage({ name: 'NotAllowedError', message: 'Permission dismissed' });
  assert.match(blocked, /bloqueado/);
  assert.match(dismissed, /Cerraste el aviso/);
  assert.match(nameAccessMessage({ name: 'NotAllowedError', message: 'Permission denied' }), /bloqueado/);
  assert.match(missing, /ningún micrófono/);
  assert.match(busy, /otra aplicación/i);
  assert.match(unsupported, /Chrome o Edge/);
  assert.equal(new Set([blocked, dismissed, missing, busy, unsupported, other]).size, 6);
  assert.equal(nameAccessMessage(undefined), other);
  assert.equal(nameAccessMessage(null), other);
});

test('cerrar el selector del navegador sin elegir no se trata como error', () => {
  assert.equal(selectOutputMessage({ name: 'NotAllowedError' }), '');
  assert.equal(selectOutputMessage({ name: 'AbortError' }), '');
  assert.match(selectOutputMessage({ name: 'NotFoundError' }), /otras salidas/);
  assert.match(selectOutputMessage(new Error('x')), /No se pudo abrir/);
});
