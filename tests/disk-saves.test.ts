import { describe, expect, it } from 'vitest';
import { D64Image } from '../src/disk/d64';
import { petsciiToText } from '../src/disk/media';
import { DiskSaves, applySectors, changedSectors, type DiskSaveRecord, type SaveDiskRecord } from '../src/storage/disk-saves';
import { MemoryStore } from '../src/storage/store';
import { buildD64, prg } from './helpers/d64-builder';
import { createMachine, hasDriveRom, hasSystemRoms, runFrames, screenText, typeText } from './helpers/machine';

const MAX_FRAMES = 50 * 60;

function makeSaves() {
  return new DiskSaves(new MemoryStore<DiskSaveRecord>(), new MemoryStore<SaveDiskRecord>());
}

/** Types a command and waits for the READY prompt that follows it. */
function command(c64: ReturnType<typeof createMachine>, text: string) {
  typeText(c64, `${text}\n`);
  const done = () => {
    const lines = screenText(c64);
    const at = lines.lastIndexOf(text);
    return at >= 0 && lines.slice(at + 1).includes('READY.');
  };
  for (let frames = 0; frames < MAX_FRAMES && !done(); frames += 25) runFrames(c64, 25);
  return screenText(c64);
}

describe('sector overlays', () => {
  it('finds changed sectors and applies them to a fresh copy', () => {
    const bytes = buildD64('DISK', 'DK 2A', [{ name: 'A', data: prg(0x0801, [1, 2, 3]) }]);
    const original = new D64Image(bytes.slice());
    const changed = new D64Image(bytes.slice());
    changed.writeSector(5, 3, new Uint8Array(256).fill(0x42));
    const sectors = changedSectors(original, changed);
    expect(Object.keys(sectors)).toEqual(['5/3']);

    const copy = new D64Image(bytes.slice());
    applySectors(copy, sectors);
    expect(copy.readSector(5, 3)?.[0]).toBe(0x42);
  });

  it('re-applies stored changes when the same image is opened again, without touching it', async () => {
    const saves = makeSaves();
    const bytes = buildD64('DISK', 'DK 2A', []);
    const pristine = bytes.slice();
    const { image, hasSavedChanges } = await saves.openImage(bytes, 'disk.d64');
    expect(hasSavedChanges).toBe(false);
    image.writeSector(20, 1, new Uint8Array(256).fill(7));
    await saves.persist(image);

    const again = await saves.openImage(bytes, 'disk.d64');
    expect(again.hasSavedChanges).toBe(true);
    expect(again.image.readSector(20, 1)?.[0]).toBe(7);
    expect(bytes).toEqual(pristine);

    const reverted = await saves.revert();
    expect(reverted?.readSector(20, 1)?.[0]).toBe(0);
    expect((await saves.openImage(bytes, 'disk.d64')).hasSavedChanges).toBe(false);
  });

  it('keeps blank save disks whole and lists them', async () => {
    const saves = makeSaves();
    const { id, image, name } = await saves.createSaveDisk();
    expect(name).toBe('SAVE DISK 1');
    image.writeSector(1, 0, new Uint8Array(256).fill(9));
    await saves.persist(image);
    expect((await saves.listSaveDisks()).map((d) => d.name)).toEqual(['SAVE DISK 1']);
    const reopened = await saves.openSaveDisk(id);
    expect(reopened?.image.readSector(1, 0)?.[0]).toBe(9);
    await saves.deleteSaveDisk(id);
    expect(await saves.listSaveDisks()).toEqual([]);
  });
});

describe.skipIf(!hasSystemRoms || !hasDriveRom)('saving through the true 1541', () => {
  it('SAVE writes a file that is still there after re-inserting the disk', async () => {
    const saves = makeSaves();
    const bytes = buildD64('GAME DISK', 'GD 2A', []);
    const pristine = bytes.slice();

    const c64 = createMachine('system', { accurateDrive: true });
    runFrames(c64, 150);
    const { image } = await saves.openImage(bytes, 'game.d64');
    c64.insertDisk(image, { writable: true });
    command(c64, '10 PRINT "SAVED OK"');
    command(c64, 'SAVE"PROGRESS",8');
    expect(c64.syncDisk()).toBe(true);
    await saves.persist(c64.diskImage!);
    expect(bytes).toEqual(pristine);

    // A fresh machine with the same original image gets the save back.
    const later = createMachine('system', { accurateDrive: true });
    runFrames(later, 150);
    const reopened = await saves.openImage(bytes, 'game.d64');
    expect(reopened.hasSavedChanges).toBe(true);
    expect(reopened.image.files().map((f) => petsciiToText(f.name))).toEqual(['PROGRESS']);
    later.insertDisk(reopened.image, { writable: true });
    command(later, 'LOAD"PROGRESS",8');
    const lines = command(later, 'RUN');
    expect(lines[lines.lastIndexOf('RUN') + 1]).toBe('SAVED OK');
  }, 120_000);

  it('reports WRITE PROTECT ON for read-only disks', () => {
    const c64 = createMachine('system', { accurateDrive: true });
    runFrames(c64, 150);
    c64.insertDisk(new D64Image(buildD64('LOCKED', 'LK 2A', [])));
    command(c64, '10 OPEN15,8,15:INPUT#15,A,B$:PRINTA;B$:CLOSE15');
    command(c64, 'SAVE"X",8');
    // BASIC doesn't show drive errors after SAVE; the drive's error channel has it.
    const lines = command(c64, 'RUN');
    expect(lines.join(' ')).toContain('26 WRITE PROTECT ON');
    expect(c64.syncDisk()).toBe(false);
  }, 120_000);
});
