import { describe, expect, it } from 'vitest';
import { FRAME_WIDTH, Vic2 } from '../src/vic/vic2';
import { NTSC, PAL } from '../src/vic/video-model';
import { createMachine, hasSystemRoms, runFrames, screenText, typeText } from './helpers/machine';

/** The KERNAL stores 1 here on a PAL machine and 0 on NTSC, after checking for raster line 311. */
const PAL_NTSC_FLAG = 0x02a6;

function makeVic() {
  const vic = new Vic2({ read: () => 0, colorRam: new Uint8Array(0x400) });
  vic.setModel(NTSC);
  return vic;
}

describe('NTSC VIC-II', () => {
  it('runs 263 lines of 65 cycles', () => {
    const vic = makeVic();
    vic.tick(NTSC.cyclesPerLine * NTSC.linesPerFrame - 1);
    expect(vic.frameCount).toBe(0);
    expect(vic.rasterLine).toBe(262);
    vic.tick(1);
    expect(vic.frameCount).toBe(1);
    expect(vic.rasterLine).toBe(0);
  });

  it('never reaches raster line 311, so that interrupt never fires', () => {
    const vic = makeVic();
    vic.write(0x11, 0x80 | 0x1b);
    vic.write(0x12, 311 & 0xff);
    vic.write(0x1a, 0x01);
    vic.tick(NTSC.cyclesPerLine * NTSC.linesPerFrame * 2);
    expect(vic.irq).toBe(false);
  });

  it('draws a shorter picture, finished once its last line (raster 12) is drawn', () => {
    const vic = makeVic();
    let frames = 0;
    vic.onFrameComplete = (framebuffer) => {
      frames++;
      expect(framebuffer.length).toBe(FRAME_WIDTH * NTSC.visibleLines);
    };
    const lastVisibleLine = NTSC.firstVisibleLine + NTSC.visibleLines - 1 - NTSC.linesPerFrame;
    expect(lastVisibleLine).toBe(12);
    vic.tick(NTSC.cyclesPerLine * lastVisibleLine);
    expect(frames).toBe(0);
    vic.tick(NTSC.cyclesPerLine);
    expect(frames).toBe(1);
    vic.tick(NTSC.cyclesPerLine * NTSC.linesPerFrame);
    expect(frames).toBe(2);
  });
});

describe.skipIf(!hasSystemRoms)('NTSC C64', () => {
  it('is detected as NTSC by the KERNAL and runs BASIC', () => {
    const c64 = createMachine('system');
    c64.setModel(NTSC);
    runFrames(c64, 180);
    expect(c64.bus.read(PAL_NTSC_FLAG)).toBe(0);
    expect(screenText(c64)).toContain('READY.');

    typeText(c64, 'PRINT 6*7\n');
    runFrames(c64, 12);
    const lines = screenText(c64);
    expect(lines[lines.indexOf('PRINT 6*7') + 1].trim()).toBe('42');
  });

  it('is detected as PAL by default', () => {
    const c64 = createMachine('system');
    runFrames(c64, 150);
    expect(c64.bus.read(PAL_NTSC_FLAG)).toBe(1);
  });

  it('switches model when loading a save state from the other one', () => {
    const ntsc = createMachine('system');
    ntsc.setModel(NTSC);
    runFrames(ntsc, 180);
    const state = ntsc.saveState();

    const pal = createMachine('system');
    runFrames(pal, 150);
    pal.loadState(state);
    expect(pal.model).toBe(NTSC);
    runFrames(pal, 5);
    expect(pal.bus.read(PAL_NTSC_FLAG)).toBe(0);

    pal.loadState({ ...state, model: undefined });
    expect(pal.model).toBe(PAL);
  });
});
