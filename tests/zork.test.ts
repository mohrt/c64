import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { D64Image } from '../src/disk/d64';
import { createMachine, hasDriveRom, hasSystemRoms, runFrames, screenText, typeText } from './helpers/machine';

const DISK_DIR = join(import.meta.dirname, '..', 'disks');
const zorkImage = existsSync(DISK_DIR)
  ? readdirSync(DISK_DIR).find((name) => /zork/i.test(name) && /\.d64$/i.test(name))
  : undefined;

const BOOT_FRAMES = 150;
/** Two minutes of emulated time; the real 1541 path loads at genuine disk speed. */
const MAX_LOAD_FRAMES = 50 * 120;

function startZork(answer: 'Y' | 'N', accurateDrive = false) {
  const c64 = createMachine('system', { accurateDrive });
  const unsupported: string[] = [];
  c64.drive.onUnsupported = (message) => unsupported.push(message);
  c64.insertDisk(new D64Image(new Uint8Array(readFileSync(join(DISK_DIR, zorkImage!)))));
  runFrames(c64, BOOT_FRAMES);
  typeText(c64, 'LOAD"*",8,1\n');
  for (let frames = 0; frames < MAX_LOAD_FRAMES; frames += 25) {
    runFrames(c64, 25);
    if (screenText(c64).filter((line) => line === 'READY.').length >= 2) break;
  }
  typeText(c64, 'RUN\n');
  runFrames(c64, 100);
  expect(screenText(c64).join(' ')).toContain('COMMODORE 1541 DISK DRIVE?');
  typeText(c64, answer);
  return { c64, unsupported };
}

function playOpening(c64: ReturnType<typeof createMachine>) {
  const atPrompt = () => screenText(c64).includes('>');
  for (let frames = 0; frames < MAX_LOAD_FRAMES && !atPrompt(); frames += 50) runFrames(c64, 50);
  expect(screenText(c64)).toContain('WEST OF HOUSE');
  expect(atPrompt()).toBe(true);

  typeText(c64, 'OPEN MAILBOX\n');
  // The answer may need story data from disk, loaded at the drive's real speed.
  const answered = () => screenText(c64).join(' ').includes('LEAFLET');
  for (let frames = 0; frames < MAX_LOAD_FRAMES && !answered(); frames += 50) runFrames(c64, 50);
  expect(answered()).toBe(true);
  expect(c64.cpu.jammedAt).toBe(-1);
}

describe.skipIf(!zorkImage || !hasSystemRoms)('Zork I from a D64 image', () => {
  it('loads through the KERNAL path on the fast drive and accepts commands', () => {
    const { c64, unsupported } = startZork('N');
    playOpening(c64);
    expect(unsupported).toEqual([]);
  }, 60_000);

  it('reports the 1541 fast loader as unsupported on the fast drive', () => {
    const { c64, unsupported } = startZork('Y');
    runFrames(c64, 250);
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]).toMatch(/inside the disk drive/);
  }, 60_000);

  it.skipIf(!hasDriveRom)('runs Infocom\'s drive fast loader on the true 1541', () => {
    const { c64 } = startZork('Y', true);
    playOpening(c64);
  }, 120_000);
});
