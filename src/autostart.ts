import type { C64 } from './c64';

// Standard KERNAL/BASIC locations, shared by compatible ROMs.
const KEYBOARD_BUFFER = 0x0277;
const KEYBOARD_BUFFER_COUNT = 0xc6;
const KEYBOARD_BUFFER_SIZE = 10;
/** BASIC's message flag: bit 7 is set while it is in direct mode (at the READY prompt). */
const DIRECT_MODE_FLAG = 0x9d;
const SCREEN_RAM = 0x0400;
const COLUMNS = 40;
const ROWS = 25;
const RETURN = 0x0d;

const LOAD_COMMAND = 'LOAD"*",8,1';
const RUN_COMMAND = 'RUN';
/** Give up waiting for a load after this many frames (about three minutes). */
const TIMEOUT_FRAMES = 50 * 180;

const READY_LINE = toScreenCodes('READY.');

function toScreenCodes(text: string): number[] {
  return [...text].map((ch) => {
    const code = ch.charCodeAt(0);
    return code >= 0x40 && code < 0x60 ? code - 0x40 : code;
  });
}

function rowStartsWith(c64: C64, row: number, codes: number[]): boolean {
  const start = SCREEN_RAM + row * COLUMNS;
  return codes.every((code, i) => (c64.bus.ram[start + i] & 0x7f) === code);
}

/** True if BASIC is idle at its READY prompt, so typing commands won't disturb a running program. */
export function atReadyPrompt(c64: C64): boolean {
  if (!c64.bus.kernalVisible || !c64.bus.basicVisible) return false;
  if (!(c64.bus.ram[DIRECT_MODE_FLAG] & 0x80) || c64.bus.ram[KEYBOARD_BUFFER_COUNT] !== 0) return false;
  for (let row = 0; row < ROWS; row++) if (rowStartsWith(c64, row, READY_LINE)) return true;
  return false;
}

type Phase = 'idle' | 'typingLoad' | 'loading' | 'typingRun';

/**
 * Types LOAD"*",8,1 and then RUN, the way you would after inserting a disk.
 * RUN is only typed once BASIC says READY. again, so programs that start
 * themselves are left alone. Call `tick()` once per frame.
 */
export class Autostart {
  private phase: Phase = 'idle';
  private pending: number[] = [];
  private loadRow = -1;
  private frames = 0;

  constructor(private readonly c64: C64) {}

  get active(): boolean {
    return this.phase !== 'idle';
  }

  start(): void {
    this.type(LOAD_COMMAND);
    this.phase = 'typingLoad';
    this.frames = 0;
  }

  cancel(): void {
    this.phase = 'idle';
    this.pending = [];
  }

  tick(): void {
    if (this.phase === 'idle') return;
    if (++this.frames > TIMEOUT_FRAMES) return this.cancel();
    this.feedKeyboardBuffer();

    switch (this.phase) {
      case 'typingLoad':
        // Wait until BASIC has echoed the command, so the READY. that follows it can be told apart.
        if (this.pending.length === 0) {
          this.loadRow = this.findRow(toScreenCodes(LOAD_COMMAND));
          if (this.loadRow >= 0) this.phase = 'loading';
        }
        break;
      case 'loading':
        if (this.loadFinished()) {
          this.type(RUN_COMMAND);
          this.phase = 'typingRun';
        }
        break;
      case 'typingRun':
        if (this.pending.length === 0) this.phase = 'idle';
        break;
    }
  }

  private type(command: string): void {
    this.pending.push(...[...command].map((ch) => ch.charCodeAt(0)), RETURN);
  }

  /** Tops up the KERNAL's 10-key buffer as BASIC consumes it. */
  private feedKeyboardBuffer(): void {
    const ram = this.c64.bus.ram;
    let count = ram[KEYBOARD_BUFFER_COUNT];
    while (this.pending.length > 0 && count < KEYBOARD_BUFFER_SIZE) {
      ram[KEYBOARD_BUFFER + count++] = this.pending.shift()!;
    }
    ram[KEYBOARD_BUFFER_COUNT] = count;
  }

  private loadFinished(): boolean {
    if (this.c64.driveBusy || !atReadyPrompt(this.c64)) return false;
    for (let row = this.loadRow + 1; row < ROWS; row++) {
      if (rowStartsWith(this.c64, row, READY_LINE)) return true;
    }
    return false;
  }

  private findRow(codes: number[]): number {
    for (let row = ROWS - 1; row >= 0; row--) if (rowStartsWith(this.c64, row, codes)) return row;
    return -1;
  }
}
