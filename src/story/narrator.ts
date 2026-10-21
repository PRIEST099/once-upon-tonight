import { SynthesizeSpeechCommand, type Engine, type VoiceId } from '@aws-sdk/client-polly';
import { polly } from './aws.js';
import { config } from '../config.js';
import type { SpeechMark } from '../types.js';

async function synth(text: string, format: 'mp3' | 'json', engine: string) {
  const res = await polly.send(
    new SynthesizeSpeechCommand({
      Text: text,
      VoiceId: config.narratorVoice as VoiceId,
      Engine: engine as Engine,
      OutputFormat: format,
      ...(format === 'json' && { SpeechMarkTypes: ['word'] }),
      ...(format === 'mp3' && { SampleRate: '24000' }),
    }),
  );
  return new Uint8Array(await res.AudioStream!.transformToByteArray());
}

/** Polly reports byte offsets into the UTF-8 input; convert them to string (UTF-16) indexes. */
function byteToCharIndex(text: string) {
  const map: number[] = [];
  let byte = 0;
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    const len = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    for (let k = 0; k < len; k++) map[byte + k] = i;
    byte += len;
    if (cp > 0xffff) i++;
  }
  map[byte] = text.length;
  return (b: number) => map[b] ?? text.length;
}

/**
 * Narrate one page: an MP3 plus word-level speech marks so the storybook can highlight each word
 * as it is read (read-along support for early readers).
 */
export async function narrate(text: string): Promise<{ audio: Uint8Array; marks: SpeechMark[] }> {
  const audio = await synth(text, 'mp3', config.narratorEngine);
  let raw: Uint8Array;
  try {
    raw = await synth(text, 'json', config.narratorEngine);
  } catch {
    // Some engines don't return speech marks; fall back to the neural engine for timings.
    raw = await synth(text, 'json', 'neural');
  }
  const toChar = byteToCharIndex(text);
  const marks = new TextDecoder()
    .decode(raw)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((m) => m.type === 'word')
    .map((m) => ({ time: m.time, start: toChar(m.start), end: toChar(m.end), value: m.value }));
  return { audio, marks };
}
