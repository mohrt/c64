import { SECTOR_SIZE, trimPadding, type DirectoryEntry, type DiskMedia } from './media';

const DIRECTORY_TRACK = 18;
const BAM_SECTOR = 0;
const FIRST_DIRECTORY_SECTOR = 1;
const DIRECTORY_ENTRY_SIZE = 32;
const BAM_DISK_NAME = 0x90;
const BAM_DISK_ID = 0xa2;
const NAME_LENGTH = 16;
const ID_LENGTH = 5;
/** Upper bound on chain length, so a corrupt image can't loop forever. */
const MAX_CHAIN_SECTORS = 802;

/** Image sizes: 35 or 40 tracks, each with or without one error byte per sector. */
const IMAGE_TRACKS = new Map<number, number>([
  [174848, 35],
  [175531, 35],
  [196608, 40],
  [197376, 40],
]);

function sectorsPerTrack(track: number): number {
  if (track <= 17) return 21;
  if (track <= 24) return 19;
  if (track <= 30) return 18;
  return 17;
}

/** A 1541 disk image. */
export class D64Image implements DiskMedia {
  readonly tracks: number;
  private readonly trackOffsets: number[] = [];

  static isD64Size(size: number): boolean {
    return IMAGE_TRACKS.has(size);
  }

  constructor(private readonly data: Uint8Array) {
    const tracks = IMAGE_TRACKS.get(data.length);
    if (tracks === undefined) throw new Error(`Not a D64 image (${data.length} bytes)`);
    this.tracks = tracks;

    let offset = 0;
    for (let track = 1; track <= tracks; track++) {
      this.trackOffsets[track] = offset;
      offset += sectorsPerTrack(track) * SECTOR_SIZE;
    }
  }

  /** Disk name from the BAM (read live, since formatting the disk changes it). */
  get name(): Uint8Array {
    const bam = this.requireSector(DIRECTORY_TRACK, BAM_SECTOR);
    return trimPadding(bam.slice(BAM_DISK_NAME, BAM_DISK_NAME + NAME_LENGTH));
  }

  get id(): Uint8Array {
    return this.requireSector(DIRECTORY_TRACK, BAM_SECTOR).slice(BAM_DISK_ID, BAM_DISK_ID + ID_LENGTH);
  }

  /** The raw image, e.g. for downloading after the drive has written to it. */
  get bytes(): Uint8Array {
    return this.data.slice();
  }

  writeSector(track: number, sector: number, bytes: Uint8Array): void {
    if (track < 1 || track > this.tracks || sector < 0 || sector >= sectorsPerTrack(track)) return;
    this.data.set(bytes.subarray(0, SECTOR_SIZE), this.trackOffsets[track] + sector * SECTOR_SIZE);
  }

  get freeBlocks(): number {
    const bam = this.requireSector(DIRECTORY_TRACK, BAM_SECTOR);
    let free = 0;
    for (let track = 1; track <= Math.min(this.tracks, 35); track++) {
      if (track !== DIRECTORY_TRACK) free += bam[4 * track];
    }
    return free;
  }

  readSector(track: number, sector: number): Uint8Array | null {
    if (track < 1 || track > this.tracks || sector < 0 || sector >= sectorsPerTrack(track)) {
      return null;
    }
    const start = this.trackOffsets[track] + sector * SECTOR_SIZE;
    return this.data.slice(start, start + SECTOR_SIZE);
  }

  files(): DirectoryEntry[] {
    const entries: DirectoryEntry[] = [];
    for (const sector of this.chain(DIRECTORY_TRACK, FIRST_DIRECTORY_SECTOR)) {
      for (let offset = 0; offset < SECTOR_SIZE; offset += DIRECTORY_ENTRY_SIZE) {
        const type = sector[offset + 2];
        if (type === 0) continue;
        entries.push({
          type,
          track: sector[offset + 3],
          sector: sector[offset + 4],
          name: trimPadding(sector.slice(offset + 5, offset + 5 + NAME_LENGTH)),
          blocks: sector[offset + 30] | (sector[offset + 31] << 8),
        });
      }
    }
    return entries;
  }

  readFile(entry: DirectoryEntry): Uint8Array {
    const parts: Uint8Array[] = [];
    let length = 0;
    for (const sector of this.chain(entry.track, entry.sector)) {
      // In the last sector, byte 1 is the index of the last used byte.
      const end = sector[0] === 0 ? Math.max(sector[1] + 1, 2) : SECTOR_SIZE;
      const part = sector.subarray(2, end);
      parts.push(part);
      length += part.length;
    }
    const file = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      file.set(part, offset);
      offset += part.length;
    }
    return file;
  }

  /** Follows a track/sector link chain. */
  private *chain(track: number, sector: number): Generator<Uint8Array> {
    for (let count = 0; track !== 0 && count < MAX_CHAIN_SECTORS; count++) {
      const data = this.readSector(track, sector);
      if (!data) return;
      yield data;
      track = data[0];
      sector = data[1];
    }
  }

  private requireSector(track: number, sector: number): Uint8Array {
    const data = this.readSector(track, sector);
    if (!data) throw new Error(`Sector ${track}/${sector} is missing`);
    return data;
  }
}
