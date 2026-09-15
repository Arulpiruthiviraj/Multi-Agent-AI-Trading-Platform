/**
 * Safe, bounded, O(1)-memory sample of the heap snapshot's "strings" table (near end of file).
 * Streams the file, skips to "strings":[ , and grabs every Nth entry up to a small cap - never
 * holds more than the sample in memory.
 */
import { createReadStream } from 'node:fs';

const FILE = process.argv[2];
const SAMPLE_EVERY = Number(process.argv[3] || '5000');
const MAX_SAMPLES = Number(process.argv[4] || '400');

async function main() {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(FILE, { encoding: 'utf8', highWaterMark: 1 << 20 });
    let carry = '';
    let started = false;
    let stringIndex = 0;
    let samples = [];
    let inString = false;
    let escapeNext = false;
    let curStr = '';

    stream.on('data', (chunk) => {
      if (samples.length >= MAX_SAMPLES) return;
      let text = carry + chunk;
      if (!started) {
        const marker = '"strings":[';
        const idx = text.lastIndexOf(marker);
        if (idx === -1) { carry = text.slice(-marker.length); return; }
        text = text.slice(idx + marker.length);
        started = true;
      }
      for (let i = 0; i < text.length && samples.length < MAX_SAMPLES; i++) {
        const ch = text[i];
        if (!inString) {
          if (ch === '"') { inString = true; curStr = ''; }
          continue;
        }
        if (escapeNext) { curStr += ch; escapeNext = false; continue; }
        if (ch === String.fromCharCode(92)) { escapeNext = true; continue; }
        if (ch === '"') {
          inString = false;
          if (stringIndex % SAMPLE_EVERY === 0) samples.push(curStr.slice(0, 120));
          stringIndex++;
          continue;
        }
        curStr += ch;
      }
      carry = '';
      if (samples.length >= MAX_SAMPLES) { stream.destroy(); resolve(samples); }
    });
    stream.on('close', () => resolve(samples));
    stream.on('error', reject);
  });
}

main().then((samples) => {
  console.log(`Sampled ${samples.length} strings (every ${SAMPLE_EVERY}th):\n`);
  for (const s of samples) console.log(JSON.stringify(s));
}).catch((e) => { console.error('FAILED', e); process.exit(1); });
