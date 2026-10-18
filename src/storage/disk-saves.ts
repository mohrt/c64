import { D64Image } from '../disk/d64';
import { buildD64 } from '../disk/d64-builder';
import type { KeyValueStore } from './store';

/** Sectors a program wrote to a disk image, keyed "track/sector". */
export interface DiskSaveRecord {
  name: string;
  updated: number;
  sectors: Record<string, Uint8Array>;
}

/** A blank disk created in the emulator for saving games, stored whole. */
export interface SaveDiskRecord {
  name: string;
  created: number;
  updated: number;
  bytes: Uint8Array;
}

export interface SaveDiskInfo {
  id: string;
  name: string;
  updated: number;
}

export async function fingerprint(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function forEachSector(image: D64Image, visit: (track: number, sector: number, data: Uint8Array) => void): void {
  for (let track = 1; track <= image.tracks; track++) {
    for (let sector = 0; ; sector++) {
      const data = image.readSector(track, sector);
      if (!data) break;
      visit(track, sector, data);
    }
  }
}

/** The sectors of `current` that differ from `original`. */
export function changedSectors(original: D64Image, current: D64Image): Record<string, Uint8Array> {
  const changes: Record<string, Uint8Array> = {};
  forEachSector(current, (track, sector, data) => {
    const before = original.readSector(track, sector)!;
    if (data.some((byte, i) => byte !== before[i])) changes[`${track}/${sector}`] = data;
  });
  return changes;
}

export function applySectors(image: D64Image, sectors: Record<string, Uint8Array>): void {
  for (const [key, data] of Object.entries(sectors)) {
    const [track, sector] = key.split('/').map(Number);
    image.writeSector(track, sector, data);
  }
}

/** Where the changes to the inserted disk are kept. */
type DiskOrigin =
  | { kind: 'image'; key: string; name: string; original: Uint8Array }
  | { kind: 'saveDisk'; id: string; record: SaveDiskRecord };

/**
 * Keeps games' saves in browser storage without ever modifying the user's disk
 * image: for a dropped image only the changed sectors are stored, keyed by a
 * fingerprint of the original, and re-applied whenever that image is inserted.
 * Blank save disks created in the emulator are stored whole.
 */
export class DiskSaves {
  private origin: DiskOrigin | null = null;

  constructor(
    private readonly overlays: KeyValueStore<DiskSaveRecord>,
    private readonly saveDisks: KeyValueStore<SaveDiskRecord>,
  ) {}

  /** A working copy of a dropped image with its stored changes applied. */
  async openImage(bytes: Uint8Array, name: string): Promise<{ image: D64Image; hasSavedChanges: boolean }> {
    const key = await fingerprint(bytes);
    const image = new D64Image(bytes.slice());
    const record = await this.overlays.get(key);
    if (record) applySectors(image, record.sectors);
    this.origin = { kind: 'image', key, name, original: bytes.slice() };
    return { image, hasSavedChanges: record !== undefined };
  }

  async createSaveDisk(): Promise<{ id: string; image: D64Image; name: string }> {
    const count = (await this.saveDisks.entries()).length;
    const name = `SAVE DISK ${count + 1}`;
    const now = Date.now();
    const record: SaveDiskRecord = { name, created: now, updated: now, bytes: buildD64(name, 'SV 2A', []) };
    const id = `save-${now}`;
    await this.saveDisks.put(id, record);
    this.origin = { kind: 'saveDisk', id, record };
    return { id, image: new D64Image(record.bytes.slice()), name };
  }

  async openSaveDisk(id: string): Promise<{ image: D64Image; name: string } | null> {
    const record = await this.saveDisks.get(id);
    if (!record) return null;
    this.origin = { kind: 'saveDisk', id, record };
    return { image: new D64Image(record.bytes.slice()), name: record.name };
  }

  async listSaveDisks(): Promise<SaveDiskInfo[]> {
    const entries = await this.saveDisks.entries();
    return entries.map(([id, record]) => ({ id, name: record.name, updated: record.updated })).sort((a, b) => a.updated - b.updated);
  }

  async saveDiskBytes(id: string): Promise<Uint8Array | null> {
    return (await this.saveDisks.get(id))?.bytes ?? null;
  }

  async deleteSaveDisk(id: string): Promise<void> {
    await this.saveDisks.delete(id);
    if (this.origin?.kind === 'saveDisk' && this.origin.id === id) this.origin = null;
  }

  /** The save disk currently inserted, if any. */
  get currentSaveDiskId(): string | null {
    return this.origin?.kind === 'saveDisk' ? this.origin.id : null;
  }

  /** Stores everything the drive has written to the inserted disk. */
  async persist(image: D64Image): Promise<void> {
    const origin = this.origin;
    if (!origin) return;
    if (origin.kind === 'saveDisk') {
      origin.record = { ...origin.record, updated: Date.now(), bytes: image.bytes };
      await this.saveDisks.put(origin.id, origin.record);
      return;
    }
    const sectors = changedSectors(new D64Image(origin.original.slice()), image);
    if (Object.keys(sectors).length === 0) await this.overlays.delete(origin.key);
    else await this.overlays.put(origin.key, { name: origin.name, updated: Date.now(), sectors });
  }

  /** Forgets the stored changes to the inserted image and returns a clean copy of it. */
  async revert(): Promise<D64Image | null> {
    const origin = this.origin;
    if (origin?.kind !== 'image') return null;
    await this.overlays.delete(origin.key);
    return new D64Image(origin.original.slice());
  }

  eject(): void {
    this.origin = null;
  }
}
