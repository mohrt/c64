// Downloads the MEGA65 Open ROMs (LGPL) into public/roms/. They are free to
// redistribute but are kept out of git; the deploy workflow runs this too.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://raw.githubusercontent.com/MEGA65/open-roms/master';
const FILES = {
  'bin/basic_generic.rom': 'basic.rom',
  'bin/kernal_generic.rom': 'kernal.rom',
  'bin/chargen_openroms.rom': 'chargen.rom',
  'LICENSE': 'LICENSE',
  'COPYING': 'COPYING',
  'COPYING.LESSER': 'COPYING.LESSER',
};

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'roms');
await mkdir(outDir, { recursive: true });

for (const [source, target] of Object.entries(FILES)) {
  const response = await fetch(`${SOURCE}/${source}`);
  if (!response.ok) {
    console.error(`Download of ${source} failed: ${response.status} ${response.statusText}`);
    process.exit(1);
  }
  await writeFile(join(outDir, target), Buffer.from(await response.arrayBuffer()));
  console.log(`Saved public/roms/${target}`);
}
