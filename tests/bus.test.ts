import { describe, expect, it } from 'vitest';
import { Bus, type IoDevice } from '../src/memory/bus';

function makeBus() {
  const roms = {
    basic: new Uint8Array(0x2000).fill(0xba),
    kernal: new Uint8Array(0x2000).fill(0xce),
    chargen: new Uint8Array(0x1000).fill(0xc6),
  };
  const writes: Array<[string, number, number]> = [];
  const device = (name: string): IoDevice => ({
    read: (register) => register,
    write: (register, value) => writes.push([name, register, value]),
  });
  const bus = new Bus(roms);
  bus.attachIo({ vic: device('vic'), sid: device('sid'), cia1: device('cia1'), cia2: device('cia2') });
  return { bus, writes };
}

describe('Bus', () => {
  it('maps BASIC, KERNAL and I/O in the default configuration', () => {
    const { bus } = makeBus();
    expect(bus.read(0xa000)).toBe(0xba);
    expect(bus.read(0xe000)).toBe(0xce);
    expect(bus.read(0xd012)).toBe(0x12);
    expect(bus.read(0xdc0d)).toBe(0x0d);
  });

  it('writes under ROM go to RAM', () => {
    const { bus } = makeBus();
    bus.write(0xa000, 0x42);
    expect(bus.read(0xa000)).toBe(0xba);
    expect(bus.ram[0xa000]).toBe(0x42);
  });

  it('banks ROMs out through the processor port', () => {
    const { bus } = makeBus();
    bus.write(0x0000, 0x2f);
    bus.write(0x0001, 0x36); // LORAM off: BASIC out
    expect(bus.read(0xa000)).toBe(0);
    expect(bus.read(0xe000)).toBe(0xce);
    bus.write(0x0001, 0x33); // CHAREN off: character ROM at $D000
    expect(bus.read(0xd000)).toBe(0xc6);
    bus.write(0x0001, 0x30); // all RAM
    expect(bus.read(0xd000)).toBe(0);
    expect(bus.read(0xe000)).toBe(0);
    expect(bus.read(0x0001) & 0x07).toBe(0);
  });

  it('mirrors VIC registers and stores 4-bit color RAM', () => {
    const { bus, writes } = makeBus();
    bus.write(0xd060, 0x1b);
    expect(writes).toEqual([['vic', 0x20, 0x1b]]);
    bus.write(0xd800, 0xfe);
    expect(bus.colorRam[0]).toBe(0x0e);
  });
});
