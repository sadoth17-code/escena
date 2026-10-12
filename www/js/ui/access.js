import { access } from '../access.js';
import { app } from '../app.js';
import { h } from '../util.js';
import { openModal, field, icon } from './kit.js';

export function openAccess() {
  let modal;
  const body = h('div', { class: 'access-body' });
  const error = h('p', { class: 'field-hint warn', role: 'alert' });
  const input = h('input', { class: 'input', type: 'password', minlength: 6, maxlength: 64, autocomplete: 'off', 'aria-label': 'Clave maestra local' });
  const repeated = h('input', { class: 'input', type: 'password', minlength: 6, maxlength: 64, autocomplete: 'off', 'aria-label': 'Repetir clave maestra local' });
  const render = () => {
    error.textContent = '';
    if (access.cloudRole === 'player') {
      body.replaceChildren(h('div', { class: 'access-banner' }, icon('shield', 26), h('b', { text: 'Acceso de reproducción' })), h('p', { class: 'modal-text', text: 'Puedes reproducir, mezclar, cambiar el tono para esta sesión y usar el pad. Las portadas, secciones y pistas quedan protegidas.' }), h('p', { class: 'field-hint', text: 'Para administrar la biblioteca, conecta una clave maestra desde Nube. La clave local no cambia los permisos de la nube.' }));
      modal?.setActions([{ label: 'Listo', kind: 'primary', onClick: api => api.close() }]);
      return;
    }
    if (access.configured && access.canEdit) {
      body.replaceChildren(h('div', { class: 'access-banner' }, icon('unlock', 26), h('b', { text: 'Maestro activo' })), h('p', { class: 'modal-text', text: 'Puedes editar las canciones en este equipo. Al activar reproducción se bloquean la edición, importación y eliminación; el transporte, mezcla y pad siguen disponibles.' }), h('p', { class: 'field-hint', text: 'Al volver a abrir la aplicación se pedirá de nuevo la clave para editar. Cada equipo tiene su propia clave local.' }));
      modal?.setActions([{ label: 'Activar reproducción', kind: 'primary', icon: 'lock', onClick: () => { access.lock(); modal.close(); } }]);
      return;
    }
    const setup = !access.configured;
    body.replaceChildren(h('p', { class: 'modal-text', text: setup ? 'Crea una clave local para que otras personas puedan tocar sin modificar tus canciones. Guarda la clave: se usará para entrar al modo maestro en este equipo.' : 'Introduce la clave local para editar portadas, secciones y pistas.' }), field('Clave maestra local', input, 'Entre 6 y 64 caracteres.'), setup ? field('Repetir clave', repeated) : null, error);
    modal?.setActions([{ label: setup ? 'Guardar y bloquear' : 'Entrar como maestro', kind: 'primary', icon: 'shield', onClick: async api => {
      const button = api.footer.querySelector('button');
      button.disabled = true;
      try {
        if (setup) {
          if (input.value !== repeated.value) throw new Error('Las claves no coinciden.');
          await access.configure(input.value);
          access.lock();
        } else await access.unlock(input.value);
        api.close();
        app.toast(setup ? 'Modo reproducción activado' : 'Acceso maestro activado');
      } catch (reason) { error.textContent = reason.message; }
      finally { button.disabled = false; }
    } }]);
  };
  modal = openModal({ title: 'Acceso maestro', size: 'sm', className: 'access-modal', body });
  render();
  input.focus();
  return modal;
}
