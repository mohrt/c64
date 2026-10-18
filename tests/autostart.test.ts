import { describe, expect, it } from 'vitest';
import { Autostart, atReadyPrompt } from '../src/autostart';
import { D64Image } from '../src/disk/d64';
import { buildD64, prg } from './helpers/d64-builder';
import { createMachine, hasDriveRom, hasSystemRoms, runFrames, screenText } from './helpers/machine';

// 10 PRINT "HI"
const helloBasic = prg(0x0801, [0x0b, 0x08, 0x0a, 0x00, 0x99, 0x20, 0x22, 0x48, 0x49, 0x22, 0x00, 0x00, 0x00]);
const disk = () => new D64Image(buildD64('AUTO', 'AU 2A', [{ name: 'HELLO', data: helloBasic }]));

function runAutostart(accurateDrive: boolean) {
  const c64 = createMachine('system', { accurateDrive });
  runFrames(c64, 150);
  expect(atReadyPrompt(c64)).toBe(true);
  c64.insertDisk(disk());
  const autostart = new Autostart(c64);
  autostart.start();
  for (let frame = 0; frame < 50 * 60 && autostart.active; frame++) {
    runFrames(c64, 1);
    autostart.tick();
  }
  runFrames(c64, 25);
  return { c64, autostart };
}

describe.skipIf(!hasSystemRoms)('Autostart', () => {
  it('is not at the READY prompt while booting', () => {
    const c64 = createMachine('system');
    runFrames(c64, 5);
    expect(atReadyPrompt(c64)).toBe(false);
  });

  it('loads and runs the first program on the fast drive', () => {
    const { c64, autostart } = runAutostart(false);
    expect(autostart.active).toBe(false);
    const lines = screenText(c64);
    expect(lines).toContain('LOAD"*",8,1');
    expect(lines[lines.lastIndexOf('RUN') + 1]).toBe('HI');
  });

  it.skipIf(!hasDriveRom)('loads and runs the first program on the true 1541', () => {
    const { c64 } = runAutostart(true);
    const lines = screenText(c64);
    expect(lines[lines.lastIndexOf('RUN') + 1]).toBe('HI');
  }, 60_000);

  it('does not type RUN when the program starts itself', () => {
    // Loads over BASIC's main-loop vector at $0302, so BASIC jumps into it after LOAD.
    // Vector -> $0304: LDA #1; STA $D020; JMP $0309
    const selfStarting = prg(0x0302, [0x04, 0x03, 0xa9, 0x01, 0x8d, 0x20, 0xd0, 0x4c, 0x09, 0x03]);
    const c64 = createMachine('system');
    runFrames(c64, 150);
    c64.insertDisk(new D64Image(buildD64('AUTO', 'AU 2A', [{ name: 'BOOT', data: selfStarting }])));
    const autostart = new Autostart(c64);
    autostart.start();
    for (let frame = 0; frame < 300; frame++) {
      runFrames(c64, 1);
      autostart.tick();
    }
    expect(c64.bus.read(0xd020) & 0x0f).toBe(1);
    expect(screenText(c64)).not.toContain('RUN');
    autostart.cancel();
  });
});
