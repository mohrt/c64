import type { IoDevice } from '../memory/bus';
import { PALETTE_ABGR } from './palette';
import { PAL, type VideoModel } from './video-model';

export const FRAME_WIDTH = 384;

/** Framebuffer x of the 40-column display window's left edge (32 pixels of side border). */
const DISPLAY_LEFT = 32;
const DISPLAY_WIDTH = 320;
const COLUMNS = 40;
/** Sprite X coordinate 24 is the left edge of the display window. */
const SPRITE_X_OFFSET = DISPLAY_LEFT - 24;
const SPRITE_ROWS = 21;
const SPRITE_COUNT = 8;
const SPRITE_POINTERS = 0x3f8;

const FIRST_BADLINE = 0x30;
const LAST_BADLINE = 0xf7;
/** Cycles the CPU loses on a badline while the VIC fetches 40 character pointers. */
const BADLINE_STALL = 40;
/** Cycles the CPU loses per sprite whose data is fetched on a line. */
const SPRITE_DMA_STALL = 2;
/** Address read in idle state (ECM forces bits 9 and 10 low). */
const IDLE_ADDRESS = 0x3fff;
const IDLE_ADDRESS_ECM = 0x39ff;

const REG_SPRITE_X_MSB = 0x10;
const REG_CONTROL1 = 0x11;
const REG_RASTER = 0x12;
const REG_LIGHTPEN_X = 0x13;
const REG_LIGHTPEN_Y = 0x14;
const REG_SPRITE_ENABLE = 0x15;
const REG_CONTROL2 = 0x16;
const REG_SPRITE_EXPAND_Y = 0x17;
const REG_MEMORY = 0x18;
const REG_IRQ_FLAGS = 0x19;
const REG_IRQ_MASK = 0x1a;
const REG_SPRITE_PRIORITY = 0x1b;
const REG_SPRITE_MULTICOLOR = 0x1c;
const REG_SPRITE_EXPAND_X = 0x1d;
const REG_SPRITE_SPRITE_COLLISION = 0x1e;
const REG_SPRITE_DATA_COLLISION = 0x1f;
const REG_BORDER = 0x20;
const REG_BACKGROUND0 = 0x21;
const REG_SPRITE_MULTICOLOR0 = 0x25;
const REG_SPRITE_MULTICOLOR1 = 0x26;
const REG_SPRITE_COLOR0 = 0x27;
const REG_LAST_COLOR = 0x2e;

const CONTROL1_RASTER_BIT8 = 0x80;
const CONTROL1_ECM = 0x40;
const CONTROL1_BMM = 0x20;
const CONTROL1_DEN = 0x10;
const CONTROL1_RSEL = 0x08;
const CONTROL2_MCM = 0x10;
const CONTROL2_CSEL = 0x08;

const IRQ_RASTER = 0x01;
const IRQ_SPRITE_DATA = 0x02;
const IRQ_SPRITE_SPRITE = 0x04;

const BLACK = 0;

export interface VicMemory {
  /** Reads from the VIC's current 16K bank (character ROM appears in banks 0 and 2). */
  read(addr14: number): number;
  readonly colorRam: Uint8Array;
}

/**
 * The VIC-II (6569 PAL or 6567R8 NTSC), emulated a raster line at a time. Implements the
 * display/idle state machine with its row counters, all graphics modes,
 * sprites with priorities and collisions, the vertical border flip-flop, the
 * raster interrupt, and the CPU stalls caused by badlines and sprite fetches.
 * Register changes take effect at line granularity.
 */
export class Vic2 implements IoDevice {
  /** FRAME_WIDTH x `model.visibleLines` pixels. */
  framebuffer = new Uint32Array(FRAME_WIDTH * PAL.visibleLines);
  /** Counts passes through raster line 0. */
  frameCount = 0;
  /** Called when the last visible line of a picture has been drawn. */
  onFrameComplete: ((framebuffer: Uint32Array) => void) | null = null;
  private videoModel = PAL;

  private readonly registers = new Uint8Array(0x40);
  private raster = 0;
  private lineCycle = 0;
  private rasterCompare = 0;
  private irqFlags = 0;
  private irqMask = 0;
  private stalledCycles = 0;

