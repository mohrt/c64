import { textToPetscii, type DirectoryEntry, type DiskMedia } from './media';

const PRG_TYPE = 0x82;
const BYTES_PER_BLOCK = 254;
const MAX_NAME_LENGTH = 16;

/** A single .prg file presented as a disk containing just that file. */
export class PrgMedia implements DiskMedia {
  readonly name: Uint8Array;
  readonly id = textToPetscii('PR 2A');
  readonly freeBlocks = 0;
  private readonly entry: DirectoryEntry;

  constructor(
    fileName: string,
    private readonly data: Uint8Array,
  ) {
    if (data.length < 2) throw new Error('A .prg file needs at least a 2-byte load address');
    const baseName = fileName.replace(/\.prg$/i, '').slice(0, MAX_NAME_LENGTH);
    this.name = textToPetscii(baseName);
    this.entry = {
      name: this.name,
      type: PRG_TYPE,
      track: 0,
      sector: 0,
      blocks: Math.ceil(data.length / BYTES_PER_BLOCK),
    };
  }

  files(): DirectoryEntry[] {
    return [this.entry];
  }

  readFile(): Uint8Array {
    return this.data;
  }

  readSector(): Uint8Array | null {
    return null;
  }
}
