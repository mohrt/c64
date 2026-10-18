export interface TestChip {
  bank: number;
  loadAddress: number;
  data: Uint8Array;
}

/** Builds a .crt image with the given hardware type, initial lines and CHIP packets. */
export function buildCrt(hardwareType: number, lines: { exrom: boolean; game: boolean }, chips: TestChip[], name = 'TEST'): Uint8Array {
  const header = new Uint8Array(0x40);
  header.set([...'C64 CARTRIDGE   '].map((c) => c.charCodeAt(0)), 0);
  const view = new DataView(header.buffer);
  view.setUint32(0x10, 0x40);
  view.setUint16(0x14, 0x0100);
  view.setUint16(0x16, hardwareType);
  header[0x18] = lines.exrom ? 0 : 1;
  header[0x19] = lines.game ? 0 : 1;
  header.set([...name].map((c) => c.charCodeAt(0)), 0x20);

  const packets = chips.map((chip) => {
    const packet = new Uint8Array(0x10 + chip.data.length);
    const pv = new DataView(packet.buffer);
    packet.set([...'CHIP'].map((c) => c.charCodeAt(0)), 0);
    pv.setUint32(4, packet.length);
    pv.setUint16(8, 0);
    pv.setUint16(10, chip.bank);
    pv.setUint16(12, chip.loadAddress);
    pv.setUint16(14, chip.data.length);
    packet.set(chip.data, 0x10);
    return packet;
  });

  const total = header.length + packets.reduce((n, p) => n + p.length, 0);
  const crt = new Uint8Array(total);
  crt.set(header, 0);
  let offset = header.length;
  for (const p of packets) {
    crt.set(p, offset);
    offset += p.length;
  }
  return crt;
}

/** An 8K bank filled with `fill`, with `code` placed at `offset`. */
export function bank8k(fill: number, code: number[] = [], offset = 0): Uint8Array {
  const data = new Uint8Array(0x2000).fill(fill);
  data.set(code, offset);
  return data;
}

/** ROML start: cold/warm start vectors to $8009, then the "CBM80" signature the KERNAL looks for. */
export function autostartHeader(): number[] {
  return [0x09, 0x80, 0x09, 0x80, 0xc3, 0xc2, 0xcd, 0x38, 0x30];
}