  // Text/bitmap sequencer state
  private badlinesEnabled = false;
  private isBadline = false;
  private displayState = false;
  private vcBase = 0;
  private rowCounter = 0;
  private verticalBorder = true;
  private readonly lineCodes = new Uint8Array(COLUMNS);
  private readonly lineColors = new Uint8Array(COLUMNS);

  // Sprite state
  private readonly spriteDma = new Uint8Array(SPRITE_COUNT);
  /** Lines of the sprite shown so far (each row shows on two lines when Y-expanded). */
  private readonly spriteLine = new Uint8Array(SPRITE_COUNT);
  private spriteSpriteCollision = 0;
  private spriteDataCollision = 0;

  // Per-line work buffers
  private readonly pixelColor = new Uint8Array(FRAME_WIDTH);
  private readonly isForeground = new Uint8Array(FRAME_WIDTH);
  private readonly spriteMask = new Uint8Array(FRAME_WIDTH);
  private readonly spriteColor = new Uint8Array(FRAME_WIDTH);
  private readonly spriteOwner = new Uint8Array(FRAME_WIDTH);

  constructor(private readonly memory: VicMemory) {}

  get model(): VideoModel {
    return this.videoModel;
  }

  /** Swaps the chip for the PAL or NTSC version (the picture changes size) and resets it. */
  setModel(model: VideoModel): void {
    this.videoModel = model;
    this.framebuffer = new Uint32Array(FRAME_WIDTH * model.visibleLines);
    this.reset();
  }

  reset(): void {
    this.registers.fill(0);
    this.raster = 0;
    this.lineCycle = 0;
    this.rasterCompare = 0;
    this.irqFlags = 0;
    this.irqMask = 0;
    this.stalledCycles = 0;
    this.badlinesEnabled = false;
    this.isBadline = false;
    this.displayState = false;
    this.vcBase = 0;
    this.rowCounter = 0;
    this.verticalBorder = true;
    this.spriteDma.fill(0);
    this.spriteLine.fill(0);
    this.spriteSpriteCollision = 0;
    this.spriteDataCollision = 0;
  }

  get irq(): boolean {
    return (this.irqFlags & this.irqMask) !== 0;
  }

  get rasterLine(): number {
    return this.raster;
  }

  tick(cycles: number): void {
    this.lineCycle += cycles;
    const cyclesPerLine = this.videoModel.cyclesPerLine;
    while (this.lineCycle >= cyclesPerLine) {
      this.lineCycle -= cyclesPerLine;
      this.finishLine();
    }
  }

  /** Cycles the CPU must wait since the last call (badlines and sprite fetches). */
  takeStalledCycles(): number {
    const cycles = this.stalledCycles;
    this.stalledCycles = 0;
    return cycles;
  }

  read(register: number): number {
    switch (register) {
      case REG_CONTROL1:
        return (this.registers[REG_CONTROL1] & 0x7f) | ((this.raster & 0x100) >> 1);
      case REG_RASTER:
        return this.raster & 0xff;
      case REG_LIGHTPEN_X:
      case REG_LIGHTPEN_Y:
        return 0;
      case REG_CONTROL2:
        return this.registers[REG_CONTROL2] | 0xc0;
      case REG_MEMORY:
        return this.registers[REG_MEMORY] | 0x01;
      case REG_IRQ_FLAGS:
        return this.irqFlags | 0x70 | (this.irq ? 0x80 : 0);
      case REG_IRQ_MASK:
        return this.irqMask | 0xf0;
      case REG_SPRITE_SPRITE_COLLISION: {
        const value = this.spriteSpriteCollision;
        this.spriteSpriteCollision = 0;
        return value;
      }
      case REG_SPRITE_DATA_COLLISION: {
        const value = this.spriteDataCollision;
        this.spriteDataCollision = 0;
        return value;
      }
      default:
        if (register >= REG_BORDER && register <= REG_LAST_COLOR) {
          return this.registers[register] | 0xf0;
        }
        return register > REG_LAST_COLOR ? 0xff : this.registers[register];
    }
  }

