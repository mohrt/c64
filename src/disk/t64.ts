import { D64Image } from './d64';
import { buildD64, type D64File } from './d64-builder';

const HEADER_SIZE = 0x40;
const ENTRY_SIZE = 0x20;
const TAPE_NAME = 0x28;
const TAPE_NAME_LENGTH = 24;
const MAX_ENTRIES = 0x22;
const USED_ENTRIES = 0x24;
const ENTRY_NORMAL_FILE = 1;
const PRG_CLOSED = 0x82;

export function isT64(data: Uint8Array): boolean {
  return data.length >= HEADER_SIZE && String.fromCharCode(...data.subarray(0, 3)) === 'C64';
}

function trimName(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0x20 || bytes[end - 1] === 0xa0 || bytes[end - 1] === 0)) end--;
  return bytes.slice(0, end);
}

interface TapeEntry {
  name: Uint8Array;
  start: number;
  end: number;
  offset: number;
}

/**
 * Converts a .t64 tape archive into a disk holding the same programs, so it can
 * be loaded with LOAD"*",8,1 by either drive. Many T64 files store a wrong end
 * address, so lengths are taken from the file layout when they disagree.
 */
export function t64ToD64(data: Uint8Array): D64Image {
  if (!isT64(data)) throw new Error('Not a .t64 tape image');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const slots = Math.max(view.getUint16(MAX_ENTRIES, true), view.getUint16(USED_ENTRIES, true), 1);

  const entries: TapeEntry[] = [];
  for (let i = 0; i < slots; i++) {
    const at = HEADER_SIZE + i * ENTRY_SIZE;
    if (at + ENTRY_SIZE > data.length) break;
    if (data[at] !== ENTRY_NORMAL_FILE) continue;
    entries.push({
      start: view.getUint16(at + 2, true),
      end: view.getUint16(at + 4, true),
      offset: view.getUint32(at + 8, true),
      name: trimName(data.subarray(at + 16, at + 32)),
    });
  }
  if (entries.length === 0) throw new Error('The tape image contains no programs');

  const byOffset = [...entries].sort((a, b) => a.offset - b.offset);
  const files: D64File[] = entries.map((entry) => {
    const next = byOffset.find((other) => other.offset > entry.offset);
    const available = (next ? next.offset : data.length) - entry.offset;
    const stated = entry.end - entry.start;
    const length = stated > 0 && stated <= available ? stated : available;
    const file = new Uint8Array(length + 2);
    file[0] = entry.start & 0xff;
    file[1] = entry.start >> 8;
    file.set(data.subarray(entry.offset, entry.offset + length), 2);
    return { name: entry.name.length ? entry.name : 'PROGRAM', data: file, type: PRG_CLOSED };
  });

  const tapeName = trimName(data.subarray(TAPE_NAME, TAPE_NAME + TAPE_NAME_LENGTH)).subarray(0, 16);
  return new D64Image(buildD64(tapeName.length ? tapeName : 'TAPE', 'TP 2A', files));
}
