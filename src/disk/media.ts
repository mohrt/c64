export const SECTOR_SIZE = 256;

/** PETSCII shifted space, used to pad names on disk. */
export const PETSCII_PAD = 0xa0;
const CR = 0x0d;

export const FILE_TYPES = ['DEL', 'SEQ', 'PRG', 'USR', 'REL'] as const;

export interface DirectoryEntry {
  /** Name as PETSCII bytes, without padding. */
  name: Uint8Array;
  /** Raw type byte: bits 0-2 type, bit 6 locked, bit 7 closed. */
  type: number;
  track: number;
  sector: number;
  blocks: number;
}

/** Something that can be inserted into the virtual drive. */
export interface DiskMedia {
  /** Disk name as PETSCII bytes, without padding. */
  readonly name: Uint8Array;
  /** Disk ID and DOS type as shown in the directory header, e.g. "ZK 2A". */
  readonly id: Uint8Array;
  readonly freeBlocks: number;
  files(): DirectoryEntry[];
  readFile(entry: DirectoryEntry): Uint8Array;
  /** Raw sector access for block commands; null if the sector doesn't exist. */
  readSector(track: number, sector: number): Uint8Array | null;
}

export function trimPadding(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === PETSCII_PAD) end--;
  return bytes.slice(0, end);
}

/** Converts PETSCII to readable ASCII for display (letters come out uppercase). */
export function petsciiToText(bytes: Uint8Array): string {
  let text = '';
  for (const b of bytes) {
    if (b === CR) text += '\n';
    else if (b >= 0x20 && b < 0x5b) text += String.fromCharCode(b);
    else if (b >= 0xc1 && b <= 0xda) text += String.fromCharCode(b - 0x80);
    else if (b === PETSCII_PAD) text += ' ';
    else text += '?';
  }
  return text;
}

export function textToPetscii(text: string): Uint8Array {
  return Uint8Array.from(text.toUpperCase(), (ch) => {
    const code = ch.charCodeAt(0);
    return code === CR || (code >= 0x20 && code < 0x5b) ? code : 0x3f;
  });
}
