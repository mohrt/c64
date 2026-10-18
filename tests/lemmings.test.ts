import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { D64Image } from '../src/disk/d64';
import { Key, type C64Key } from '../src/io/keyboard';
import { createMachine, hasDriveRom, hasSystemRoms, runFrames, screenText, typeText } from './helpers/machine';

/** Uses LEMMINGS_D64 if set, otherwise a "Lemmings ... Side A" image placed in disks/. */
const DISK_DIR = join(import.meta.dirname, '..', 'disks');
const fromDisks = existsSync(DISK_DIR)
  ? readdirSync(DISK_DIR).find((name) => /lemmings/i.test(name) && /side a/i.test(name) && /\.d64$/i.test(name))
  : undefined;
const lemmingsImage = process.env.LEMMINGS_D64 ?? (fromDisks ? join(DISK_DIR, fromDisks) : undefined);

const TRAINER_QUESTIONS = 12;
const BITMAP_MODE = 0x20;
const MULTICOLOR_MODE = 0x10;
const MAX_SECONDS = 180;

describe.skipIf(!lemmingsImage || !hasSystemRoms || !hasDriveRom)('Lemmings on the true 1541', () => {
  // This crack's fast loader is timed for PAL; on NTSC (a 3.8% faster C64) it loses sync.
  it('gets through the crack intro and its drive fast loader to the title screen', () => {
    const c64 = createMachine('system', { accurateDrive: true });
    c64.insertDisk(new D64Image(new Uint8Array(readFileSync(lemmingsImage!))));
    const tap = (key: C64Key) => {
      c64.keyboard.press(key);
      runFrames(c64, 5);
      c64.keyboard.release(key);
      runFrames(c64, 10);
    };

    runFrames(c64, 150);
    typeText(c64, 'LOAD"*",8,1\n');
    for (let second = 0; second < MAX_SECONDS; second++) {
      runFrames(c64, 50);
      if (screenText(c64).filter((line) => line === 'READY.').length >= 2) break;
    }
    typeText(c64, 'RUN\n');

    // The crack intro plays music through the SID once its first text screen is done.
    c64.takeAudioSamples();
    let introMusicLevel = 0;
    for (let second = 0; second < 20; second++) {
      runFrames(c64, 50);
      const samples = c64.takeAudioSamples();
      const rms = Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length);
      introMusicLevel = Math.max(introMusicLevel, rms);
    }

    // Intro screens wait for Space; the trainer menu asks twelve Y/N questions.
    let answered = 0;
    let unchanged = 0;
    let previous = '';
    for (let second = 0; second < 60 && answered < TRAINER_QUESTIONS; second++) {
      runFrames(c64, 50);
      const text = screenText(c64).join('\n');
      unchanged = text === previous ? unchanged + 1 : 0;
      previous = text;
      if (/Y\/N/.test(text)) {
        tap(Key.N);
        answered++;
      } else if (/PRESS SPACE/.test(text) || unchanged > 4) {
        tap(Key.Space);
        unchanged = 0;
      }
    }
    expect(answered).toBe(TRAINER_QUESTIONS);

    // The game now loads through the crack's drive-side fast loader and shows its title screen.
    let reachedTitle = false;
    for (let second = 0; second < MAX_SECONDS && !reachedTitle; second++) {
      runFrames(c64, 50);
      const control1 = c64.bus.read(0xd011);
      const control2 = c64.bus.read(0xd016);
      reachedTitle = !c64.driveBusy && (control1 & BITMAP_MODE) !== 0 && (control2 & MULTICOLOR_MODE) !== 0 && c64.cpu.pc < 0xa000;
    }
    expect(reachedTitle).toBe(true);
    expect(c64.cpu.jammedAt).toBe(-1);
    expect(screenText(c64)).not.toContain('READY.');
    expect(introMusicLevel).toBeGreaterThan(0.005);
  }, 300_000);
});
