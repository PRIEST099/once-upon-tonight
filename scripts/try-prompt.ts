/** `npx tsx scripts/try-prompt.ts "<prompt>" out.jpg` — one-off image prompt experiment. */
import fs from 'node:fs';
import { illustrate } from '../src/story/illustrator.js';
fs.writeFileSync(process.argv[3], await illustrate(process.argv[2], 777));
console.log('→', process.argv[3]);
