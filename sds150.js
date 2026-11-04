// SDS150 over Web Bluetooth.
//
// Learned from AlphaScan's public web bundle and confirmed on a real SDS150
// (fw 1.02.01): one custom GATT service with one characteristic used for both
// write and notify. Each ASCII command (ending in \r) is wrapped in a "PT" frame:
//   09 'P' 'T' 00 LEN | SEQ(2) [CLOCK(2)] C0 00 N 81 <ascii...> | SUM(2)
// LEN = payload length, N = ascii length + 1, SUM = 16-bit sum of the payload.
// "KEY,OK" is the only command sent without the clock field.
// Replies use the same frame; from byte 7 the payload holds blocks of
// TYPE(1) LEN(2) DATA, where C0 is text (led by 0x81) and A1 is audio.
// The radio also streams tiny AF blocks ~10x a second; those are ignored.

const SERVICE = '3a5b9d10-f2ec-4f5c-bb2e-2f1a8d98a0a6';
const CHAR = 'ab8c17d4-c1c5-4c91-8c56-7d01954c471e';
const STD_SERVICES = ['00001800-0000-1000-8000-00805f9b34fb', '00001801-0000-1000-8000-00805f9b34fb', '0000180a-0000-1000-8000-00805f9b34fb'];

export class SDS150 {
  constructor({ onLine = () => {}, onState = () => {} } = {}) {
    this.onLine = onLine;
    this.onState = onState;
    this.device = null;
    this.chr = null;
    this.seq = 0;
    this.rxBuf = new Uint8Array(0);
    this.textBuf = '';
    this.writeChain = Promise.resolve();
  }

  get connected() { return !!this.chr; }

