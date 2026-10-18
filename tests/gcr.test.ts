import { describe, expect, it } from 'vitest';
import { D64Image } from '../src/disk/d64';
import { GcrDisk, decodeGcr, encodeGcr, sectorsPerTrack } from '../src/drive/gcr';
import { buildD64, prg } from './helpers/d64-builder';

/** Finds sector blocks by scanning for sync marks, like the 1541 DOS does. */
function readBlocks(track: Uint8Array) {
  const blocks: Uint8Array[] = [];
  for (let i = 0; i < track.length; i++) {
    if (track[i] !== 0xff || track[i + 1] === 0xff) continue;
    const start = i + 1;
    const isHeader = decodeGcr(track.subarray(start, start + 5))?.[0] === 0x08;
    const length = isHeader ? 10 : 325;
    const decoded = decodeGcr(track.subarray(start, start + length));
    if (decoded) blocks.push(decoded);
  }
  return blocks;
}

describe('GCR', () => {
  it('round-trips arbitrary bytes and never produces long runs of zeros', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const gcr = encodeGcr(bytes);
    expect(gcr.length).toBe(320);
    expect(decodeGcr(gcr)).toEqual(bytes);
    const bits = [...gcr].map((b) => b.toString(2).padStart(8, '0')).join('');
    expect(bits).not.toContain('000');
  });

  it('encodes every sector of a D64 with valid headers and checksums', () => {
    const data = Uint8Array.from({ length: 3000 }, (_, i) => (i * 7) & 0xff);
    const image = new D64Image(buildD64('GCR TEST', 'GT 2A', [{ name: 'FILE', data: prg(0x0801, data) }]));
    const disk = GcrDisk.fromD64(image);

    for (const track of [1, 17, 18, 24, 25, 30, 31, 35]) {
      const raw = disk.halfTracks[track * 2]!;
      const expectedLength = track <= 17 ? 7692 : track <= 24 ? 7142 : track <= 30 ? 6666 : 6250;
      expect(raw.length).toBe(expectedLength);
      const blocks = readBlocks(raw);
      const headers = blocks.filter((b) => b[0] === 0x08);
      const sectors = blocks.filter((b) => b[0] === 0x07);
      expect(headers.length).toBe(sectorsPerTrack(track));
      expect(sectors.length).toBe(sectorsPerTrack(track));

      headers.forEach((header, sector) => {
        expect(header[2]).toBe(sector);
        expect(header[3]).toBe(track);
        expect(header[1]).toBe(header[2] ^ header[3] ^ header[4] ^ header[5]);
        expect(String.fromCharCode(header[5], header[4])).toBe('GT');
      });
      sectors.forEach((block, sector) => {
        const payload = block.subarray(1, 257);
        expect(payload).toEqual(image.readSector(track, sector));
        expect(block[257]).toBe(payload.reduce((x, b) => x ^ b, 0));
      });
    }
    expect(disk.halfTracks[3]).toBeNull();
  });
});
