import {
  FILE_TYPES,
  PETSCII_PAD,
  SECTOR_SIZE,
  textToPetscii,
  type DirectoryEntry,
  type DiskMedia,
} from './media';

const COMMAND_CHANNEL = 15;
const LOAD_CHANNEL = 0;
const SAVE_CHANNEL = 1;
const MAX_FILENAME = 41;

const SA_DATA = 0x60;
const SA_CLOSE = 0xe0;
const SA_OPEN = 0xf0;

const CR = 0x0d;
const QUOTE = 0x22;
const SPACE = 0x20;
const DIRECTORY_LOAD_ADDRESS = 0x0801;
const RVS_ON = 0x12;

const DOS_VERSION = 'CBM DOS V2.6 1541';

/** U3-U8 (or UC-UH) jump into drive buffer 2 at $0500, $0503, ... $050F. */
const USER_JUMP_COMMANDS = '345678CDEFGH';
const USER_JUMP_BASE = 0x0500;

enum Status {
  Ok = 0,
  ReadError = 20,
  WriteProtect = 26,
  SyntaxError = 31,
  FileNotFound = 62,
  NoChannel = 70,
  IllegalTrackSector = 66,
  DriveNotReady = 74,
  DosVersion = 73,
}

const STATUS_TEXT: Record<Status, string> = {
  [Status.Ok]: ' OK',
  [Status.ReadError]: 'READ ERROR',
  [Status.WriteProtect]: 'WRITE PROTECT ON',
  [Status.SyntaxError]: 'SYNTAX ERROR',
  [Status.FileNotFound]: 'FILE NOT FOUND',
  [Status.NoChannel]: 'NO CHANNEL',
  [Status.IllegalTrackSector]: 'ILLEGAL TRACK OR SECTOR',
  [Status.DriveNotReady]: 'DRIVE NOT READY',
  [Status.DosVersion]: DOS_VERSION,
};

/** An open channel: a byte stream (file or listing) or a 256-byte direct-access buffer. */
interface Channel {
  data: Uint8Array;
  position: number;
  isBuffer: boolean;
}

export interface ByteFromDrive {
  value: number;
  /** True for the last byte of the stream (the IEC "end or identify" signal). */
  eoi: boolean;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * A 1541-compatible device on the serial bus, implemented at the level of
 * the KERNAL's bus primitives (listen/talk, secondary address, byte in/out).
 * It reads files, directory listings and raw sectors; writing is not supported.
 */
export class VirtualDrive {
  media: DiskMedia | null = null;
  /** Called when a program asks for something the virtual drive can't do, like running drive code. */
  onUnsupported: (message: string) => void = () => {};

  private readonly channels = new Map<number, Channel>();
  private listening = false;
  private talking = false;
  private listenSecondary = -1;
  private talkChannel = -1;
  private incoming: number[] = [];
  private statusMessage: Uint8Array = new Uint8Array();
  private memoryReadReply: Uint8Array | null = null;

  constructor(readonly deviceNumber = 8) {
    this.reset();
  }

  reset(): void {
    this.channels.clear();
    this.listening = this.talking = false;
    this.listenSecondary = this.talkChannel = -1;
    this.incoming = [];
    this.memoryReadReply = null;
    this.setStatus(Status.DosVersion);
  }

  insert(media: DiskMedia | null): void {
    this.media = media;
    this.channels.clear();
    this.setStatus(Status.Ok);
  }

  // --- Bus primitives ----------------------------------------------------------

  listen(): void {
    this.listening = true;
    this.talking = false;
    this.listenSecondary = -1;
    this.incoming = [];
  }

  talk(): void {
    this.talking = true;
    this.listening = false;
    this.talkChannel = -1;
  }

  /** Secondary address after LISTEN: open, close, or data for a channel. */
  secondaryAfterListen(secondary: number): void {
    const channel = secondary & 0x0f;
    switch (secondary & 0xf0) {
      case SA_CLOSE:
        this.close(channel);
        this.listenSecondary = -1;
        break;
      case SA_OPEN:
      case SA_DATA:
        this.listenSecondary = secondary;
        this.incoming = [];
        break;
    }
  }

