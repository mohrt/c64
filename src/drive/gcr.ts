import type { D64Image } from '../disk/d64';

/** 4-bit nibble to 5-bit GCR code, chosen so the bit stream never has more than two 0s in a row. */
const GCR_CODES = [
  0x0a, 0x0b, 0x12, 0x13, 0x0e, 0x0f, 0x16, 0x17, 0x09, 0x19, 0x1a, 0x1b, 0x0d, 0x1d, 0x1e, 0x15,
];
const GCR_DECODE = new Int8Array(32).fill(-1);
GCR_CODES.forEach((code, nibble) => (GCR_DECODE[code] = nibble));

const SYNC_BYTE = 0xff;
const SYNC_LENGTH = 5;
const GAP_BYTE = 0x55;
const HEADER_GAP = 9;
const HEADER_BLOCK_ID = 0x08;
const DATA_BLOCK_ID = 0x07;
const HEADER_OFF_BYTE = 0x0f;
const SECTOR_SIZE = 256;

/** Raw bytes per track in each of the four speed zones (zone 3 is the outer, fastest one). */
const TRACK_BYTES = [6250, 6666, 7142, 7692];
/** Drive cycles per byte under the head in each speed zone. */
export const CYCLES_PER_BYTE = [32, 30, 28, 26];

export const MAX_HALF_TRACK = 84;

export function speedZone(track: number): number {
  if (track <= 17) return 3;
  if (track <= 24) return 2;
  if (track <= 30) return 1;
  return 0;
}

export function sectorsPerTrack(track: number): number {
  return [17, 18, 19, 21][speedZone(track)];
}

/** Encodes bytes (a multiple of 4) into GCR, 4 bytes becoming 5. */
export function encodeGcr(bytes: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array((bytes.length / 4) * 5);
  for (let i = 0, o = 0; i < bytes.length; i += 4, o += 5) {
    let bits = 0n;
    for (let j = 0; j < 4; j++) {
      const b = bytes[i + j];
      bits = (bits << 10n) | (BigInt(GCR_CODES[b >> 4]) << 5n) | BigInt(GCR_CODES[b & 0x0f]);
    }
    for (let j = 4; j >= 0; j--) {
      out[o + j] = Number(bits & 0xffn);
      bits >>= 8n;
    }
  }
  return out;
}

/** Decodes GCR (a multiple of 5 bytes); returns null if any code is invalid. */
export function decodeGcr(gcr: ArrayLike<number>): Uint8Array | null {
  const out = new Uint8Array((gcr.length / 5) * 4);
  for (let i = 0, o = 0; i < gcr.length; i += 5, o += 4) {
    let bits = 0n;
    for (let j = 0; j < 5; j++) bits = (bits << 8n) | BigInt(gcr[i + j]);
    for (let j = 3; j >= 0; j--) {
      const lo = GCR_DECODE[Number(bits & 0x1fn)];
      const hi = GCR_DECODE[Number((bits >> 5n) & 0x1fn)];
      if (lo < 0 || hi < 0) return null;
      out[o + j] = (hi << 4) | lo;
      bits >>= 10n;
    }
  }
  return out;
}

function xorAll(bytes: ArrayLike<number>): number {
  let x = 0;
  for (let i = 0; i < bytes.length; i++) x ^= bytes[i];
  return x;
}