  write(register: number, value: number): void {
    switch (register) {
      case REG_CONTROL1:
        this.registers[register] = value;
        this.setRasterCompare((this.rasterCompare & 0xff) | ((value & CONTROL1_RASTER_BIT8) << 1));
        break;
      case REG_RASTER:
        this.setRasterCompare((this.rasterCompare & 0x100) | value);
        break;
      case REG_IRQ_FLAGS:
        this.irqFlags &= ~value & 0x0f;
        break;
      case REG_IRQ_MASK:
        this.irqMask = value & 0x0f;
        break;
      case REG_SPRITE_SPRITE_COLLISION:
      case REG_SPRITE_DATA_COLLISION:
        break;
      default:
        if (register <= REG_LAST_COLOR) this.registers[register] = value;
    }
  }

  private setRasterCompare(line: number): void {
    const changed = line !== this.rasterCompare;
    this.rasterCompare = line;
    if (changed && line === this.raster) this.irqFlags |= IRQ_RASTER;
  }

  // --- Line sequencing ----------------------------------------------------------

  private finishLine(): void {
    const line = this.raster;
    this.renderLine(line);
    this.advanceSprites(line);
    this.advanceRowCounters();

    this.raster++;
    if (this.raster === this.videoModel.linesPerFrame) {
      this.raster = 0;
      this.frameCount++;
    }
    if (this.raster === this.rasterCompare) this.irqFlags |= IRQ_RASTER;
    this.beginLine(this.raster);
  }

  private beginLine(line: number): void {
    const control1 = this.registers[REG_CONTROL1];
    if (line === 0) this.vcBase = 0;
    if (line === FIRST_BADLINE) this.badlinesEnabled = (control1 & CONTROL1_DEN) !== 0;

    const rows25 = (control1 & CONTROL1_RSEL) !== 0;
    if (line === (rows25 ? 251 : 247)) this.verticalBorder = true;
    else if (line === (rows25 ? 51 : 55) && control1 & CONTROL1_DEN) this.verticalBorder = false;

    this.isBadline =
      this.badlinesEnabled && line >= FIRST_BADLINE && line <= LAST_BADLINE && (line & 0x07) === (control1 & 0x07);
    if (this.isBadline) {
      this.displayState = true;
      this.rowCounter = 0;
      this.fetchCharacterPointers();
      this.stalledCycles += BADLINE_STALL;
    }

    for (let sprite = 0; sprite < SPRITE_COUNT; sprite++) {
      if (this.spriteDma[sprite]) this.stalledCycles += SPRITE_DMA_STALL;
    }
  }

  /** Cycle 58 of each line: the row counter steps, and after 8 rows the next text row begins. */
  private advanceRowCounters(): void {
    const vc = this.displayState ? this.vcBase + COLUMNS : this.vcBase;
    if (this.rowCounter === 7) {
      this.vcBase = vc & 0x3ff;
      this.displayState = false;
    }
    if (this.isBadline) this.displayState = true;
    if (this.displayState) this.rowCounter = (this.rowCounter + 1) & 0x07;
  }

  private fetchCharacterPointers(): void {
    const screenBase = ((this.registers[REG_MEMORY] >> 4) & 0x0f) << 10;
    for (let col = 0; col < COLUMNS; col++) {
      const vc = (this.vcBase + col) & 0x3ff;
      this.lineCodes[col] = this.memory.read(screenBase | vc);
      this.lineColors[col] = this.memory.colorRam[vc] & 0x0f;
    }
  }

  private advanceSprites(line: number): void {
    const regs = this.registers;
    for (let sprite = 0; sprite < SPRITE_COUNT; sprite++) {
      const bit = 1 << sprite;
      if (this.spriteDma[sprite]) {
        this.spriteLine[sprite]++;
        const rows = regs[REG_SPRITE_EXPAND_Y] & bit ? SPRITE_ROWS * 2 : SPRITE_ROWS;
        if (this.spriteLine[sprite] >= rows) this.spriteDma[sprite] = 0;
      }
      // A sprite starts on the line after its Y coordinate matches the raster.
      if (!this.spriteDma[sprite] && regs[REG_SPRITE_ENABLE] & bit && regs[sprite * 2 + 1] === (line & 0xff)) {
        this.spriteDma[sprite] = 1;
        this.spriteLine[sprite] = 0;
      }
    }
  }

  // --- Rendering -------------------------------------------------------------------

