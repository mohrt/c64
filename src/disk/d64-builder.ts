import { PETSCII_PAD, textToPetscii } from './media';

const D64_SIZE = 174848;
const SECTOR = 256;
const BYTES_PER_BLOCK = 254;
const DIRECTORY_TRACK = 18;
const PRG_CLOSED = 0x82;

export interface D64File {
  /** Text (converted to PETSCII) or PETSCII bytes. */
  name: string | Uint8Array;
  data: Uint8Array;
  type?: number;
}

function sectorsPerTrack(track: number): number {
  if (track <= 17) return 21;
  if (track <= 24) return 19;
  if (track <= 30) return 18;
  return 17;
}

function offsetOf(track: number, sector: number): number {
  let offset = 0;
  for (let t = 1; t < track; t++) offset += sectorsPerTrack(t) * SECTOR;
  return offset + sector * SECTOR;
}

function writeName(image: Uint8Array, at: number, name: string | Uint8Array): void {
  image.fill(PETSCII_PAD, at, at + 16);
  image.set((typeof name === 'string' ? textToPetscii(name) : name).subarray(0, 16), at);
}

/**
 * Builds a 35-track D64. Files are stored sequentially from track 1 (skipping
 * the directory track), and the directory uses sectors 18/1, 18/4, ...
 */
export function buildD64(diskName: string | Uint8Array, diskId: string, files: D64File[]): Uint8Array {
  const image = new Uint8Array(D64_SIZE);

  const bam = offsetOf(DIRECTORY_TRACK, 0);
  image[bam] = DIRECTORY_TRACK;
  image[bam + 1] = 1;
  image[bam + 2] = 0x41;
  for (let track = 1; track <= 35; track++) image[bam + 4 * track] = sectorsPerTrack(track);
  writeName(image, bam + 0x90, diskName);
  image.set(textToPetscii(diskId), bam + 0xa2);

  let track = 1;
  let sector = 0;
  const allocate = () => {
    if (track > 35) throw new Error('Files do not fit on a D64');
    const at = { track, sector };
    image[bam + 4 * track]--;
    if (++sector === sectorsPerTrack(track)) {
      sector = 0;
      track = track + 1 === DIRECTORY_TRACK ? track + 2 : track + 1;
    }
    return at;
  };

  const directorySectors = Math.max(1, Math.ceil(files.length / 8));
  const directoryAt = (index: number) => offsetOf(DIRECTORY_TRACK, 1 + index * 3);
  for (let i = 0; i < directorySectors; i++) {
    const at = directoryAt(i);
    const last = i === directorySectors - 1;
    image[at] = last ? 0 : DIRECTORY_TRACK;
    image[at + 1] = last ? 0xff : 1 + (i + 1) * 3;
  }

  files.forEach((file, index) => {
    const blocks = Math.max(1, Math.ceil(file.data.length / BYTES_PER_BLOCK));
    const chain = Array.from({ length: blocks }, allocate);
    chain.forEach((at, i) => {
      const offset = offsetOf(at.track, at.sector);
      const chunk = file.data.subarray(i * BYTES_PER_BLOCK, (i + 1) * BYTES_PER_BLOCK);
      image.set(chunk, offset + 2);
      const next = chain[i + 1];
      image[offset] = next ? next.track : 0;
      image[offset + 1] = next ? next.sector : chunk.length + 1;
    });

    const entry = directoryAt(Math.floor(index / 8)) + (index % 8) * 32;
    image[entry + 2] = file.type ?? PRG_CLOSED;
    image[entry + 3] = chain[0].track;
    image[entry + 4] = chain[0].sector;
    writeName(image, entry + 5, file.name);
    image[entry + 30] = blocks & 0xff;
    image[entry + 31] = blocks >> 8;
  });

  return image;
}