  /** Secondary address after TALK: which channel to read from. */
  secondaryAfterTalk(secondary: number): void {
    this.talkChannel = secondary & 0x0f;
  }

  receive(value: number): void {
    if (this.listening && this.listenSecondary >= 0 && this.incoming.length < 256) {
      this.incoming.push(value);
    }
  }

  /** The next byte for the current talk channel, or null if there is nothing to send. */
  send(): ByteFromDrive | null {
    if (!this.talking || this.talkChannel < 0) return null;
    if (this.talkChannel === COMMAND_CHANNEL) return this.sendStatusByte();

    const channel = this.channels.get(this.talkChannel);
    if (!channel || channel.data.length === 0) return null;
    if (channel.isBuffer) {
      const value = channel.data[channel.position];
      const eoi = channel.position === SECTOR_SIZE - 1;
      channel.position = (channel.position + 1) & 0xff;
      return { value, eoi };
    }
    if (channel.position >= channel.data.length) return null;
    const value = channel.data[channel.position++];
    return { value, eoi: channel.position === channel.data.length };
  }

  unlisten(): void {
    if (this.listening && this.listenSecondary >= 0) {
      const channel = this.listenSecondary & 0x0f;
      const bytes = Uint8Array.from(this.incoming);
      if ((this.listenSecondary & 0xf0) === SA_OPEN) {
        if (channel === COMMAND_CHANNEL) this.executeCommand(bytes);
        else this.open(channel, bytes);
      } else if (channel === COMMAND_CHANNEL) {
        this.executeCommand(bytes);
      } else {
        this.write(channel, bytes);
      }
    }
    this.listening = false;
    this.listenSecondary = -1;
    this.incoming = [];
  }

  untalk(): void {
    this.talking = false;
    this.talkChannel = -1;
  }

  // --- Channels ------------------------------------------------------------------

  private open(channel: number, rawName: Uint8Array): void {
    if (channel === SAVE_CHANNEL) {
      this.setStatus(Status.WriteProtect);
      return;
    }
    const [name, ...options] = splitOptions(stripDrivePrefix(rawName));

    if (name[0] === 0x23 /* # */) {
      this.channels.set(channel, { data: new Uint8Array(SECTOR_SIZE), position: 0, isBuffer: true });
      this.setStatus(Status.Ok);
      return;
    }
    if (!this.media) {
      this.setStatus(Status.DriveNotReady);
      return;
    }
    if (options.some((option) => option[0] === 0x57 /* W */ || option[0] === 0x41 /* A */)) {
      this.setStatus(Status.WriteProtect);
      return;
    }

    let data: Uint8Array | null = null;
    if (name[0] === 0x24 /* $ */) {
      data = this.directoryListing(name.subarray(1));
    } else {
      const entry = this.media.files().find((file) => matches(name, file.name));
      if (entry) data = this.media.readFile(entry);
    }

    if (!data) {
      this.channels.delete(channel);
      this.setStatus(Status.FileNotFound);
      return;
    }
    this.channels.set(channel, { data, position: 0, isBuffer: false });
    this.setStatus(Status.Ok);
  }

  private close(channel: number): void {
    if (channel === COMMAND_CHANNEL) this.channels.clear();
    else this.channels.delete(channel);
  }

  private write(channel: number, bytes: Uint8Array): void {
    const target = this.channels.get(channel);
    if (!target?.isBuffer) {
      this.setStatus(channel === LOAD_CHANNEL || !target ? Status.NoChannel : Status.WriteProtect);
      return;
    }
    for (const b of bytes) {
      target.data[target.position] = b;
      target.position = (target.position + 1) & 0xff;
    }
  }

  // --- Command channel -----------------------------------------------------------