  private renderLine(line: number): void {
    const { firstVisibleLine, linesPerFrame, visibleLines } = this.videoModel;
    const y = (line - firstVisibleLine + linesPerFrame) % linesPerFrame;
    if (y >= visibleLines) return;

    const regs = this.registers;
    this.pixelColor.fill(regs[REG_BACKGROUND0] & 0x0f);
    this.isForeground.fill(0);
    if (!this.verticalBorder) this.renderGraphics();
    this.renderSprites();

    const borderColor = regs[REG_BORDER] & 0x0f;
    if (this.verticalBorder) {
      this.pixelColor.fill(borderColor);
    } else {
      const cols40 = (regs[REG_CONTROL2] & CONTROL2_CSEL) !== 0;
      const left = cols40 ? DISPLAY_LEFT : DISPLAY_LEFT + 7;
      const right = cols40 ? DISPLAY_LEFT + DISPLAY_WIDTH : DISPLAY_LEFT + DISPLAY_WIDTH - 9;
      this.pixelColor.fill(borderColor, 0, left);
      this.pixelColor.fill(borderColor, right);
    }

    const fb = this.framebuffer;
    const rowStart = y * FRAME_WIDTH;
    const colors = this.pixelColor;
    for (let x = 0; x < FRAME_WIDTH; x++) fb[rowStart + x] = PALETTE_ABGR[colors[x]];
    if (y === visibleLines - 1) this.onFrameComplete?.(fb);
  }

  /** Draws the 40 columns of text or bitmap graphics for the current line. */
  private renderGraphics(): void {
    const regs = this.registers;
    const control1 = regs[REG_CONTROL1];
    const control2 = regs[REG_CONTROL2];
    const ecm = (control1 & CONTROL1_ECM) !== 0;
    const bitmap = (control1 & CONTROL1_BMM) !== 0;
    const multicolor = (control2 & CONTROL2_MCM) !== 0;
    const invalid = ecm && (bitmap || multicolor);

    const memoryPointers = regs[REG_MEMORY];
    const charBase = ((memoryPointers >> 1) & 0x07) << 11;
    const bitmapBase = (memoryPointers & 0x08) << 10;
    const background = [
      regs[REG_BACKGROUND0] & 0x0f,
      regs[REG_BACKGROUND0 + 1] & 0x0f,
      regs[REG_BACKGROUND0 + 2] & 0x0f,
      regs[REG_BACKGROUND0 + 3] & 0x0f,
    ];
    const display = this.displayState;
    const rc = this.rowCounter;
    const colors = this.pixelColor;
    const foreground = this.isForeground;
    const end = DISPLAY_LEFT + DISPLAY_WIDTH;

    let x = DISPLAY_LEFT + (control2 & 0x07);
    for (let col = 0; col < COLUMNS; col++, x += 8) {
      const code = display ? this.lineCodes[col] : 0;
      const color = display ? this.lineColors[col] : 0;
      let address: number;
      if (!display) address = ecm ? IDLE_ADDRESS_ECM : IDLE_ADDRESS;
      else if (bitmap) address = bitmapBase | (((this.vcBase + col) & 0x3ff) << 3) | rc;
      else address = charBase | ((ecm ? code & 0x3f : code) << 3) | rc;
      const bits = this.memory.read(address & 0x3fff);

      if (multicolor && (bitmap || color & 0x08)) {
        // Two-bit pixels, each two pixels wide. Pairs %10 and %11 count as foreground.
        const pairColors = bitmap
          ? [background[0], code >> 4, code & 0x0f, color]
          : [background[0], background[1], background[2], color & 0x07];
        for (let shift = 6; shift >= 0; shift -= 2) {
          const pair = (bits >> shift) & 0x03;
          const value = invalid ? BLACK : pairColors[pair];
          for (let half = 0; half < 2; half++) {
            const px = x + (6 - shift) + half;
            if (px >= end) continue;
            colors[px] = value;
            foreground[px] = pair >= 2 ? 1 : 0;
          }
        }
        continue;
      }

      let ink: number;
      let paper: number;
      if (bitmap) {
        ink = code >> 4;
        paper = code & 0x0f;
      } else if (ecm) {
        ink = color;
        paper = background[code >> 6];
      } else {
        ink = multicolor ? color & 0x07 : color;
        paper = background[0];
      }
      if (invalid) ink = paper = BLACK;
      for (let bit = 0; bit < 8; bit++) {
        const px = x + bit;
        if (px >= end) break;
        const set = (bits << bit) & 0x80;
        colors[px] = set ? ink : paper;
        foreground[px] = set ? 1 : 0;
      }
    }
  }