/** One formatted track: sync, header, gap, sync, data block, gap; repeated per sector. */
export function encodeTrack(track: number, readSector: (sector: number) => Uint8Array, id1: number, id2: number): Uint8Array {
  const sectors = sectorsPerTrack(track);
  const trackBytes = TRACK_BYTES[speedZone(track)];
  const sectorBytes = SYNC_LENGTH + 10 + HEADER_GAP + SYNC_LENGTH + 325;
  const tailGap = Math.floor((trackBytes - sectors * sectorBytes) / sectors);

  const out = new Uint8Array(trackBytes).fill(GAP_BYTE);
  let pos = 0;
  for (let sector = 0; sector < sectors; sector++) {
    out.fill(SYNC_BYTE, pos, pos + SYNC_LENGTH);
    pos += SYNC_LENGTH;
    const checksum = sector ^ track ^ id2 ^ id1;
    out.set(encodeGcr([HEADER_BLOCK_ID, checksum, sector, track, id2, id1, HEADER_OFF_BYTE, HEADER_OFF_BYTE]), pos);
    pos += 10 + HEADER_GAP;

    out.fill(SYNC_BYTE, pos, pos + SYNC_LENGTH);
    pos += SYNC_LENGTH;
    const data = readSector(sector);
    const block = new Uint8Array(SECTOR_SIZE + 4);
    block[0] = DATA_BLOCK_ID;
    block.set(data, 1);
    block[SECTOR_SIZE + 1] = xorAll(data);
    out.set(encodeGcr(block), pos);
    pos += 325 + tailGap;
  }
  return out;
}

/** Reads `length` bytes starting at `start`, wrapping around the end of the (circular) track. */
function circularSlice(track: Uint8Array, start: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = track[(start + i) % track.length];
  return out;
}

/**
 * Finds each sector on a GCR track the way the DOS does: a sync mark, a header
 * block naming the sector, then (after the next sync) its data block. Sectors
 * whose blocks don't decode are left out.
 */
export function decodeTrack(track: Uint8Array): Map<number, Uint8Array> {
  const sectors = new Map<number, Uint8Array>();
  let headerSector = -1;
  for (let i = 0; i < track.length; i++) {
    const isSyncEnd = track[i] === SYNC_BYTE && track[(i + 1) % track.length] !== SYNC_BYTE;
    if (!isSyncEnd || track[(i + track.length - 1) % track.length] !== SYNC_BYTE) continue;
    const start = (i + 1) % track.length;
    const first = decodeGcr(circularSlice(track, start, 5));
    if (!first) continue;
    if (first[0] === HEADER_BLOCK_ID) {
      const header = decodeGcr(circularSlice(track, start, 10));
      headerSector = header ? header[2] : -1;
    } else if (first[0] === DATA_BLOCK_ID && headerSector >= 0) {
      const block = decodeGcr(circularSlice(track, start, 325));
      if (block && !sectors.has(headerSector)) sectors.set(headerSector, block.slice(1, SECTOR_SIZE + 1));
      headerSector = -1;
    }
  }
  return sectors;
}

/** A disk as the 1541's read head sees it: GCR bytes per half-track. */
export class GcrDisk {
  /** Indexed by half-track (track * 2); odd half-tracks between tracks are empty. */
  readonly halfTracks: (Uint8Array | null)[] = new Array(MAX_HALF_TRACK + 1).fill(null);
  /** Disks stay write-protected until written sectors have somewhere to be kept. */
  writeProtected = true;
  /** Half-tracks the drive has written to since the last `writeChangesTo()`. */
  private readonly written = new Set<number>();

  static fromD64(image: D64Image): GcrDisk {
    const disk = new GcrDisk();
    const [id1, id2] = image.id;
    for (let track = 1; track <= image.tracks; track++) {
      disk.halfTracks[track * 2] = encodeTrack(track, (sector) => image.readSector(track, sector)!, id1, id2);
    }
    return disk;
  }

  markWritten(halfTrack: number): void {
    this.written.add(halfTrack);
  }

  get modified(): boolean {
    return this.written.size > 0;
  }

  /** Copies sectors from written tracks back into `image` and forgets the changes. */
  writeChangesTo(image: D64Image): void {
    for (const halfTrack of this.written) {
      const data = this.halfTracks[halfTrack];
      if (!data || halfTrack % 2 !== 0) continue;
      const track = halfTrack / 2;
      for (const [sector, bytes] of decodeTrack(data)) image.writeSector(track, sector, bytes);
    }
    this.written.clear();
  }
}