  private executeCommand(raw: Uint8Array): void {
    let end = raw.length;
    while (end > 0 && raw[end - 1] === CR) end--;
    const bytes = raw.subarray(0, end);
    if (bytes.length === 0) return;
    const text = String.fromCharCode(...bytes);

    if (text.startsWith('M-R')) return this.memoryRead(bytes);
    if (text.startsWith('M-W')) return this.setStatus(Status.Ok);
    if (text.startsWith('M-E')) return this.refuseDriveCode(bytes[3] | (bytes[4] << 8));
    const userJump = USER_JUMP_COMMANDS.indexOf(text[1]);
    if (text[0] === 'U' && userJump >= 0) {
      return this.refuseDriveCode(USER_JUMP_BASE + (userJump % 6) * 3);
    }
    if (text[0] === '&') return this.refuseDriveCode(-1);
    if (/^U[1A]/.test(text) || text.startsWith('B-R')) return this.blockRead(text);
    if (text.startsWith('B-P')) return this.bufferPointer(text);
    if (text.startsWith('B-A') || text.startsWith('B-F')) return this.setStatus(Status.Ok);
    if (/^U[2B]/.test(text) || text.startsWith('B-W')) return this.setStatus(Status.WriteProtect);
    if (/^U[IJ:]/.test(text)) {
      this.channels.clear();
      return this.setStatus(Status.DosVersion);
    }
    if (text[0] === 'I') return this.setStatus(this.media ? Status.Ok : Status.DriveNotReady);
    if ('NSRCV'.includes(text[0])) return this.setStatus(Status.WriteProtect);
    this.setStatus(Status.SyntaxError);
  }

  /** Drive-side code (usually a fast loader) would need a real 1541 CPU and DOS ROM. */
  private refuseDriveCode(address: number): void {
    const where = address >= 0 ? ` at $${hex16(address)}` : '';
    this.onUnsupported(`The program tried to run its own code inside the disk drive${where}, which isn't emulated.`);
    this.setStatus(Status.Ok);
  }

  private blockRead(text: string): void {
    const [channel, , track, sector] = commandNumbers(text);
    const target = this.channels.get(channel);
    if (!target?.isBuffer || track === undefined || sector === undefined) {
      return this.setStatus(target ? Status.SyntaxError : Status.NoChannel);
    }
    if (!this.media) return this.setStatus(Status.DriveNotReady);
    const data = this.media.readSector(track, sector);
    if (!data) return this.setStatus(Status.IllegalTrackSector, track, sector);
    target.data.set(data);
    // B-R treats the first byte as a length and starts after it; U1 exposes the whole sector.
    target.position = text.startsWith('B-R') ? 1 : 0;
    this.setStatus(Status.Ok);
  }

  private bufferPointer(text: string): void {
    const [channel, position] = commandNumbers(text);
    const target = this.channels.get(channel);
    if (!target?.isBuffer || position === undefined) return this.setStatus(Status.NoChannel);
    target.position = position & 0xff;
    this.setStatus(Status.Ok);
  }

  /** Drive memory isn't emulated, so reads return zeros. */
  private memoryRead(bytes: Uint8Array): void {
    const count = bytes.length > 5 ? bytes[5] || 256 : 1;
    this.memoryReadReply = new Uint8Array(count);
  }

  // --- Status channel --------------------------------------------------------------

  private setStatus(code: Status, track = 0, sector = 0): void {
    this.memoryReadReply = null;
    const message = `${pad2(code)},${STATUS_TEXT[code]},${pad2(track)},${pad2(sector)}\r`;
    this.statusMessage = textToPetscii(message);
  }

  private sendStatusByte(): ByteFromDrive {
    if (this.memoryReadReply) {
      const reply = this.memoryReadReply;
      const value = reply[0];
      this.memoryReadReply = reply.length > 1 ? reply.subarray(1) : null;
      return { value, eoi: this.memoryReadReply === null };
    }
    const message = this.statusMessage;
    const value = message[0];
    if (message.length > 1) {
      this.statusMessage = message.subarray(1);
      return { value, eoi: false };
    }
    // Once the whole message has been read, the drive reports OK again.
    this.setStatus(Status.Ok);
    return { value, eoi: true };
  }

