import { describe, expect, it } from 'vitest';
import { D64Image } from '../src/disk/d64';
import { petsciiToText } from '../src/disk/media';
import { buildD64, prg } from './helpers/d64-builder';

const bigFile = Uint8Array.from({ length: 1000 }, (_, i) => i & 0xff);

describe('D64Image', () => {
  it('reads the disk name, ID and directory', () => {
    const files = Array.from({ length: 10 }, (_, i) => ({ name: `FILE${i}`, data: prg(0x0801, [i]) }));
    const disk = new D64Image(buildD64('TEST DISK', 'TD 2A', files));

    expect(petsciiToText(disk.name)).toBe('TEST DISK');
    expect(petsciiToText(disk.id)).toBe('TD 2A');
    const entries = disk.files();
    expect(entries.map((e) => petsciiToText(e.name))).toEqual(files.map((f) => f.name));
    expect(entries[0].type).toBe(0x82);
    expect(disk.freeBlocks).toBe(664 - 10);
  });

  it('follows multi-sector file chains and trims the last sector', () => {
    const disk = new D64Image(buildD64('X', 'XX 2A', [{ name: 'BIG', data: bigFile }]));
    const [entry] = disk.files();
    expect(entry.blocks).toBe(4);
    expect(disk.readFile(entry)).toEqual(bigFile);
  });

  it('reads raw sectors and rejects ones that do not exist', () => {
    const disk = new D64Image(buildD64('X', 'XX 2A', [{ name: 'BIG', data: bigFile }]));
    expect(disk.readSector(1, 0)?.[2]).toBe(0);
    expect(disk.readSector(18, 0)?.[0]).toBe(18);
    expect(disk.readSector(18, 19)).toBeNull();
    expect(disk.readSector(36, 0)).toBeNull();
    expect(disk.readSector(0, 0)).toBeNull();
  });

  it('accepts the image sizes with error bytes and 40 tracks', () => {
    expect(D64Image.isD64Size(174848)).toBe(true);
    expect(D64Image.isD64Size(175531)).toBe(true);
    expect(D64Image.isD64Size(196608)).toBe(true);
    expect(D64Image.isD64Size(12345)).toBe(false);
    expect(() => new D64Image(new Uint8Array(12345))).toThrow(/Not a D64/);
  });
});
