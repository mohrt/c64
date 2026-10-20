import { describe, expect, it } from 'vitest';
import {
  SystemRomStore,
  hasRequiredRoms,
  identifyRom,
  machineRoms,
  type StoredRom,
} from '../src/roms/system-roms';
import { MemoryStore } from '../src/storage/store';

const bytes = (size: number, fill = 0) => new Uint8Array(size).fill(fill);

function withBasicSignature(data: Uint8Array): Uint8Array {
  [...'CBMBASIC'].forEach((char, i) => (data[4 + i] = char.charCodeAt(0)));
  return data;
}

describe('identifyRom', () => {
  it('tells the ROMs apart by size, flagging ones that are not original Commodore chips', () => {
    expect(identifyRom('chargen', bytes(0x1000))).toMatchObject({ kind: 'chargen', warning: expect.any(String) });
    expect(identifyRom('dos1541', bytes(0x4000)).kind).toBe('drive');
  });

  it('tells BASIC from KERNAL by the CBMBASIC signature or the file name', () => {
    expect(identifyRom('rom-a.bin', withBasicSignature(bytes(0x2000))).kind).toBe('basic');
    expect(identifyRom('basic-901226-01.bin', bytes(0x2000)).kind).toBe('basic');
    expect(identifyRom('C64/kernal.901227-03.bin', bytes(0x2000)).kind).toBe('kernal');
  });

  it('rejects 8K files it cannot place, half 1541 ROMs and wrong sizes', () => {
    expect(() => identifyRom('mystery.bin', bytes(0x2000))).toThrow(/BASIC or the KERNAL/);
    expect(() => identifyRom('1541-e000.bin', bytes(0x2000))).toThrow(/half of a 1541/);
    expect(() => identifyRom('game.prg', bytes(1234))).toThrow(/1,234 bytes/);
  });
});

describe('SystemRomStore', () => {
  it('keeps ROMs between page loads and forgets them on request', async () => {
    const backing = new MemoryStore<StoredRom>();
    const store = new SystemRomStore(backing);
    await store.save('basic', { name: 'basic', data: bytes(0x2000, 1) });
    await store.save('kernal', { name: 'kernal', data: bytes(0x2000, 2) });
    expect(hasRequiredRoms(await store.load())).toBe(false);

    await store.save('chargen', { name: 'chargen', data: bytes(0x1000, 3) });
    const reloaded = await new SystemRomStore(backing).load();
    expect(hasRequiredRoms(reloaded)).toBe(true);
    expect(machineRoms(reloaded).kernal[0]).toBe(2);

    await store.forget();
    expect(await store.load()).toEqual({});
  });

  it('ignores stored entries of the wrong size', async () => {
    const backing = new MemoryStore<StoredRom>();
    await backing.put('kernal', { name: 'kernal', data: bytes(100) });
    expect(await new SystemRomStore(backing).load()).toEqual({});
  });
});