  /** Draws this line's sprites over the graphics and records collisions. */
  private renderSprites(): void {
    const regs = this.registers;
    const enabled = regs[REG_SPRITE_ENABLE];
    let anySprite = false;
    for (let sprite = 0; sprite < SPRITE_COUNT; sprite++) {
      if (this.spriteDma[sprite] && enabled & (1 << sprite)) anySprite = true;
    }
    if (!anySprite) return;

    const mask = this.spriteMask;
    const owner = this.spriteOwner;
    const spriteColor = this.spriteColor;
    mask.fill(0);
    let spriteSprite = 0;
    let spriteData = 0;

    const screenBase = ((regs[REG_MEMORY] >> 4) & 0x0f) << 10;
    const multicolor0 = regs[REG_SPRITE_MULTICOLOR0] & 0x0f;
    const multicolor1 = regs[REG_SPRITE_MULTICOLOR1] & 0x0f;

    // Lower-numbered sprites have priority, so draw them last.
    for (let sprite = SPRITE_COUNT - 1; sprite >= 0; sprite--) {
      const bit = 1 << sprite;
      if (!this.spriteDma[sprite] || !(enabled & bit)) continue;

      const expandY = (regs[REG_SPRITE_EXPAND_Y] & bit) !== 0;
      const row = expandY ? this.spriteLine[sprite] >> 1 : this.spriteLine[sprite];
      const pointer = this.memory.read(screenBase | SPRITE_POINTERS | sprite);
      const dataAddress = (pointer << 6) + row * 3;
      const data =
        (this.memory.read(dataAddress & 0x3fff) << 16) |
        (this.memory.read((dataAddress + 1) & 0x3fff) << 8) |
        this.memory.read((dataAddress + 2) & 0x3fff);
      if (data === 0) continue;

      let spriteX = regs[sprite * 2] | (regs[REG_SPRITE_X_MSB] & bit ? 0x100 : 0);
      if (spriteX >= this.videoModel.spriteXWrap) spriteX -= this.videoModel.spriteXWrap;
      const startX = spriteX + SPRITE_X_OFFSET;
      const width = regs[REG_SPRITE_EXPAND_X] & bit ? 2 : 1;
      const isMulticolor = (regs[REG_SPRITE_MULTICOLOR] & bit) !== 0;
      const ownColor = regs[REG_SPRITE_COLOR0 + sprite] & 0x0f;

      for (let i = 0; i < 24; i++) {
        let color: number;
        if (isMulticolor) {
          const pair = (data >> (22 - (i & ~1))) & 0x03;
          if (pair === 0) continue;
          color = pair === 1 ? multicolor0 : pair === 2 ? ownColor : multicolor1;
        } else {
          if (!((data >> (23 - i)) & 1)) continue;
          color = ownColor;
        }
        for (let w = 0; w < width; w++) {
          const px = startX + i * width + w;
          if (px < 0 || px >= FRAME_WIDTH) continue;
          if (mask[px]) spriteSprite |= mask[px] | bit;
          if (this.isForeground[px]) spriteData |= bit;
          mask[px] |= bit;
          owner[px] = sprite;
          spriteColor[px] = color;
        }
      }
    }

    const behindForeground = regs[REG_SPRITE_PRIORITY];
    for (let px = 0; px < FRAME_WIDTH; px++) {
      if (!mask[px]) continue;
      if (behindForeground & (1 << owner[px]) && this.isForeground[px]) continue;
      this.pixelColor[px] = spriteColor[px];
    }

    if (spriteSprite) {
      if (this.spriteSpriteCollision === 0) this.irqFlags |= IRQ_SPRITE_SPRITE;
      this.spriteSpriteCollision |= spriteSprite;
    }
    if (spriteData) {
      if (this.spriteDataCollision === 0) this.irqFlags |= IRQ_SPRITE_DATA;
      this.spriteDataCollision |= spriteData;
    }
  }
}
