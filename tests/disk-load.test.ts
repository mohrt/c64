import { describe, expect, it } from 'vitest';
import { D64Image } from '../src/disk/d64';
import { buildD64, prg } from './helpers/d64-builder';
import {
  createMachine,
  hasSystemRoms,
  runFrames,
  screenText,
  typeText,
  type RomSetName,
} from './helpers/machine';

const BOOT_FRAMES = 150;
const SETTLE_FRAMES = 60;

// 10 PRINT "HI"
const helloBasic = prg(0x0801, [0x0b, 0x08, 0x0a, 0x00, 0x99, 0x20, 0x22, 0x48, 0x49, 0x22, 0x00, 0x00, 0x00]);
const incBorder = [0xee, 0x20, 0xd0, 0x60]; // INC $D020; RTS
const machineCode = prg(0xc000, incBorder);

function bootWithDisk(romSet: RomSetName) {
  const c64 = createMachine(romSet);
  c64.insertDisk(
    new D64Image(
      buildD64('TEST DISK', 'TD 2A', [
        { name: 'HELLO', data: helloBasic },
        { name: 'CODE', data: machineCode },
      ]),
    ),
  );
  runFrames(c64, BOOT_FRAMES);
  return c64;
}

function command(c64: ReturnType<typeof createMachine>, text: string) {
  typeText(c64, `${text}\n`);
  runFrames(c64, SETTLE_FRAMES);
  return screenText(c64);
}

// Open ROMs sends secondary addresses through internal routines that bypass the
// trapped KERNAL entry points, so the virtual drive only works with the system ROMs.
const romSet: RomSetName = 'system';

describe.skipIf(!hasSystemRoms)('loading from the virtual drive (system ROMs)', () => {
  it('lists the directory with LOAD"$",8', () => {
    const c64 = bootWithDisk(romSet);
    command(c64, 'LOAD"$",8');
    const lines = command(c64, 'LIST');
    const listing = lines.join('\n');
    expect(listing).toContain('"TEST DISK       " TD 2A');
    expect(listing).toContain('"HELLO"');
    expect(listing).toContain('"CODE"');
    expect(listing).toContain('BLOCKS FREE.');
  });

  it('loads machine code to its own address with ,8,1 and runs it with SYS', () => {
    const c64 = bootWithDisk(romSet);
    command(c64, 'LOAD"CODE",8,1');
    expect([...c64.bus.ram.subarray(0xc000, 0xc004)]).toEqual(incBorder);

    const border = c64.bus.read(0xd020) & 0x0f;
    command(c64, 'SYS 49152');
    expect(c64.bus.read(0xd020) & 0x0f).toBe((border + 1) & 0x0f);
  });

  it('loads and runs a BASIC program', () => {
    const c64 = bootWithDisk(romSet);
    command(c64, 'LOAD"HELLO",8');
    const lines = command(c64, 'RUN');
    expect(lines[lines.lastIndexOf('RUN') + 1]).toBe('HI');
  });

  it('reports a missing file', () => {
    const c64 = bootWithDisk(romSet);
    const lines = command(c64, 'LOAD"NOPE",8');
    expect(lines.join('\n')).toMatch(/FILE NOT FOUND/);
  });
});
