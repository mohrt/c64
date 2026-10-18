import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { C64 } from '../../src/c64';
import { Key, type C64Key } from '../../src/io/keyboard';

const ROM_DIRS = {
  open: join(import.meta.dirname, '..', '..', 'public', 'roms'),
  system: join(import.meta.dirname, '..', '..', 'public', 'roms', 'system'),
};
export type RomSetName = keyof typeof ROM_DIRS;

/** Open ROMs are downloaded with `npm run fetch:roms`; suites using them skip until then. */
export const hasOpenRoms = existsSync(join(ROM_DIRS.open, 'kernal.rom'));
export const hasSystemRoms = existsSync(join(ROM_DIRS.system, 'kernal.rom'));
export const DRIVE_ROM_PATH = join(ROM_DIRS.system, 'dos1541.rom');
export const hasDriveRom = existsSync(DRIVE_ROM_PATH);

export function loadDriveRom(): Uint8Array {
  return new Uint8Array(readFileSync(DRIVE_ROM_PATH));
}

const SCREEN_RAM = 0x0400;
const COLUMNS = 40;
const ROWS = 25;

/** Creates a C64 in fast drive mode, or with a true 1541 when `accurateDrive` is set. */
export function createMachine(romSet: RomSetName = 'open', options: { accurateDrive?: boolean } = {}): C64 {
  const rom = (name: string) => new Uint8Array(readFileSync(join(ROM_DIRS[romSet], name)));
  const roms = { basic: rom('basic.rom'), kernal: rom('kernal.rom'), chargen: rom('chargen.rom') };
  if (options.accurateDrive) return new C64(roms, loadDriveRom());
  return new C64(roms);
}

export function runFrames(c64: C64, frames: number): void {
  for (let i = 0; i < frames; i++) c64.runFrame();
}

/** Converts screen codes to ASCII, ignoring reverse video (the cursor). */
function screenCodeToChar(code: number): string {
  const c = code & 0x7f;
  if (c === 0) return '@';
  if (c <= 26) return String.fromCharCode(0x40 + c);
  if (c >= 0x20 && c < 0x40) return String.fromCharCode(c);
  if (c >= 0x41 && c <= 0x5a) return String.fromCharCode(c); // uppercase in the lowercase charset
  return ' ';
}

export function screenText(c64: C64): string[] {
  const lines: string[] = [];
  for (let row = 0; row < ROWS; row++) {
    let line = '';
    for (let col = 0; col < COLUMNS; col++) {
      line += screenCodeToChar(c64.bus.ram[SCREEN_RAM + row * COLUMNS + col]);
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

const TYPEABLE: Record<string, C64Key[]> = {
  ' ': [Key.Space],
  '+': [Key.Plus],
  ',': [Key.Comma],
  '.': [Key.Period],
  '*': [Key.Asterisk],
  '$': [Key.LeftShift, Key.Digit4], '#': [Key.LeftShift, Key.Digit3], ';': [Key.Semicolon], ':': [Key.Colon],
  '\n': [Key.Return],
  '0': [Key.Digit0], '1': [Key.Digit1], '2': [Key.Digit2], '3': [Key.Digit3], '4': [Key.Digit4],
  '5': [Key.Digit5], '6': [Key.Digit6], '7': [Key.Digit7], '8': [Key.Digit8], '9': [Key.Digit9],
  '"': [Key.LeftShift, Key.Digit2],
};

/** Types text by holding each key for a few frames, as a person would. */
export function typeText(c64: C64, text: string): void {
  for (const ch of text) {
    const keys = TYPEABLE[ch] ?? [Key[ch.toUpperCase() as keyof typeof Key]];
    if (keys.some((k) => k === undefined)) throw new Error(`Cannot type ${JSON.stringify(ch)}`);
    keys.forEach((k) => c64.keyboard.press(k));
    runFrames(c64, 3);
    keys.forEach((k) => c64.keyboard.release(k));
    runFrames(c64, 3);
  }
}
