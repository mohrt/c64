import { describe, expect, it } from 'vitest';
import { petsciiToText } from '../src/disk/media';
import { isT64, t64ToD64 } from '../src/disk/t64';

interface TapeFile {
  name: string;
  start: number;
  body: number[];
  /** Overrides the end address, to mimic broken T64 headers. */
  end?: number;
}

function buildT64(tapeName: string, files: TapeFile[]): Uint8Array {
  const header = 0x40 + files.length * 0x20;
  const total = header + files.reduce((n, f) => n + f.body.length, 0);
  const data = new Uint8Array(total);
  const view = new DataView(data.buffer);
  data.set([...'C64 tape image file'].map((c) => c.charCodeAt(0)), 0);
  view.setUint16(0x20, 0x0101, true);
  view.setUint16(0x22, files.length, true);
  view.setUint16(0x24, files.length, true);
  data.fill(0x20, 0x28, 0x40);
  data.set([...tapeName].map((c) => c.charCodeAt(0)), 0x28);
  let offset = header;
  files.forEach((file, i) => {
    const at = 0x40 + i * 0x20;
    data[at] = 1;
    data[at + 1] = 0x82;
    view.setUint16(at + 2, file.start, true);
    view.setUint16(at + 4, file.end ?? file.start + file.body.length, true);
    view.setUint32(at + 8, offset, true);
    data.fill(0x20, at + 16, at + 32);
    data.set([...file.name].map((c) => c.charCodeAt(0)), at + 16);
    data.set(file.body, offset);
    offset += file.body.length;
  });
  return data;
}

describe('T64 tape images', () => {
  it('converts every program into a file on a disk', () => {
    const image = buildT64('MY TAPE', [
      { name: 'GAME', start: 0x0801, body: [1, 2, 3, 4] },
      { name: 'DATA', start: 0xc000, body: [9, 8, 7] },
    ]);
    expect(isT64(image)).toBe(true);
    const disk = t64ToD64(image);
    expect(petsciiToText(disk.name)).toBe('MY TAPE');
    const files = disk.files();
    expect(files.map((f) => petsciiToText(f.name))).toEqual(['GAME', 'DATA']);
    expect([...disk.readFile(files[0])]).toEqual([0x01, 0x08, 1, 2, 3, 4]);
    expect([...disk.readFile(files[1])]).toEqual([0x00, 0xc0, 9, 8, 7]);
  });

  it('uses the stored length when the end address is wrong', () => {
    const image = buildT64('BROKEN', [{ name: 'GAME', start: 0x0801, body: [1, 2, 3, 4, 5], end: 0xc3c6 }]);
    const disk = t64ToD64(image);
    expect([...disk.readFile(disk.files()[0])]).toEqual([0x01, 0x08, 1, 2, 3, 4, 5]);
  });

  it('rejects other files', () => {
    expect(isT64(new Uint8Array(64))).toBe(false);
    expect(() => t64ToD64(new Uint8Array(64))).toThrow(/Not a \.t64/);
  });
});
