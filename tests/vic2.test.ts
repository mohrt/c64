import { describe, expect, it } from 'vitest';
import { PALETTE_ABGR } from '../src/vic/palette';
import { FRAME_WIDTH, Vic2 } from '../src/vic/vic2';
import { PAL } from '../src/vic/video-model';

const CYCLES_PER_FRAME = PAL.cyclesPerLine * PAL.linesPerFrame;

// Framebuffer position of the display window's top-left pixel (raster 51, sprite X 24).
const LEFT = 32;
const TOP = 36;
const SCREEN = 0x0400;
const CHARSET = 0x0800;
const BITMAP = 0x2000;

const BORDER = 14;
const BG0 = 6;
const BG1 = 1;
const BG2 = 2;
const BG3 = 3;

function makeVic() {
  const ram = new Uint8Array(0x4000);
  const colorRam = new Uint8Array(0x400);
  const vic = new Vic2({ read: (addr) => ram[addr], colorRam });
  vic.write(0x11, 0x1b);
  vic.write(0x16, 0x08);
  vic.write(0x18, 0x12); // screen $0400, characters $0800
  vic.write(0x20, BORDER);
  vic.write(0x21, BG0);
  vic.write(0x22, BG1);
  vic.write(0x23, BG2);
  vic.write(0x24, BG3);
  const frame = () => vic.tick(CYCLES_PER_FRAME);
  const pixel = (x: number, y: number) => {
    const value = vic.framebuffer[y * FRAME_WIDTH + x];
    return PALETTE_ABGR.indexOf(value);
  };
  return { vic, ram, colorRam, frame, pixel };
}

describe('Vic2 graphics modes', () => {
  it('draws standard text with the color RAM ink', () => {
    const { ram, colorRam, frame, pixel } = makeVic();
    ram[SCREEN] = 1;
    ram[CHARSET + 8] = 0x80;
    colorRam[0] = 7;
    frame();
    expect(pixel(LEFT, TOP)).toBe(7);
    expect(pixel(LEFT + 1, TOP)).toBe(BG0);
    expect(pixel(LEFT - 1, TOP)).toBe(BORDER);
    expect(pixel(LEFT, TOP - 1)).toBe(BORDER);
  });

  it('honors YSCROLL by moving the text rows down', () => {
    const { vic, ram, colorRam, frame, pixel } = makeVic();
    vic.write(0x11, 0x1c);
    ram[SCREEN] = 1;
    ram[CHARSET + 8] = 0x80;
    colorRam[0] = 7;
    frame();
    expect(pixel(LEFT, TOP)).toBe(BG0);
    expect(pixel(LEFT, TOP + 1)).toBe(7);
  });

  it('draws multicolor text in double-width pixels', () => {
    const { vic, ram, colorRam, frame, pixel } = makeVic();
    vic.write(0x16, 0x18);
    ram[SCREEN] = 1;
    ram[CHARSET + 8] = 0b01_10_11_00;
    colorRam[0] = 0x08 | 5;
    frame();
    expect([0, 2, 4, 6].map((dx) => pixel(LEFT + dx, TOP))).toEqual([BG1, BG2, 5, BG0]);
    expect(pixel(LEFT + 1, TOP)).toBe(BG1);
  });

  it('draws hires bitmaps with colors from screen memory', () => {
    const { vic, ram, frame, pixel } = makeVic();
    vic.write(0x11, 0x3b);
    vic.write(0x18, 0x18); // screen $0400, bitmap $2000
    ram[SCREEN] = 0x21;
    ram[BITMAP] = 0x80;
    frame();
    expect(pixel(LEFT, TOP)).toBe(2);
    expect(pixel(LEFT + 1, TOP)).toBe(1);
  });

  it('draws multicolor bitmaps', () => {
    const { vic, ram, colorRam, frame, pixel } = makeVic();
    vic.write(0x11, 0x3b);
    vic.write(0x16, 0x18);
    vic.write(0x18, 0x18);
    ram[SCREEN] = 0x23;
    colorRam[0] = 4;
    ram[BITMAP] = 0b00_01_10_11;
    frame();
    expect([0, 2, 4, 6].map((dx) => pixel(LEFT + dx, TOP))).toEqual([BG0, 2, 3, 4]);
  });

  it('picks the extended background color from the top bits of the code', () => {
    const { vic, ram, frame, pixel } = makeVic();
    vic.write(0x11, 0x5b);
    ram[SCREEN] = 0x81;
    frame();
    expect(pixel(LEFT, TOP)).toBe(BG2);
  });

  it('shows black for invalid mode combinations', () => {
    const { vic, ram, frame, pixel } = makeVic();
    vic.write(0x11, 0x7b);
    ram[SCREEN] = 0x21;
    ram[BITMAP] = 0xff;
    vic.write(0x18, 0x18);
    frame();
    expect(pixel(LEFT, TOP)).toBe(0);
  });

  it('fills the screen with border when the display is disabled', () => {
    const { vic, frame, pixel } = makeVic();
    vic.write(0x11, 0x0b);
    frame();
    frame();
    expect(pixel(200, 100)).toBe(BORDER);
  });
});

