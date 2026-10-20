import type { Roms } from '../memory/bus';
import type { KeyValueStore } from '../storage/store';

export type RomKind = 'basic' | 'kernal' | 'chargen' | 'drive';

export const ROM_KINDS: readonly RomKind[] = ['basic', 'kernal', 'chargen', 'drive'];

export const ROM_SIZES: Record<RomKind, number> = {
  basic: 0x2000,
  kernal: 0x2000,
  chargen: 0x1000,
  drive: 0x4000,
};

/** The C64 can't start without these; the 1541 ROM only enables the accurate drive. */
export const REQUIRED_ROMS: readonly RomKind[] = ['basic', 'kernal', 'chargen'];

/** CRC-32s of the original Commodore chips. */
const KNOWN_ROMS: Record<number, RomKind> = {
  0xf833d117: 'basic', // 901226-01
  0xdbe3e7c7: 'kernal', // 901227-03
  0xa5c687b3: 'kernal', // 901227-02
  0xdce782fa: 'kernal', // 901227-01
  0xec4272ee: 'chargen', // 901225-01
  0x57224cde: 'drive', // 1541: 325302-01 + 901229-05
  0x899fa3c5: 'drive', // 1541-II: 251968-03
};

export interface StoredRom {
  /** The file it came from, shown to the user. */
  name: string;
  data: Uint8Array;
}

export interface IdentifiedRom extends StoredRom {
  kind: RomKind;
  /** Set when the file is the right size but not an original Commodore ROM. */
  warning: string | null;
}

export type SystemRoms = Partial<Record<RomKind, StoredRom>>;

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const BASIC_SIGNATURE = 'CBMBASIC';

function hasBasicSignature(data: Uint8Array): boolean {
  return [...BASIC_SIGNATURE].every((char, i) => data[4 + i] === char.charCodeAt(0));
}

/** BASIC and KERNAL are both 8K, so an unfamiliar 8K file is told apart by its contents or name. */
function identify8k(name: string, data: Uint8Array): RomKind {
  const base = name.toLowerCase().split('/').pop()!;
  if (base.includes('basic') || hasBasicSignature(data)) return 'basic';
  if (base.includes('kern')) return 'kernal';
  if (base.includes('1541') || base.includes('dos')) {
    throw new Error(
      `${name} looks like half of a 1541 drive ROM. Use the single 16K (16,384-byte) file, often called dos1541.rom.`,
    );
  }
  throw new Error(`Can't tell whether ${name} is the BASIC or the KERNAL ROM. Rename it to include "basic" or "kernal".`);
}

/** Works out which system ROM a file is; throws if it can't be one. */
export function identifyRom(name: string, data: Uint8Array): IdentifiedRom {
  const known = KNOWN_ROMS[crc32(data)];
  if (known && data.length === ROM_SIZES[known]) return { kind: known, name, data, warning: null };

  let kind: RomKind;
  if (data.length === ROM_SIZES.chargen) kind = 'chargen';
  else if (data.length === ROM_SIZES.drive) kind = 'drive';
  else if (data.length === ROM_SIZES.basic) kind = identify8k(name, data);
  else {
    throw new Error(
      `${name} is ${data.length.toLocaleString('en')} bytes, which isn't a C64 system ROM. ` +
        'BASIC and KERNAL are 8,192 bytes, the character ROM 4,096 and the 1541 drive ROM 16,384.',
    );
  }
  return { kind, name, data, warning: 'not an original Commodore ROM; some software may not work with it' };
}

export function hasRequiredRoms(roms: SystemRoms): boolean {
  return REQUIRED_ROMS.every((kind) => roms[kind]);
}

/** The ROMs the C64 itself maps into memory; throws if any is missing. */
export function machineRoms(roms: SystemRoms): Roms {
  const { basic, kernal, chargen } = roms;
  if (!basic || !kernal || !chargen) throw new Error('The BASIC, KERNAL and character ROMs are all needed.');
  return { basic: basic.data, kernal: kernal.data, chargen: chargen.data };
}

/**
 * The user's ROMs, kept in browser storage (IndexedDB) so they only have to be
 * given once. Saving asks the browser to make the storage persistent, which
 * stops it evicting the ROMs under storage pressure; browsers are likelier to
 * grant that right after a user action like choosing files.
 */
export class SystemRomStore {
  constructor(private readonly store: KeyValueStore<StoredRom>) {}

  async load(): Promise<SystemRoms> {
    const roms: SystemRoms = {};
    for (const [key, rom] of await this.store.entries()) {
      const kind = key as RomKind;
      if (ROM_KINDS.includes(kind) && rom.data.length === ROM_SIZES[kind]) roms[kind] = rom;
    }
    return roms;
  }

  save(kind: RomKind, rom: StoredRom): Promise<void> {
    void globalThis.navigator?.storage?.persist?.().catch(() => false);
    return this.store.put(kind, { name: rom.name, data: rom.data });
  }

  async forget(): Promise<void> {
    await Promise.all(ROM_KINDS.map((kind) => this.store.delete(kind)));
  }
}