  // --- Directory listing -------------------------------------------------------

  /** Builds the directory as a BASIC program, the way the 1541 sends it for LOAD"$". */
  private directoryListing(pattern: Uint8Array): Uint8Array {
    const media = this.media!;
    const out: number[] = [DIRECTORY_LOAD_ADDRESS & 0xff, DIRECTORY_LOAD_ADDRESS >> 8];
    const line = (number: number, text: number[]) => {
      out.push(0x01, 0x01, number & 0xff, number >> 8, ...text, 0);
    };

    const header = new Array<number>(16).fill(SPACE);
    media.name.forEach((b, i) => (header[i] = b === PETSCII_PAD ? SPACE : b));
    const id = [...media.id].map((b) => (b === PETSCII_PAD ? SPACE : b));
    line(0, [RVS_ON, QUOTE, ...header, QUOTE, SPACE, ...id]);

    const filter = directoryFilter(pattern);
    for (const file of media.files()) {
      if (filter.length > 0 && !matches(filter, file.name)) continue;
      line(file.blocks, directoryLine(file));
    }

    line(media.freeBlocks, [...textToPetscii('BLOCKS FREE.'), ...new Array<number>(13).fill(SPACE)]);
    out.push(0, 0);
    return Uint8Array.from(out);
  }
}

function directoryLine(file: DirectoryEntry): number[] {
  const indent = file.blocks < 10 ? 3 : file.blocks < 100 ? 2 : 1;
  const text: number[] = new Array<number>(indent).fill(SPACE);
  text.push(QUOTE, ...file.name, QUOTE);
  text.push(...new Array<number>(16 - file.name.length + 1).fill(SPACE));
  text[text.length - 1] = file.type & 0x80 ? SPACE : 0x2a; /* * marks an unclosed file */
  text.push(...textToPetscii(FILE_TYPES[file.type & 0x07] ?? '???'));
  text.push(file.type & 0x40 ? 0x3c /* < */ : SPACE);
  return text;
}

/** The name filter in "$", "$0", "$:NAME*" or "$0:NAME*". */
function directoryFilter(pattern: Uint8Array): Uint8Array {
  const colon = pattern.indexOf(0x3a);
  if (colon >= 0) return pattern.subarray(colon + 1);
  const isDriveNumber = pattern.every((b) => b >= 0x30 && b <= 0x39);
  return isDriveNumber ? pattern.subarray(pattern.length) : pattern;
}

function hex16(value: number): string {
  return value.toString(16).padStart(4, '0').toUpperCase();
}

/** All decimal numbers in a command after its name, e.g. "U1:2,0,18,0" -> [2, 0, 18, 0]. */
function commandNumbers(text: string): number[] {
  const parameters = text.replace(/^(U.|B-.)/, '');
  return (parameters.match(/\d+/g) ?? []).map(Number);
}

/** Removes a leading "0:" or ":" drive specifier and the "@" replace marker. */
function stripDrivePrefix(name: Uint8Array): Uint8Array {
  let start = 0;
  if (name[start] === 0x40 /* @ */) start++;
  const colon = name.indexOf(0x3a);
  if (colon >= 0 && colon <= start + 1 && name[0] !== 0x24 /* $ keeps its pattern */) start = colon + 1;
  return name.subarray(start, Math.min(name.length, start + MAX_FILENAME));
}

/** Splits "NAME,P,R" into the name and its options. */
function splitOptions(name: Uint8Array): Uint8Array[] {
  const parts: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i <= name.length; i++) {
    if (i === name.length || name[i] === 0x2c /* , */) {
      parts.push(name.subarray(start, i));
      start = i + 1;
    }
  }
  return parts;
}

/** 1541 wildcard matching: `?` matches one character, `*` matches the rest. */
function matches(pattern: Uint8Array, name: Uint8Array): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === 0x2a /* * */) return true;
    if (i >= name.length) return false;
    if (pattern[i] !== 0x3f /* ? */ && pattern[i] !== name[i]) return false;
  }
  return pattern.length === name.length;
}
