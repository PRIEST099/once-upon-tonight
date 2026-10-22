import { SynthesizeSpeechCommand, type Engine, type VoiceId } from '@aws-sdk/client-polly';
import { polly } from './aws.js';
import { PRICES, record } from './cost.js';
import { config } from '../config.js';
import type { SpeechMark, VoiceLine } from '../types.js';

async function synth(text: string, format: 'mp3' | 'json', engine: string, voice = config.narratorVoice, ssml?: string) {
  const res = await polly.send(
    new SynthesizeSpeechCommand({
      Text: ssml ?? text,
      ...(ssml && { TextType: 'ssml' }),
      VoiceId: voice as VoiceId,
      Engine: engine as Engine,
      OutputFormat: format,
      ...(format === 'json' && { SpeechMarkTypes: ['word'] }),
      ...(format === 'mp3' && { SampleRate: '24000' }),
    }),
  );
  record(PRICES.polly[engine] ?? PRICES.polly.neural, text.length); // SSML tags aren't billed
  return new Uint8Array(await res.AudioStream!.transformToByteArray());
}

const utf8Length = (s: string) => new TextEncoder().encode(s).length;
const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/**
 * Bedtime pace: the text as SSML, read a little slower than Polly's default, with a pause after each
 * sentence and silence at the end. Speech marks come back as byte offsets into the SSML, so this also
 * returns a map from those offsets to indexes in the plain text (tags map to nothing).
 */
function bedtimeSsml(text: string, endPauseMs: number) {
  const open = `<speak><prosody rate="${config.narrationRate}">`;
  const pause = `<break time="${config.sentencePauseMs}ms"/>`;
  let ssml = open;
  let byte = utf8Length(open);
  const toChar: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    // A pause between sentences: at the first space after . ! ? or … (and any closing quote).
    if (/\s/.test(ch) && /[.!?…]["”’')]*$/.test(text.slice(0, i)) && !/\s/.test(text[i - 1])) {
      ssml += pause;
      byte += pause.length;
    }
    const out = ESCAPE[ch] ?? ch;
    const len = utf8Length(out);
    for (let k = 0; k < len; k++) toChar[byte + k] = i;
    ssml += out;
    byte += len;
    if (cp > 0xffff) i++;
  }
  toChar[byte] = text.length;
  ssml += `${endPauseMs ? `<break time="${endPauseMs}ms"/>` : ''}</prosody></speak>`;
  return { ssml, toChar: (b: number) => toChar[b] };
}

/**
 * Narrate one page: an MP3 plus word-level speech marks so the storybook can highlight each word
 * as it is read (read-along support for early readers).
 */
export async function narrate(text: string, lines?: VoiceLine[]): Promise<{ audio: Uint8Array; marks: SpeechMark[] }> {
  if (lines?.length) {
    try {
      return await narrateLines(text, lines);
    } catch (err) {
      console.warn('[narrator] character voices failed; narrator only', err);
    }
  }
  return narrateOne(text, config.narratorVoice, config.pagePauseMs);
}

async function narrateOne(text: string, voice: string, endPauseMs: number): Promise<{ audio: Uint8Array; marks: SpeechMark[] }> {
  const { ssml, toChar } = bedtimeSsml(text, endPauseMs);
  const audio = await synth(text, 'mp3', config.narratorEngine, voice, ssml);
  let raw: Uint8Array;
  try {
    raw = await synth(text, 'json', config.narratorEngine, voice, ssml);
  } catch {
    // Some engines don't return speech marks; fall back to the neural engine for timings.
    raw = await synth(text, 'json', 'neural', voice, ssml);
  }
  const marks = new TextDecoder()
    .decode(raw)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((m) => m.type === 'word' && toChar(m.start) !== undefined && toChar(m.start) < text.length) // a <break> gets a mark of its own
    .map((m) => {
      const start = toChar(m.start);
      const end = toChar(m.end) ?? toChar(m.end - 1) + 1;
      return { time: m.time, start, end, value: text.slice(start, end) };
    });
  return { audio, marks };
}

/**
 * A page read by several voices: each line is spoken on its own, the MP3s are joined, and each line's word
 * timings are moved by the length of the audio before it (and its character offsets by where it starts).
 */
async function narrateLines(text: string, lines: VoiceLine[]) {
  const spoken = lines.filter((l) => /[\p{L}\p{N}]/u.test(text.slice(l.start, l.end))); // skip bare punctuation
  // A breath when the speaker changes, and a longer one at the end of the page.
  const parts = await Promise.all(
    spoken.map((l, i) => narrateOne(text.slice(l.start, l.end).trim(), l.voice, i === spoken.length - 1 ? config.pagePauseMs : config.speakerPauseMs)),
  );
  const marks: SpeechMark[] = [];
  let ms = 0;
  parts.forEach((p, i) => {
    const slice = text.slice(spoken[i].start, spoken[i].end);
    const lead = spoken[i].start + (slice.length - slice.trimStart().length);
    for (const m of p.marks) marks.push({ ...m, time: m.time + ms, start: m.start + lead, end: m.end + lead });
    ms += mp3DurationMs(p.audio);
  });
  const audio = new Uint8Array(parts.reduce((n, p) => n + p.audio.length, 0));
  let at = 0;
  for (const p of parts) {
    audio.set(p.audio, at);
    at += p.audio.length;
  }
  return { audio, marks };
}

/** Length of an MP3 from its frame headers (Polly writes constant-rate MPEG audio without tags). */
export function mp3DurationMs(bytes: Uint8Array) {
  const BITRATES = { 1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
  const RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };
  let i = 0;
  let seconds = 0;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) {
      i++;
      continue;
    }
    const v = (bytes[i + 1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
    const version = v === 3 ? 1 : v === 2 ? 2 : v === 0 ? 2.5 : 0;
    const layer = (bytes[i + 1] >> 1) & 3; // 1 = Layer III
    const kbps = version ? BITRATES[version === 1 ? 1 : 2][(bytes[i + 2] >> 4) & 15] : 0;
    const rate = version ? RATES[version as 1 | 2 | 2.5][(bytes[i + 2] >> 2) & 3] : 0;
    if (!version || layer !== 1 || !kbps || !rate) {
      i++;
      continue;
    }
    const samples = version === 1 ? 1152 : 576;
    const padding = (bytes[i + 2] >> 1) & 1;
    const length = Math.floor(((samples / 8) * kbps * 1000) / rate) + padding;
    seconds += samples / rate;
    i += length;
  }
  return Math.round(seconds * 1000);
}
