import { describe, expect, it } from 'vitest';
import { isZip, readZip, usableFilesInZip } from '../src/disk/zip';

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface TestEntry {
  name: string;
  data: Uint8Array;
  deflate?: boolean;
}

/** Builds a minimal .zip (CRCs are left zero; the reader doesn't check them). */
async function buildZip(entries: TestEntry[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const body = entry.deflate ? await deflateRaw(entry.data) : entry.data;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, entry.deflate ? 8 : 0, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);

    const header = new Uint8Array(46 + name.length);
    const cv = new DataView(header.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, entry.deflate ? 8 : 0, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    header.set(name, 46);

    parts.push(local, body);
    central.push(header);
    offset += local.length + body.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const all = [...parts, ...central, end];
  const zip = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    zip.set(p, at);
    at += p.length;
  }
  return zip;
}

const bytes = (length: number, seed: number) => Uint8Array.from({ length }, (_, i) => (i * seed) & 0xff);

describe('zip', () => {
  it('reads stored and deflated entries', async () => {
    const zip = await buildZip([
      { name: 'readme.txt', data: new TextEncoder().encode('hello') },
      { name: 'game.d64', data: bytes(5000, 7), deflate: true },
    ]);
    expect(isZip(zip)).toBe(true);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['readme.txt', 'game.d64']);
    expect(new TextDecoder().decode(await entries[0].read())).toBe('hello');
    expect(await entries[1].read()).toEqual(bytes(5000, 7));
  });

  it('offers disk images first, in name order, and skips other files', async () => {
    const zip = await buildZip([
      { name: 'Lemmings/Disk 2.d64', data: bytes(10, 1) },
      { name: 'Lemmings/info.nfo', data: bytes(10, 2) },
      { name: 'Lemmings/loader.prg', data: bytes(10, 3) },
      { name: 'Lemmings/Disk 1 Side A.d64', data: bytes(10, 4), deflate: true },
      { name: '__MACOSX/._Disk 1.d64', data: bytes(10, 5) },
    ]);
    const files = await usableFilesInZip(zip);
    expect(files.map((f) => f.name)).toEqual(['Disk 1 Side A.d64', 'Disk 2.d64', 'loader.prg']);
    expect(new Uint8Array(await files[0].arrayBuffer())).toEqual(bytes(10, 4));
  });

  it('rejects damaged archives', () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    expect(() => readZip(zip)).toThrow(/damaged/);
  });
});
