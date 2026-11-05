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
    this.waiters = [];
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
    // reconnects), so only act on a drop once the link is up.
    this.device.ongattserverdisconnected = () => {
      const wasUp = !!this.chr;
      this.chr = null;
      if (wasUp && !this.manual) this._reconnect();
      else if (wasUp) this.onState('disconnected');
    };
    this.manual = false;
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

  // The SDS150 drops a quiet, healthy link now and then (AlphaScan reconnects
  // for the same reason), so win it back without the device picker.
  async _reconnect() {
    const waits = [1, 2, 4, 8, 15, 30, 30, 30, 30, 30];
    for (let i = 0; i < waits.length && !this.manual; i++) {
      this.onState('reconnecting');
      await new Promise(r => setTimeout(r, waits[i] * 1000));
      if (this.manual) break;
      try { await this._open(); this.onState('connected'); return; }
      catch { if (this.device.gatt.connected) this.device.gatt.disconnect(); }
    }
    this.onState('disconnected');
  }

  disconnect() {
    this.manual = true;
    if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
    else this.onState('disconnected');
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

  // Leave hold and go back to scanning the favorites lists.
  resumeScan() {
    return this.send('JPM,SCN_MODE,0');
  }

  // Jump to a programmed channel by its Sentinel number tags and hold it.
  // (Over Bluetooth the SDS150 delivers only the last line of a multi-line
  // reply, so browsing favorites with GLT can't work; one-line JNT does.)
  async jumpTag(tag) {
    const { fl, sys, chan } = parseTag(tag);
    const reply = await this.ask(`JNT,${fl},${sys},${chan}`);
    if (reply === 'JNT,NG') throw new Error(`No channel on the radio has tag ${tag}`);
    if (reply !== 'JNT,OK') throw new Error(`The radio refused the jump (${reply})`);
  }

  // Quick keys switch what the radio scans: favorites lists (FQK), the systems
  // in a list (SQK,<list>) and the departments in a system (DQK,<list>,<system>).
  // `path` picks the level: [] for lists, [list] for its systems, [list, system]
  // for its departments. Each reply is one line of 100 slots, 0 = no such key,
  // 1 = off, 2 = on; a set sends all 100 back.
  quickKeys(path) {
    return this._exclusive(() => this._readQuickKeys(path));
  }

  setQuickKey(path, key, on) {
    return this._exclusive(async () => {
      const states = await this._readQuickKeys(path);
      if (states[key] === 'none') throw new Error(`Quick key ${key} isn't assigned on the radio`);
      states[key] = on ? 'on' : 'off';
      const reply = await this.ask(`${qkCommand(path)},${states.map(s => QK_STATES.indexOf(s)).join(',')}`, 3000);
      if (!reply.endsWith(',OK')) throw new Error(`The radio refused the switch (${reply})`);
      // The radio goes deaf for a few seconds while it rebuilds its scan list.
      this.quietUntil = Date.now() + 4000;
      return states;
    });
  }

  async _readQuickKeys(path) {
    const cmd = qkCommand(path);
    // Replies can lose their start when the radio pushes something at the same
    // moment, so ask again before giving up.
    for (let i = 1; ; i++) {
      try {
        const v = (await this.ask(cmd, 2500)).split(',').slice(1);
        if (v.length < 100) throw new Error(`The radio answered ${cmd} oddly`);
        return v.slice(-100).map(x => QK_STATES[x] || 'none');
      } catch (e) { if (i === 3) throw e; await sleep(1000); }
    }
  }

  // One quick-key exchange at a time, none while the radio is still deaf;
  // `busy` tells the page to hold its screen polling meanwhile.
  _exclusive(fn) {
    const run = async () => {
      this.busy = true;
      try {
        const wait = (this.quietUntil || 0) - Date.now();
        if (wait > 0) await sleep(wait);
        return await fn();
      } finally { this.busy = false; }
    };
    const p = (this.exclusiveChain || Promise.resolve()).then(run, run);
    this.exclusiveChain = p.catch(() => {});
    return p;
  }

  // Send a command and resolve with its one-line reply, e.g. "JNT,OK".
  ask(cmd, timeoutMs = 2000) {
    const head = cmd.split(',')[0].toUpperCase();
    return new Promise((resolve, reject) => {
      const done = (fn, v) => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter(w => w !== waiter);
        fn(v);
      };
      const waiter = line => {
        const l = line.trim();
        if (l.toUpperCase().startsWith(head + ',') || l === 'ERR') done(resolve, l);
      };
      const timer = setTimeout(() => done(reject, new Error(`No reply to ${head}`)), timeoutMs);
      this.waiters.push(waiter);
      this.send(cmd).catch(e => done(reject, e));
    });
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
      if (!line.trim()) continue;
      for (const w of [...this.waiters]) w(line);
      this.onLine(line);
    }
  }
}

const QK_STATES = ['none', 'off', 'on'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function qkCommand(path) {
  return ['FQK', 'SQK', 'DQK'][path.length] + path.map(n => `,${n}`).join('');
}

async function step(what, fn) {
  try { return await fn(); }
  catch (e) { throw new Error(`Failed ${what}: ${e.message || e}`); }
}

// "1.1.3" (or "1 1 3", "01.01.003") -> { fl: 1, sys: 1, chan: 3 }.
export function parseTag(tag) {
  const m = String(tag).trim().match(/^(\d{1,2})\D+(\d{1,2})\D+(\d{1,3})$/);
  if (!m) throw new Error(`"${tag}" isn't a number tag like 1.2.15`);
  return { fl: +m[1], sys: +m[2], chan: +m[3] };
}

export function mhzToSteps(mhz) {
  return Math.round(parseFloat(mhz) * 1e4);
}

// Pull what the radio is showing out of a GST reply. Its screen rows are split
// by ",,": ... "D0:--2------- Tag:01.02.003", system, favorites list,
// department, [site], "Citywide 3 ,*****, 470.862500MHz", ...
// The tag reads "Tag:--.--.---" when the channel has none.
export function parseScreen(line) {
  // The radio puts a stray non-printing byte before "GST,", which _text turns into a space.
  line = line.trimStart();
  if (!line.startsWith('GST,')) return null;
  const rows = line.split(',,').map(s => s.trim());
  const at = rows.findIndex(r => r.includes('Tag:'));
  const chan = rows.find(r => /,\*{5,},/.test(r)) || '';
  const t = (rows[at] || '').match(/Tag:\s*(\d+)\s*\.\s*(\d+)\s*\.\s*(\d+)/);
  const f = chan.match(/(\d+\.\d+)MHz/);
  return {
    mhz: f ? f[1] : '',
    name: chan.split(',')[0].trim(),
    system: at >= 0 ? rows[at + 1] || '' : '',
    list: at >= 0 ? rows[at + 2] || '' : '',
    dept: at >= 0 ? rows[at + 3] || '' : '',
    tag: t ? `${+t[1]}.${+t[2]}.${+t[3]}` : '',
  };
}
