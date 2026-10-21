import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

/** Story media (illustrations, narration) lives under data/media and is served at /media. */
export const mediaDir = () => path.join(config.dataDir, 'media');

export async function saveMedia(storyId: string, name: string, bytes: Uint8Array): Promise<string> {
  const dir = path.join(mediaDir(), storyId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), bytes);
  return mediaUrl(storyId, name);
}

export const mediaUrl = (storyId: string, name: string) => `${config.publicUrl}/media/${storyId}/${name}`;

/** Story JSON stores absolute URLs; rebase them when PUBLIC_URL changes (e.g. a new tunnel). */
export function rebaseMediaUrl(url: string | undefined) {
  if (!url) return url;
  const i = url.indexOf('/media/');
  return i >= 0 ? `${config.publicUrl}${url.slice(i)}` : url;
}
