import { store } from './store.js';
import { createEmitter } from './util.js';

// This lock protects normal use of this device. Cloud write permissions are
// checked independently by the Worker; a local PIN never grants cloud access.
class Access {
  constructor() {
    this.bus = createEmitter();
    this.record = null;
    this.unlocked = false;
    this.cloudRole = null;
    this.failures = 0;
    this.retryAt = 0;
  }
  on(name, fn) { return this.bus.on(name, fn); }
  async init() {
    this.record = await store.getMeta('deviceMasterLock', null);
    this.unlocked = false;
  }
  get configured() { return Boolean(this.record); }
  get canEdit() { return this.cloudRole !== 'player' && (!this.configured || this.unlocked); }
  get label() { return this.canEdit ? this.configured ? 'Maestro' : 'Configurar acceso' : 'Reproducción'; }
  setCloudRole(role) {
    const next = ['master', 'player'].includes(role) ? role : null;
    if (this.cloudRole === next) return;
    this.cloudRole = next;
    if (next === 'player') this.unlocked = false;
    this.bus.emit('change');
  }
  assertEdit() {
    if (!this.canEdit) throw new Error('Modo reproducción: el acceso maestro es necesario para editar canciones.');
  }
  async derive(value, salt) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(value), 'PBKDF2', false, ['deriveBits']);
    const bytes = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: Uint8Array.from(salt), iterations: 120000 }, key, 256);
    return Array.from(new Uint8Array(bytes));
  }
  async configure(value) {
    this.assertEdit();
    if (value.length < 6 || value.length > 64) throw new Error('Usa una clave local de entre 6 y 64 caracteres.');
    const salt = Array.from(crypto.getRandomValues(new Uint8Array(16)));
    const record = { salt, hash: await this.derive(value, salt) };
    await store.setMeta('deviceMasterLock', record);
    this.record = record;
    this.unlocked = true;
    this.bus.emit('change');
  }
  async unlock(value) {
    if (this.cloudRole === 'player') throw new Error('Este equipo usa acceso de reproducción. Conecta la clave maestra de la nube para editar.');
    if (Date.now() < this.retryAt) throw new Error('Espera 30 segundos antes de volver a intentar.');
    if (!this.record) throw new Error('Primero configura una clave maestra local.');
    const hash = await this.derive(value, this.record.salt);
    const same = hash.length === this.record.hash.length && hash.reduce((mismatch, byte, i) => mismatch | (byte ^ this.record.hash[i]), 0) === 0;
    if (!same) {
      if (++this.failures >= 5) { this.retryAt = Date.now() + 30000; this.failures = 0; }
      throw new Error('La clave local no es correcta.');
    }
    this.failures = 0;
    this.unlocked = true;
    this.bus.emit('change');
  }
  lock() {
    this.unlocked = false;
    this.bus.emit('change');
  }
}

export const access = new Access();