  async connect() {
    if (!navigator.bluetooth) throw new Error('No Web Bluetooth here. Use Chrome or Edge on the PC, or Bluefy on the iPad.');
    this.onState('choosing');
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'SDS' }, { namePrefix: 'Uniden' }, { services: [SERVICE] }],
      optionalServices: [SERVICE, ...STD_SERVICES],
    });
    // Drops while connecting are expected (the radio bonds, then drops and
    // reconnects), so only report a disconnect once the link is up.
    this.device.ongattserverdisconnected = () => {
      const wasUp = !!this.chr;
      this.chr = null;
      if (wasUp) this.onState('disconnected');
    };
    this.onState('connecting');
    let lastError;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        await this._open();
        this.onState('connected');
        return;
      } catch (e) {
        lastError = e;
        if (this.device.gatt.connected) this.device.gatt.disconnect();
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    this.onState('disconnected');
    // An SDS150 only accepts a device it hasn't seen before while it is in pairing mode.
    throw new Error('The radio keeps dropping the link. If this device is new to it: on the SDS150 press MENU → Settings → Bluetooth Options → Pairing, then Connect while it shows "Processing". '
      + `(last error: ${lastError && lastError.message || lastError})`);
  }

  async _open() {
    const server = await step('connecting', () => this.device.gatt.connect());
    await new Promise(r => setTimeout(r, 2000));
    if (!this.device.gatt.connected) throw new Error('dropped while settling');
    // Each step names itself on failure so a phone/iPad user can report it.
    const svc = await step('finding the Uniden service', () => server.getPrimaryService(SERVICE));
    const chr = await step('finding the command channel', async () => {
      try { return await svc.getCharacteristic(CHAR); }
      catch { return (await svc.getCharacteristics()).find(c => c.properties.notify); }
    });
    if (!chr) throw new Error('The radio has no command channel');
    this._boundNotify = this._boundNotify || (ev => this._onNotify(ev));
    chr.removeEventListener('characteristicvaluechanged', this._boundNotify);
    chr.addEventListener('characteristicvaluechanged', this._boundNotify);
    // iOS (Bluefy) can refuse the first subscribe while it finishes bonding.
    await step('subscribing to replies', async () => {
      for (let attempt = 1; ; attempt++) {
        try { return await chr.startNotifications(); }
        catch (e) { if (attempt === 3 || !this.device.gatt.connected) throw e; await new Promise(r => setTimeout(r, 1000)); }
      }
    });
    this.chr = chr;
  }

  disconnect() {
    if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
  }

  async send(cmd) {
    if (!this.chr) throw new Error('Not connected');
    const bytes = this._frame(cmd);
    const write = () => this.chr.writeValueWithoutResponse ? this.chr.writeValueWithoutResponse(bytes) : this.chr.writeValue(bytes);
    this.writeChain = this.writeChain.then(write, write);
    await this.writeChain;
  }

  // Quick Search Hold: tune to a frequency and stay there.
  // The SDS150 wants the frequency in 100 Hz steps, zero-padded to 8 digits.
  tune(mhz) {
    return this.send(`QSH,${String(mhzToSteps(mhz)).padStart(8, '0')}`);
  }

  _frame(cmd) {
    const text = new TextEncoder().encode(cmd.endsWith('\r') ? cmd : cmd + '\r');
    this.seq = (this.seq + 1) & 0xffff;
    const clock = Date.now() & 0xffff;
    const p = [this.seq >> 8, this.seq & 255];
    if (cmd.toUpperCase() !== 'KEY,OK') p.push(clock >> 8, clock & 255);
    p.push(0xc0, 0x00, (text.length + 1) & 255, 0x81, ...text);
    let sum = 0;
    for (const b of p) sum = (sum + b) & 0xffff;
    return new Uint8Array([0x09, 0x50, 0x54, 0x00, p.length & 255, ...p, sum >> 8, sum & 255]);
  }

  _onNotify(ev) {
    const v = ev.target.value;
    const chunk = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    const merged = new Uint8Array(this.rxBuf.length + chunk.length);
    merged.set(this.rxBuf); merged.set(chunk, this.rxBuf.length);
    this.rxBuf = merged;
    this._drain();
  }

  _drain() {
    for (;;) {
      const b = this.rxBuf;
      const start = b.findIndex((x, i) => x === 0x09 && b[i + 1] === 0x50 && b[i + 2] === 0x54);
      if (start < 0) { this.rxBuf = b.length > 2 ? b.slice(-2) : b; return; }
      if (start > 0) this.rxBuf = b.slice(start);
      const f0 = this.rxBuf;
      if (f0.length < 5) return;
      const len = (f0[3] << 8) | f0[4];
      if (len < 2 || len > 4096) { this.rxBuf = f0.slice(1); continue; }
      const total = 5 + len + 2;
      if (f0.length < total) return;
      const f = f0.slice(0, total);
      this.rxBuf = f0.slice(total);
      let sum = 0;
      for (let i = 5; i < 5 + len; i++) sum = (sum + f[i]) & 0xffff;
      if (sum !== ((f[total - 2] << 8) | f[total - 1])) continue;
      for (let r = 7; r + 3 <= total - 2;) {
        const type = f[r], n = (f[r + 1] << 8) | f[r + 2];
        if (r + 3 + n > total - 2) break;
        const d = f.subarray(r + 3, r + 3 + n);
        if (type === 0xc0) this._text(new TextDecoder().decode(d[0] === 0x81 ? d.subarray(1) : d));
        r += 3 + n;
      }
    }
  }

  // A long reply (GST/STS) spans several frames, so collect text up to the \r.
  _text(s) {
    this.textBuf += s;
    let i;
    while ((i = this.textBuf.search(/[\r\n]/)) >= 0) {
      const line = this.textBuf.slice(0, i).replace(/[^\x20-\x7e]/g, ' ');
      this.textBuf = this.textBuf.slice(i + 1);
      if (line.trim()) this.onLine(line);
    }
  }
}

async function step(what, fn) {
  try { return await fn(); }
  catch (e) { throw new Error(`Failed ${what}: ${e.message || e}`); }
}

export function mhzToSteps(mhz) {
  return Math.round(parseFloat(mhz) * 1e4);
}

// Pull what the radio is showing out of a GST reply: the frequency line and
// the nearest non-empty screen line above it (the channel name).
export function parseScreen(line) {
  if (!line.startsWith('GST,')) return null;
  const rows = line.split(',,').map(s => s.trim());
  const at = rows.findIndex(r => /^\d+\.\d+MHz$/.test(r));
  if (at < 0) return null;
  let name = '';
  for (let i = at - 1; i >= 0 && !name; i--) if (rows[i] && !rows[i].includes(':')) name = rows[i];
  return { mhz: rows[at].replace('MHz', ''), name };
}
