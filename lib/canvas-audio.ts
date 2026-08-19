// The recordings the live canvas can run against.
//
// A registry rather than a single constant, because comparing arms on ONE recording tells you how
// that recording behaves, not how the pipeline does. Different material breaks it in different ways:
// a monologue produces no disagreement to react to, a two-hander produces speaker confusion, a
// technical talk produces proper nouns the ASR mangles. Being able to switch source without an env
// edit and a restart is what makes that a five-second check instead of a chore.
//
// Files are referenced by absolute path and deliberately not copied into the repo — they are tens of
// megabytes of source material, not code. A missing file surfaces as a `fail` event on the stream
// rather than a crash, so a stale entry here is annoying but not dangerous.

export type AudioSource = {
  id: string;
  label: string;
  /** Roughly how long, so the duration buttons can be read against something. */
  minutes: number;
  file: string;
};

export const AUDIO_SOURCES: AudioSource[] = [
  {
    id: "openai",
    label: "OpenAI · frontier free",
    minutes: 24,
    file:
      process.env.CANVAS_AUDIO_FILE ||
      "/Users/thomas/Downloads/YTDown.com_YouTube_OpenAI-Just-Made-Frontier-AI-Free-for-Ev_Media_g7r6snkyFzY_009_128k.mp3",
  },
  {
    id: "option2",
    label: "Option 2",
    minutes: 11,
    file: process.env.CANVAS_AUDIO_FILE_2 || "/Users/thomas/Downloads/option2.mp3",
  },
];

export const DEFAULT_SOURCE = AUDIO_SOURCES[0].id;

export function resolveSource(raw: string | null | undefined): AudioSource {
  return AUDIO_SOURCES.find((s) => s.id === raw) ?? AUDIO_SOURCES[0];
}
