import { describe, expect, it } from 'vitest';
import type { C64 } from '../src/c64';
import { D64Image } from '../src/disk/d64';
import { decodeState, encodeState } from '../src/state/snapshot';
import { buildD64, prg } from './helpers/d64-builder';
import { createMachine, hasDriveRom, hasSystemRoms, runFrames, screenText, typeText } from './helpers/machine';

/** Everything visible about a machine: RAM, CPU registers, raster, and the picture. */
function fingerprint(c64: C64): string {
  let hash = 0;
  const mix = (value: number) => (hash = (Math.imul(hash, 31) + value) | 0);
  c64.bus.ram.forEach(mix);
  c64.vic.framebuffer.forEach(mix);
  [c64.cpu.pc, c64.cpu.a, c64.cpu.x, c64.cpu.y, c64.cpu.sp, c64.cpu.status, c64.vic.rasterLine, c64.clock].forEach(mix);
  return `${hash}:${c64.cpu.pc.toString(16)}:${c64.clock}`;
}

// 10 POKE 53280,PEEK(53280)+1:GOTO 10, so the machine keeps changing.
const BORDER_LOOP = '10 POKE53280,PEEK(53280)+1:GOTO10';

describe.skipIf(!hasSystemRoms)('save states', () => {
  it('a restored machine continues exactly like the original', () => {
    const original = createMachine('system');
    runFrames(original, 150);
    typeText(original, `${BORDER_LOOP}\nRUN\n`);
    runFrames(original, 20);

    const state = original.saveState();
    runFrames(original, 30);

    const restored = createMachine('system');
    restored.loadState(state);
    runFrames(restored, 30);
    expect(fingerprint(restored)).toBe(fingerprint(original));
  });

  it('survives encoding to a file', async () => {
    const original = createMachine('system');
    runFrames(original, 150);
    typeText(original, `${BORDER_LOOP}\nRUN\n`);
    runFrames(original, 10);

    const encoded = await encodeState(original.saveState());
    expect(encoded.length).toBeLessThan(400_000);
    const decoded = await decodeState<ReturnType<C64['saveState']>>(encoded);
    runFrames(original, 25);

    const restored = createMachine('system');
    restored.loadState(decoded);
    runFrames(restored, 25);
    expect(fingerprint(restored)).toBe(fingerprint(original));
  });

  it.skipIf(!hasDriveRom)('restores mid-load on the true 1541, disk and all', () => {
    const disk = buildD64('STATE', 'ST 2A', [
      { name: 'BIG', data: prg(0x2000, Array.from({ length: 6000 }, (_, i) => i & 0xff)) },
    ]);
    const original = createMachine('system', { accurateDrive: true });
    original.insertDisk(new D64Image(disk));
    runFrames(original, 150);
    typeText(original, 'LOAD"BIG",8,1\n');
    runFrames(original, 100); // part-way through the load

    const state = original.saveState();
    runFrames(original, 1500); // a standard KERNAL load from a 1541 takes a while

    const restored = createMachine('system', { accurateDrive: true });
    restored.loadState(state);
    runFrames(restored, 1500);
    expect(fingerprint(restored)).toBe(fingerprint(original));
    expect(restored.bus.ram[0x2000 + 5999]).toBe(5999 & 0xff);
    expect(screenText(restored).filter((line) => line === 'READY.').length).toBe(2);
  }, 60_000);

  it('refuses a state that needs a cartridge which is not plugged in', () => {
    const c64 = createMachine('system');
    const state = { ...c64.saveState(), cartridgeName: 'SOME GAME' };
    expect(() => c64.loadState(state)).toThrow(/SOME GAME/);
  });
});
