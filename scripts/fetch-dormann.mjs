// Downloads Klaus Dormann's 6502 functional test binary (GPL, not committed).
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const url =
  'https://raw.githubusercontent.com/Klaus2m5/6502_65C02_functional_tests/master/bin_files/6502_functional_test.bin';
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'dormann');
const outFile = join(outDir, '6502_functional_test.bin');

const response = await fetch(url);
if (!response.ok) {
  console.error(`Download failed: ${response.status} ${response.statusText}`);
  process.exit(1);
}
await mkdir(outDir, { recursive: true });
await writeFile(outFile, Buffer.from(await response.arrayBuffer()));
console.log(`Saved ${outFile}`);