describe('Vic2 sprites', () => {
  function withSprite(setup?: (vic: Vic2, ram: Uint8Array) => void) {
    const env = makeVic();
    const { vic, ram } = env;
    vic.write(0x15, 0x01);
    vic.write(0x00, 24);
    vic.write(0x01, 50);
    vic.write(0x27, 10);
    ram[SCREEN + 0x3f8] = 0x80; // sprite data at $2000
    ram[0x2000] = 0xff;
    setup?.(vic, ram);
    env.frame();
    env.frame();
    return env;
  }

  it('draws a hires sprite at its coordinates', () => {
    const { pixel } = withSprite();
    expect(pixel(LEFT, TOP)).toBe(10);
    expect(pixel(LEFT + 7, TOP)).toBe(10);
    expect(pixel(LEFT + 8, TOP)).toBe(BG0);
    expect(pixel(LEFT, TOP + 1)).toBe(BG0);
  });

  it('expands sprites horizontally and vertically', () => {
    const { pixel } = withSprite((vic) => {
      vic.write(0x1d, 0x01);
      vic.write(0x17, 0x01);
    });
    expect(pixel(LEFT + 15, TOP)).toBe(10);
    expect(pixel(LEFT + 16, TOP)).toBe(BG0);
    expect(pixel(LEFT, TOP + 1)).toBe(10);
    expect(pixel(LEFT, TOP + 2)).toBe(BG0);
  });

  it('draws multicolor sprites from the shared and own colors', () => {
    const { pixel } = withSprite((vic, ram) => {
      vic.write(0x1c, 0x01);
      vic.write(0x25, 4);
      vic.write(0x26, 5);
      ram[0x2000] = 0b01_10_11_00;
    });
    expect([0, 2, 4, 6].map((dx) => pixel(LEFT + dx, TOP))).toEqual([4, 10, 5, BG0]);
  });

  it('hides behind-background sprites under foreground pixels only', () => {
    const { pixel } = withSprite((vic, ram) => {
      vic.write(0x1b, 0x01);
      ram[SCREEN] = 1;
      ram[CHARSET + 8] = 0xf0;
    });
    expect(pixel(LEFT, TOP)).toBe(0); // text ink (color RAM 0)
    expect(pixel(LEFT + 5, TOP)).toBe(10);
  });

  it('is covered by the border', () => {
    const { pixel } = withSprite((vic) => vic.write(0x00, 20));
    expect(pixel(LEFT - 2, TOP)).toBe(BORDER);
    expect(pixel(LEFT, TOP)).toBe(10);
  });

  it('detects sprite-sprite and sprite-background collisions', () => {
    const { vic } = withSprite((v, ram) => {
      v.write(0x15, 0x03);
      v.write(0x02, 28);
      v.write(0x03, 50);
      ram[SCREEN + 0x3f9] = 0x80;
      ram[SCREEN] = 1;
      ram[CHARSET + 8] = 0x80;
    });
    expect(vic.read(0x19) & 0x06).toBe(0x06);
    expect(vic.read(0x1e)).toBe(0x03);
    expect(vic.read(0x1e)).toBe(0x00);
    expect(vic.read(0x1f)).toBe(0x01);
  });
});

describe('Vic2 CPU stalls', () => {
  it('steals 40 cycles on each of the 25 badlines', () => {
    const { vic, frame } = makeVic();
    frame();
    vic.takeStalledCycles();
    frame();
    expect(vic.takeStalledCycles()).toBe(25 * 40);
  });

  it('steals cycles for sprite fetches', () => {
    const { vic, frame } = makeVic();
    vic.write(0x11, 0x0b); // no badlines
    vic.write(0x15, 0x01);
    vic.write(0x01, 100);
    frame();
    vic.takeStalledCycles();
    frame();
    expect(vic.takeStalledCycles()).toBe(21 * 2);
  });
});
