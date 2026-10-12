import { cloud } from '../cloud.js';
import { h } from '../util.js';
import { icon } from './kit.js';

let pending = null;

function lockPage(locked) {
  document.body.dataset.session = locked ? 'locked' : 'active';
  const root = document.getElementById('app');
  if (root) root.inert = locked;
}

// The server authorizes songs and account changes. This screen also prevents
// ordinary use of downloaded songs without a verified, unexpired account.
export function ensureApprovedAccess(reason = '') {
  if (pending) return pending;
  lockPage(true);
  pending = (async () => {
    let message = reason;
    try {
      await cloud.checkAccess();
      if (cloud.canAccess) { lockPage(false); return; }
    } catch (error) { message ||= error.message; }

    await new Promise(resolve => {
      const input = h('input', {
        class: 'input', type: 'password', autocomplete: 'current-password',
        spellcheck: 'false', maxlength: 64, required: true,
        'aria-label': 'Clave personal', placeholder: 'Pega tu clave personal',
      });
      const status = h('p', { class: 'session-error', role: 'alert', text: message });
      const button = h('button', { type: 'submit', class: 'btn primary block' }, 'Entrar');
      const form = h('form', { class: 'session-form' },
        h('label', { class: 'session-label' }, 'Clave personal', input), status, button);
      const card = h('section', {
        class: 'session-card', role: 'dialog', 'aria-modal': 'true',
        'aria-labelledby': 'session-title',
      }, h('div', { class: 'session-brand' }, icon('wave', 32), 'ESCENA'),
      h('h1', { id: 'session-title', text: 'Entrar a Escena' }),
      h('p', { class: 'session-copy', text: 'Usa la clave que te entregó el propietario. Cada persona necesita un acceso aprobado.' }),
      form,
      h('p', { class: 'field-hint', text: 'Sin conexión, puedes entrar con tu clave si este equipo conserva una autorización vigente.' }));
      const layer = h('div', { class: 'session-gate' }, card);
      document.body.append(layer);
      let busy = false;
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy) return;
        busy = true; button.disabled = true; input.disabled = true;
        button.textContent = 'Comprobando…'; status.textContent = '';
        try {
          await cloud.connect(cloud.api, input.value);
          if (!cloud.canAccess) throw new Error('No hay una autorización vigente para entrar.');
          input.value = ''; layer.remove(); lockPage(false); resolve();
        } catch (error) { status.textContent = error.message; }
        finally {
          busy = false; button.disabled = false; input.disabled = false;
          button.textContent = 'Entrar';
        }
      });
      input.focus();
    });
  })().finally(() => { pending = null; });
  return pending;
}
