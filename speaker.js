// Plays the SDS150's Bluetooth audio: Opus packets (16 kHz mono) decoded in
// the browser by the vendored opus-decoder (WebAssembly; works on iOS too),
// then queued back to back on a Web Audio clock.

// How far ahead of "now" to start playing, to ride out Bluetooth jitter, and
// how far ahead the queue may run before packets are dropped.
const LEAD = 0.2;
const MAX_AHEAD = 0.8;

let decoderLib = null;
function loadDecoder() {
  return decoderLib || (decoderLib = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/opus-decoder.min.js';
    s.onload = () => resolve(window['opus-decoder'].OpusDecoder);
    s.onerror = () => { decoderLib = null; reject(new Error("Couldn't load the audio decoder")); };
    document.head.append(s);
  }));
}

export class Speaker {
  constructor() {
    this.ctx = null;
    this.decoder = null;
    this.on = false;
    this.next = 0;
    this.packets = 0;
  }

  // Must be called from a tap: browsers (iOS especially) only let a page
  // start sound in answer to one.
  async start() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    const resumed = this.ctx.resume();
    if (!this.decoder) {
      const OpusDecoder = await loadDecoder();
      this.decoder = new OpusDecoder({ sampleRate: 16000, channels: 1 });
      await this.decoder.ready;
    }
    await resumed;
    this.on = true;
    this.next = 0;
  }

  stop() {
    this.on = false;
    if (this.ctx) this.ctx.suspend();
  }

  play(packet) {
    if (!this.on || !this.decoder) return;
    let out;
    try { out = this.decoder.decodeFrame(packet); } catch { return; }
    const pcm = out && out.channelData && out.channelData[0];
    if (!pcm || !pcm.length) return;
    this.packets++;
    // Running late (a gap in the stream): start again a little ahead. Too far
    // ahead (a burst): drop this packet. Pulling the start back instead would
    // play it over sound already queued, which is heard as an echo.
    const now = this.ctx.currentTime;
    if (this.next < now) this.next = now + LEAD;
    else if (this.next > now + MAX_AHEAD) return;
    const buf = this.ctx.createBuffer(1, pcm.length, out.sampleRate || 16000);
    buf.getChannelData(0).set(pcm);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    src.start(this.next);
    this.next += buf.duration;
  }
}
