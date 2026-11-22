// csv-reader-speed-01 round 3 driver: the harness runs `node /bot/main.ts` (node22).
// Reads every case from /input/cases.json, answers each with the streaming parser
// in solve.js (which emits the answer JSON text directly, without building the
// answer object graph), and writes /output/answers.json. Outside a container
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its
// work runs under it (the rules: the house baseline runs with
// --no-incremental-marking, and an entry may tune V8's flags too).
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types). */
const { parseCase } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  parseCase: (text: string, header: boolean) => string;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as {
  id: string;
  input: { text: string; header: boolean };
}[];
const answers: string[] = [];
for (const c of cases) answers.push(parseCase(c.input.text, c.input.header === true));
writeFileSync(join(OUTPUT_DIR, 'answers.json'), '[' + answers.join(',') + ']');
