// The browser half of "a mic as Minami's ear" (§17b), shared by the phone page (/meet) and the
// laptop start bar on /meetings. Pure helpers only: each page owns its own capture lifecycle, because
// the phone page has to fight Android (wake locks, a backgrounded tab going silent) and the laptop
// doesn't. The box side is lib/meet-mic.ts; both pages talk to it through /api/meet/mic.

export const RATE = 16_000;
export const FRAME_S = 0.5;
/** 15s of audio waiting to upload. Past this the network is not coming back soon enough for the
 *  words to matter on a live board, and an unbounded queue would OOM a phone tab in a long meeting. */
export const MAX_BACKLOG = 30;

/** The AudioWorklet, inline so there is no extra file to serve. It only copies the input out; the
 *  main thread does the rest, because worklet → main messages at 128-sample quanta are cheap and
 *  keeping the resampler in one place keeps it debuggable. */
export const TAP = `class T extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('minami-tap',T)`;

/** Box-filter decimation to 16 kHz. Averaging over each output sample's window is a crude low-pass,
 *  which is enough for speech going to an STT model and much better than picking every Nth sample
 *  (that aliases a 48 kHz mic's hiss straight into the speech band). */
export function toPcm16(input: Float32Array, rate: number): Int16Array {
  const ratio = rate / RATE;
  const n = Math.floor(input.length / ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b; j++) sum += input[j];
    const v = Math.max(-1, Math.min(1, sum / (b - a)));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

/** `phone-…` even from the laptop: /api/meet/mic and /api/meet/recording validate on that prefix,
 *  and it names the mic-driven pipeline, not the device. */
export const newId = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `phone-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${Math.random().toString(36).slice(2, 6)}`;
};

/** The full canvas, memes and all, in present mode (no operator panel) and pinned to one meeting. */
export const boardUrl = (id: string) => `/canvas?present=1&meeting=${encodeURIComponent(id)}`;
