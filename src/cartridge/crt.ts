const SIGNATURE = 'C64 CARTRIDGE   ';
const CHIP_SIGNATURE = 'CHIP';
const HEADER_MIN_LENGTH = 0x40;
const CHIP_HEADER_LENGTH = 0x10;

export interface CrtChip {
  /** 0 = ROM, 1 = RAM, 2 = flash. */
  type: number;
  bank: number;
  loadAddress: number;
  data: Uint8Array;
}

export interface CrtImage {
  name: string;
  hardwareType: number;
  /** Initial EXROM/GAME line states; true means the line is pulled low. */
  exrom: boolean;
  game: boolean;
  chips: CrtChip[];
}

const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);

export function isCrt(data: Uint8Array): boolean {
  return data.length >= HEADER_MIN_LENGTH && ascii(data.subarray(0, 16)) === SIGNATURE;
}

/** Parses a .crt cartridge image (a header followed by CHIP packets). */
export function parseCrt(data: Uint8Array): CrtImage {
  if (!isCrt(data)) throw new Error('Not a .crt cartridge image');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const headerLength = Math.max(view.getUint32(0x10), HEADER_MIN_LENGTH);
  const name = ascii(data.subarray(0x20, 0x40)).replace(/\0.*$/s, '').trim();

  const chips: CrtChip[] = [];
  let offset = headerLength;
  while (offset + CHIP_HEADER_LENGTH <= data.length) {
    if (ascii(data.subarray(offset, offset + 4)) !== CHIP_SIGNATURE) {
      throw new Error(`Damaged .crt file: expected a CHIP packet at offset ${offset}`);
    }
    const packetLength = view.getUint32(offset + 4);
    const size = view.getUint16(offset + 14);
    chips.push({
      type: view.getUint16(offset + 8),
      bank: view.getUint16(offset + 10),
      loadAddress: view.getUint16(offset + 12),
      data: data.slice(offset + CHIP_HEADER_LENGTH, offset + CHIP_HEADER_LENGTH + size),
    });
    if (packetLength < CHIP_HEADER_LENGTH) break;
    offset += packetLength;
  }

  return {
    name,
    hardwareType: view.getUint16(0x16),
    exrom: data[0x18] === 0,
    game: data[0x19] === 0,
    chips,
  };
}
