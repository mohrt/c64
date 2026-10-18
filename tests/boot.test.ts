import { describe, expect, it } from 'vitest';
import { createMachine, hasOpenRoms, hasSystemRoms, runFrames, screenText, typeText } from './helpers/machine';

const BOOT_FRAMES = 150; // about 3 seconds of PAL time
const BLUE = 6;

describe.skipIf(!hasOpenRoms)('C64 boot', () => {
  it('boots to the READY prompt, blue on blue', () => {
    const c64 = createMachine();
    runFrames(c64, BOOT_FRAMES);

    expect(screenText(c64)).toContain('READY.');
    expect(c64.bus.read(0xd020) & 0x0f).toBe(BLUE);
    expect(c64.bus.read(0xd021) & 0x0f).toBe(BLUE);
  });

  it('blinks the cursor from the CIA1 timer interrupt', () => {
    const c64 = createMachine();
    runFrames(c64, BOOT_FRAMES);

    // The banner logo also uses reverse video, so look for one cell toggling.
    const reversedCells = () => c64.bus.ram.subarray(0x0400, 0x07e8).filter((code) => code & 0x80).length;
    const samples = new Set<number>();
    for (let i = 0; i < 10; i++) {
      runFrames(c64, 10);
      samples.add(reversedCells());
    }
    const [low, high] = [...samples].sort((a, b) => a - b);
    expect(samples.size).toBe(2);
    expect(high - low).toBe(1);
  });

  // Open ROMs BASIC does not evaluate numeric expressions yet, so these stick to strings and SYS.
  it('runs BASIC typed on the keyboard', () => {
    const c64 = createMachine();
    runFrames(c64, BOOT_FRAMES);

    typeText(c64, 'PRINT "HELLO"\n');
    runFrames(c64, 10);

    const lines = screenText(c64);
    const commandRow = lines.indexOf('PRINT "HELLO"');
    expect(commandRow).toBeGreaterThanOrEqual(0);
    expect(lines[commandRow + 1]).toBe('HELLO');
  });

  it('calls machine code with SYS', () => {
    const c64 = createMachine();
    runFrames(c64, BOOT_FRAMES);
    c64.bus.ram.set([0xee, 0x20, 0xd0, 0x60], 0xc000); // INC $D020; RTS

    typeText(c64, 'SYS 49152\n');
    runFrames(c64, 10);

    expect(c64.bus.read(0xd020) & 0x0f).toBe(BLUE + 1);
  });
});

describe.skipIf(!hasSystemRoms)('C64 boot with the system ROMs', () => {
  it('boots to READY and evaluates BASIC expressions', () => {
    const c64 = createMachine('system');
    runFrames(c64, BOOT_FRAMES);

    expect(screenText(c64)).toContain('READY.');

    typeText(c64, 'PRINT 2+2\n');
    runFrames(c64, 10);
    const after = screenText(c64);
    expect(after[after.indexOf('PRINT 2+2') + 1].trim()).toBe('4');
  });
});
