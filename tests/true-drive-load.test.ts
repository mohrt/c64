import { describe, expect, it } from 'vitest';
import { D64Image } from '../src/disk/d64';
import { PrgMedia } from '../src/disk/prg-media';
import type { DiskMedia } from '../src/disk/media';
import { NTSC } from '../src/vic/video-model';
import { buildD64, prg } from './helpers/d64-builder';
import {
  createMachine,
  hasDriveRom,
  hasOpenRoms,
  hasSystemRoms,
  runFrames,
  screenText,
  typeText,
  type RomSetName,
} from './helpers/machine';

const BOOT_FRAMES = 150;
const MAX_LOAD_FRAMES = 50 * 30;

// 10 PRINT "HI"
const helloBasic = prg(0x0801, [0x0b, 0x08, 0x0a, 0x00, 0x99, 0x20, 0x22, 0x48, 0x49, 0x22, 0x00, 0x00, 0x00]);
const incBorder = [0xee, 0x20, 0xd0, 0x60]; // INC $D020; RTS
const testDisk = () =>
  new D64Image(
    buildD64('TEST DISK', 'TD 2A', [
      { name: 'HELLO', data: helloBasic },
      { name: 'CODE', data: prg(0xc000, incBorder) },
    ]),
  );

function boot(romSet: RomSetName, media: DiskMedia) {
  const c64 = createMachine(romSet, { accurateDrive: true });
  expect(c64.driveMode).toBe('accurate');
  c64.insertDisk(media);
  runFrames(c64, BOOT_FRAMES);
  return c64;
}

/** Types a command and waits for the READY prompt that follows it. */
function command(c64: ReturnType<typeof createMachine>, text: string) {
  typeText(c64, `${text}\n`);
  const lines = () => screenText(c64);
  const done = () => {
    const all = lines();
    const at = all.lastIndexOf(text);
    return at >= 0 && all.slice(at + 1).includes('READY.');
  };
  for (let frames = 0; frames < MAX_LOAD_FRAMES && !done(); frames += 25) runFrames(c64, 25);
  return lines();
}

describe.skipIf(!hasSystemRoms || !hasDriveRom)('loading through the true 1541 (system ROMs)', () => {
  it('lists the directory produced by the real DOS', () => {
    const c64 = boot('system', testDisk());
    command(c64, 'LOAD"$",8');
    const listing = command(c64, 'LIST').join('\n');
    expect(listing).toContain('"TEST DISK       " TD 2A');
    expect(listing).toContain('"HELLO"');
    expect(listing).toContain('"CODE"');
    expect(listing).toMatch(/66\d BLOCKS FREE\./);
    expect(c64.driveLed).toBe(false);
  }, 60_000);

  it('loads machine code with ,8,1 and runs it with SYS', () => {
    const c64 = boot('system', testDisk());
    command(c64, 'LOAD"CODE",8,1');
    expect([...c64.bus.ram.subarray(0xc000, 0xc004)]).toEqual(incBorder);
    const border = c64.bus.read(0xd020) & 0x0f;
    command(c64, 'SYS 49152');
    expect(c64.bus.read(0xd020) & 0x0f).toBe((border + 1) & 0x0f);
  }, 60_000);

  it('loads and runs a BASIC program', () => {
    const c64 = boot('system', testDisk());
    command(c64, 'LOAD"HELLO",8');
    const lines = command(c64, 'RUN');
    expect(lines[lines.lastIndexOf('RUN') + 1]).toBe('HI');
  }, 60_000);

  it('reports a missing file through the real DOS', () => {
    const c64 = boot('system', testDisk());
    const lines = command(c64, 'LOAD"NOPE",8');
    expect(lines.join('\n')).toMatch(/FILE NOT FOUND/);
  }, 60_000);

  it('loads on an NTSC C64, whose faster clock the drive keeps in step with', () => {
    const c64 = createMachine('system', { accurateDrive: true });
    c64.setModel(NTSC);
    c64.insertDisk(testDisk());
    runFrames(c64, BOOT_FRAMES);
    command(c64, 'LOAD"$",8');
    expect(command(c64, 'LIST').join('\n')).toContain('"TEST DISK       " TD 2A');
    command(c64, 'LOAD"CODE",8,1');
    expect([...c64.bus.ram.subarray(0xc000, 0xc004)]).toEqual(incBorder);
  }, 60_000);

  it('puts a dropped .prg on a disk so the real drive can load it', () => {
    const c64 = boot('system', new PrgMedia('code.prg', prg(0xc000, incBorder)));
    command(c64, 'LOAD"CODE",8,1');
    expect([...c64.bus.ram.subarray(0xc000, 0xc004)]).toEqual(incBorder);
  }, 60_000);
});

describe.skipIf(!hasDriveRom || !hasOpenRoms)('loading through the true 1541 (Open ROMs)', () => {
  it('loads with the Open ROMs KERNAL, which drives the serial bus itself', () => {
    const c64 = boot('open', testDisk());
    command(c64, 'LOAD"CODE",8,1');
    expect([...c64.bus.ram.subarray(0xc000, 0xc004)]).toEqual(incBorder);
  }, 60_000);
});
