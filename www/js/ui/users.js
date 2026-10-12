import { h } from '../util.js';
import { cloud } from '../cloud.js';
import { openModal, field, confirmDialog, icon } from './kit.js';

const ROLES = [{ value: 'player', label: 'Músico' }, { value: 'editor', label: 'Editor' }];
const OFFLINE = [
  { value: 0, label: 'Solo con internet' },
  { value: 24, label: '24 horas' },
  { value: 72, label: '3 días (72 horas)' },
  { value: 168, label: '7 días (168 horas)' },
];
const roleName = role => role === 'owner' ? 'Propietario' : role === 'editor' ? 'Editor' : 'Músico';
const offlineName = hours => OFFLINE.find(option => option.value === Number(hours))?.label || 'Solo con internet';
const message = error => error?.message || 'No se pudo completar la operación. Vuelve a intentarlo.';

function assertOwner() {
  if (!cloud.canManageUsers) throw new Error('Solo el propietario puede administrar usuarios.');
  if (navigator.onLine === false) throw new Error('Conéctate a internet para administrar usuarios.');
}

// The key exists only in this dialog, until the owner explicitly closes it.
// It is never written to storage, the list of users, a toast, or a log.
function showPersonalKey(user, key, renewed = false) {
  let unsubscribe = () => {};
  const input = h('input', { type: 'password', class: 'input', value: key, readonly: true, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Clave personal' });
  const status = h('p', { class: 'field-hint', role: 'status' });
  const reveal = h('button', { type: 'button', class: 'btn small', 'aria-pressed': 'false', onClick: () => {
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    reveal.textContent = visible ? 'Ocultar clave' : 'Mostrar clave';
    reveal.setAttribute('aria-pressed', String(visible));
  } }, 'Mostrar clave');
  const body = h('div', { class: 'cloud-view' },
    h('p', { class: 'modal-text', text: `${renewed ? 'Nueva clave' : 'Acceso aprobado'} para ${user.name}.` }),
    h('p', { class: 'field-hint', text: 'Guarda esta clave personal y entrégala únicamente a este usuario por un medio de tu elección. No volverá a mostrarse al cerrar esta ventana.' }),
    field('Clave personal', input), reveal,
    renewed ? h('p', { class: 'field-hint', text: 'La clave anterior deja de servir para conectarse. Si el usuario está sin internet, su acceso termina al reconectarse o al vencer el permiso sin conexión.' }) : null,
    status,
  );
  const modal = openModal({
    title: renewed ? 'Clave personal renovada' : 'Usuario aprobado', body, size: 'sm', dismissible: false,
    actions: [
      { label: 'Copiar clave', icon: 'share', onClick: async () => {
        try {
          if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
          await navigator.clipboard.writeText(input.value);
          status.textContent = 'Clave copiada.';
        } catch {
          status.textContent = 'No se pudo copiar. Pulsa «Mostrar clave» y selecciónala para copiarla manualmente.';
        }
      } },
      { label: 'Ya guardé la clave', kind: 'primary', onClick: modal => modal.close() },
    ],
    onClose: () => { unsubscribe(); input.value = ''; key = ''; body.replaceChildren(); },
  });
  unsubscribe = cloud.on('change', () => {
    if (!cloud.canAccess || cloud.identity?.role !== 'owner') modal.close();
  });
  return modal;
}

function userForm(user) {
  const name = h('input', { class: 'input', type: 'text', value: user?.name || '', maxlength: 80, autocomplete: 'off', 'aria-label': 'Nombre del usuario' });
  const role = h('select', { class: 'select', 'aria-label': 'Permiso del usuario' }, ROLES.map(option => h('option', { value: option.value, text: option.label, selected: option.value === (user?.role || 'player') })));
  const hours = h('select', { class: 'select', 'aria-label': 'Uso sin internet' }, OFFLINE.map(option => h('option', { value: String(option.value), text: option.label, selected: option.value === Number(user?.offlineHours ?? 24) })));
  const roleHint = h('p', { class: 'field-hint' });
  const updateHint = () => { roleHint.textContent = role.value === 'editor' ? 'Puede reproducir, editar canciones y publicar cambios. Solo el propietario administra usuarios.' : 'Puede reproducir y preparar canciones para tocar. No puede editar ni publicar cambios.'; };
  role.addEventListener('change', updateHint);
  updateHint();
  const form = h('form', { class: 'cloud-view' }, field('Nombre', name), field('Permiso', role), roleHint,
    field('Uso sin internet', hours, 'Plazo para usar canciones descargadas desde la última validación de acceso.'),
    h('p', { class: 'field-hint', text: 'Un bloqueo se aplica al reconectarse o cuando vence este plazo si el usuario permanece sin internet.' }));
  return { form, name, role, hours };
}

function openUserForm(user, onSaved) {
  assertOwner();
  let unsubscribe = () => {};
  const { form, name, role, hours } = userForm(user);
  const status = h('p', { class: 'cloud-error', role: 'alert' });
  form.append(status);
  let busy = false;
  const modal = openModal({ title: user ? 'Editar usuario' : 'Aprobar nuevo usuario', body: form, size: 'sm', dismissible: false,
    onClose: () => { unsubscribe(); name.value = ''; },
  });
  unsubscribe = cloud.on('change', () => {
    if (!cloud.canAccess || cloud.identity?.role !== 'owner') modal.close();
  });
  const actions = () => modal.setActions([
    { label: 'Cancelar', disabled: busy, onClick: api => api.close() },
    { label: busy ? 'Guardando…' : user ? 'Guardar cambios' : 'Aprobar y crear clave', kind: 'primary', disabled: busy, onClick: submit },
  ]);
  const submit = async () => {
    if (busy) return;
    const value = name.value.trim();
    if (!value) { status.textContent = 'Escribe el nombre del usuario.'; name.focus(); return; }
    busy = true;
    status.textContent = '';
    actions();
    try {
      assertOwner();
      const data = { name: value, role: role.value, offlineHours: Number(hours.value) };
      const result = user ? await cloud.updateUser(user.id, { ...data, version: user.version }) : await cloud.createUser(data);
      name.value = '';
      modal.close();
      onSaved(result.user);
      if (!user) showPersonalKey(result.user, result.key);
    } catch (error) { status.textContent = message(error); }
    finally { busy = false; if (modal.layer.isConnected) actions(); }
  };
  form.addEventListener('submit', event => { event.preventDefault(); submit(); });
  actions();
  name.focus();
  return modal;
}

export function openUsers() {
  assertOwner();
  let users = [], busy = false, closed = false, unsubscribe = () => {};
  const status = h('p', { class: 'cloud-error', role: 'alert' });
  const count = h('p', { class: 'field-hint' });
  const list = h('div', { class: 'cloud-songs', 'aria-label': 'Usuarios aprobados' });
  const create = h('button', { type: 'button', class: 'btn primary', onClick: () => {
    try { openUserForm(null, changed); } catch (error) { status.textContent = message(error); }
  } }, icon('plus', 18), 'Aprobar usuario');
  const refreshButton = h('button', { type: 'button', class: 'btn', onClick: () => refresh() }, 'Actualizar usuarios');
  const body = h('div', { class: 'cloud-view' },
    h('p', { class: 'modal-text', text: 'El enlace de la app no concede acceso a tus canciones. Aprueba a cada persona y entrega su propia clave. No hay registro libre.' }),
    h('div', { class: 'cloud-tools' }, create, refreshButton), count, status, list,
  );
  const modal = openModal({ title: 'Usuarios', body, actions: [{ label: 'Cerrar', onClick: api => api.close() }], onClose: () => { closed = true; unsubscribe(); } });
  const setBusy = value => {
    busy = value;
    body.setAttribute('aria-busy', String(value));
    for (const button of body.querySelectorAll('button')) button.disabled = value || !cloud.canManageUsers || navigator.onLine === false;
  };
  const changed = user => {
    if (closed) return;
    const index = users.findIndex(item => item.id === user.id);
    if (index < 0) users.push(user); else users[index] = user;
    render();
  };
  const operate = async fn => {
    if (busy || closed) return;
    setBusy(true);
    status.textContent = '';
    try { assertOwner(); await fn(); }
    catch (error) { if (!closed) status.textContent = message(error); }
    finally { if (!closed) { render(); setBusy(false); } }
  };
  const render = () => {
    const active = users.filter(user => user.active).length;
    count.textContent = `${users.length} ${users.length === 1 ? 'usuario aprobado' : 'usuarios aprobados'} · ${active} ${active === 1 ? 'activo' : 'activos'}`;
    list.replaceChildren();
    if (!users.length) list.append(h('p', { class: 'field-hint', text: 'Todavía no has aprobado usuarios. Crea un acceso personal para cada músico o editor.' }));
    for (const user of [...users].sort((a, b) => a.name.localeCompare(b.name, 'es'))) {
      const card = h('article', { class: 'cloud-card', dataset: { userId: user.id } },
        h('b', { text: user.name }),
        h('span', { class: 'field-hint', text: `${roleName(user.role)} · ${Number(user.offlineHours) ? 'Sin internet: ' : ''}${offlineName(user.offlineHours)}` }),
        h('span', { class: `cloud-badge ${user.active ? 'downloaded' : ''}`, text: user.active ? 'Aprobado · Activo' : 'Bloqueado' }),
      );
      if (user.role !== 'owner') {
        const edit = h('button', { type: 'button', class: 'btn small', onClick: () => {
          try { openUserForm(user, changed); } catch (error) { status.textContent = message(error); }
        } }, 'Editar permisos');
        const block = h('button', { type: 'button', class: `btn small ${user.active ? 'danger' : ''}`, onClick: () => operate(async () => {
          const approved = await confirmDialog({ title: user.active ? 'Bloquear usuario' : 'Habilitar usuario',
            message: user.active ? `¿Bloquear el acceso de ${user.name}? No podrá conectarse. Si está sin internet, su acceso termina al reconectarse o al vencer su permiso sin conexión.` : `¿Habilitar de nuevo a ${user.name}? Podrá conectarse con su clave personal y los permisos asignados.`,
            confirm: user.active ? 'Bloquear' : 'Habilitar', danger: user.active });
          if (!approved || closed) return;
          assertOwner();
          const result = await cloud.updateUser(user.id, { version: user.version, active: !user.active });
          changed(result.user);
        }) }, user.active ? 'Bloquear' : 'Habilitar');
        const rotate = h('button', { type: 'button', class: 'btn small', onClick: () => operate(async () => {
          const approved = await confirmDialog({ title: 'Renovar clave personal', message: `La clave actual de ${user.name} dejará de servir para conectarse. Se generará una nueva que deberás guardar y entregar a este usuario. El acceso sin internet ya autorizado vence al reconectarse o al terminar su plazo.`, confirm: 'Renovar clave', danger: true });
          if (!approved || closed) return;
          assertOwner();
          const result = await cloud.rotateUserKey(user.id, { version: user.version });
          changed(result.user);
          showPersonalKey(result.user, result.key, true);
        }) }, 'Renovar clave');
        card.append(h('div', { class: 'cloud-tools' }, edit, block, rotate));
      }
      list.append(card);
    }
    setBusy(busy);
  };
  const refresh = () => operate(async () => {
    status.textContent = 'Consultando usuarios…';
    const result = await cloud.listUsers();
    if (!closed) { users = result; status.textContent = ''; }
  });
  unsubscribe = cloud.on('change', () => {
    if (!cloud.canManageUsers && !closed) modal.close();
  });
  refresh();
  return modal;
}
