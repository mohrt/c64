import type { MachineState } from '../c64';
import { decodeState, encodeState } from '../state/snapshot';
import type { DiskOriginRef } from './disk-saves';
import type { KeyValueStore } from './store';

/** Everything needed to resume: the machine, and where its disk's saves go. */
export interface Session {
  machine: MachineState;
  diskOrigin: DiskOriginRef | null;
  /** The name shown for the inserted disk. */
  diskLabel: string | null;
}

export interface SaveStateRecord {
  name: string;
  created: number;
  /** The session, gzipped (the same format as exported .c64state files). */
  bytes: Uint8Array;
}

export interface SaveStateInfo {
  id: string;
  name: string;
  created: number;
}

/** Older states are dropped beyond this many. */
const MAX_STATES = 30;

/** Save states kept in browser storage, newest first. */
export class SaveStates {
  constructor(private readonly store: KeyValueStore<SaveStateRecord>) {}

  async add(name: string, session: Session): Promise<void> {
    const created = Date.now();
    await this.store.put(`state-${created}`, { name, created, bytes: await encodeSession(session) });
    const all = await this.list();
    for (const old of all.slice(MAX_STATES)) await this.store.delete(old.id);
  }

  async list(): Promise<SaveStateInfo[]> {
    const entries = await this.store.entries();
    return entries.map(([id, record]) => ({ id, name: record.name, created: record.created })).sort((a, b) => b.created - a.created);
  }

  async load(id: string): Promise<Session | null> {
    const record = await this.store.get(id);
    return record ? decodeSession(record.bytes) : null;
  }

  async delete(id: string): Promise<void> {
    await this.store.delete(id);
  }
}

const MAGIC = 'c64-session';

export async function encodeSession(session: Session): Promise<Uint8Array> {
  return encodeState({ magic: MAGIC, ...session });
}

export async function decodeSession(bytes: Uint8Array): Promise<Session> {
  const decoded = await decodeState<Session & { magic?: string }>(bytes).catch(() => null);
  if (decoded?.magic !== MAGIC) throw new Error('That file is not a C64 save state.');
  return decoded;
}

/** gzip files start with $1F $8B; save states are gzipped. */
export function looksLikeSaveState(bytes: Uint8Array): boolean {
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}
