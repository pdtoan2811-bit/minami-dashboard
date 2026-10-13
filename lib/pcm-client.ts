"use client";

// Browser-side audio capture helpers: the mic → 16 kHz mono s16le → WAV.
//
// Why not MediaRecorder: on Android Chrome it produces WebM/Opus, and the transcription models behind
// OpenRouter take wav/mp3. Re-encoding on the Mac would mean an ffmpeg hop per note; a 16 kHz WAV is
// what the meeting ear (§17) is already tuned on, and a minute of it is under 2 MB.
// The same approach as /meet (app/meet/Meet.tsx), which streams frames instead of keeping them.

export const RATE = 16_000;

/** The AudioWorklet, inline so there is no extra file to serve. It only copies the input out. */
export const TAP = `class T extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('minami-tap',T)`;

/** Box-filter decimation to 16 kHz — averaging each output sample's window, so a 48 kHz mic's hiss
 *  isn't aliased into the speech band the way picking every Nth sample would. */
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

/** 16 kHz mono 16-bit PCM chunks → one WAV blob (44-byte header). */
export function wavBlob(chunks: Int16Array[]): Blob {
  const samples = chunks.reduce((n, c) => n + c.length, 0);
  const h = new DataView(new ArrayBuffer(44));
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) h.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); h.setUint32(4, 36 + samples * 2, true); str(8, "WAVE");
  str(12, "fmt "); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, RATE, true); h.setUint32(28, RATE * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true);
  str(36, "data"); h.setUint32(40, samples * 2, true);
  return new Blob([h.buffer, ...chunks.map((c) => c.buffer as ArrayBuffer)], { type: "audio/wav" });
}

/** Start the mic. Returns a stop() that resolves to the WAV, and a level callback hook. */
export async function startCapture(onLevel: (peak: number) => void): Promise<{ stop: () => Promise<Blob>; cancel: () => void; seconds: () => number }> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("no microphone here — open the dashboard over https (the tailnet address), not http://<ip>");
  }
  // Echo cancellation and AGC on: a phone held at chest height, often in a room with other sound.
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([TAP], { type: "text/javascript" })));
  const node = new AudioWorkletNode(ctx, "minami-tap");
  ctx.createMediaStreamSource(stream).connect(node);
  const chunks: Int16Array[] = [];
  let samples = 0;
  node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
    const f = ev.data;
    let peak = 0;
    for (let i = 0; i < f.length; i++) peak = Math.max(peak, Math.abs(f[i]));
    onLevel(peak);
    const pcm = toPcm16(f, ctx.sampleRate);
    chunks.push(pcm);
    samples += pcm.length;
  };
  const close = () => { stream.getTracks().forEach((t) => t.stop()); void ctx.close(); };
  return {
    seconds: () => samples / RATE,
    cancel: close,
    stop: async () => { close(); return wavBlob(chunks); },
  };
}
