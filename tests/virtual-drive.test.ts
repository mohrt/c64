import { describe, expect, it } from 'vitest';
import { D64Image } from '../src/disk/d64';
import { petsciiToText, textToPetscii } from '../src/disk/media';
import { VirtualDrive } from '../src/disk/virtual-drive';
import { buildD64, prg } from './helpers/d64-builder';

const game = prg(0xc000, Array.from({ length: 600 }, (_, i) => i & 0xff));

function makeDrive() {
  const drive = new VirtualDrive();
  drive.insert(
    new D64Image(
      buildD64('GAMES', 'GM 2A', [
        { name: 'GAME', data: game },
        { name: 'NOTES', data: textToPetscii('HELLO'), type: 0x81 },
      ]),
    ),
  );
  return drive;
}

function sendTo(drive: VirtualDrive, secondary: number, text: string | Uint8Array) {
  drive.listen();
  drive.secondaryAfterListen(secondary);
  const bytes = typeof text === 'string' ? textToPetscii(text) : text;
  bytes.forEach((b) => drive.receive(b));
  drive.unlisten();
}

const open = (drive: VirtualDrive, channel: number, name: string) => sendTo(drive, 0xf0 | channel, name);
const command = (drive: VirtualDrive, text: string) => sendTo(drive, 0x6f, `${text}\r`);

function read(drive: VirtualDrive, channel: number, max = 100_000) {
  drive.talk();
  drive.secondaryAfterTalk(0x60 | channel);
  const bytes: number[] = [];
  let sawEoi = false;
  for (let i = 0; i < max; i++) {
    const next = drive.send();
    if (!next) break;
    bytes.push(next.value);
    if (next.eoi) {
      sawEoi = true;
      break;
    }
  }
  drive.untalk();
  return { bytes: Uint8Array.from(bytes), sawEoi };
}

const status = (drive: VirtualDrive) => petsciiToText(read(drive, 15).bytes).trim();

describe('VirtualDrive', () => {
  it('reports the DOS version after reset, then OK', () => {
    const drive = new VirtualDrive();
    expect(status(drive)).toBe('73,CBM DOS V2.6 1541,00,00');
    expect(status(drive)).toBe('00, OK,00,00');
  });

  it('loads a file by name with EOI on the last byte', () => {
    const drive = makeDrive();
    open(drive, 0, 'GAME');
    const { bytes, sawEoi } = read(drive, 0);
    expect(bytes).toEqual(game);
    expect(sawEoi).toBe(true);
    expect(read(drive, 0).bytes.length).toBe(0);
  });

  it('matches wildcards and drive prefixes', () => {
    const drive = makeDrive();
    open(drive, 0, '*');
    expect(read(drive, 0).bytes).toEqual(game);
    open(drive, 2, '0:N?TES,S,R');
    expect(petsciiToText(read(drive, 2).bytes)).toBe('HELLO');
  });

  it('reports FILE NOT FOUND and sends nothing', () => {
    const drive = makeDrive();
    open(drive, 0, 'MISSING');
    expect(read(drive, 0).bytes.length).toBe(0);
    expect(status(drive)).toBe('62,FILE NOT FOUND,00,00');
  });

  it('builds a BASIC directory listing for $', () => {
    const drive = makeDrive();
    open(drive, 0, '$');
    const { bytes } = read(drive, 0);
    expect(bytes[0] | (bytes[1] << 8)).toBe(0x0801);
    const text = petsciiToText(bytes);
    expect(text).toContain('"GAMES           " GM 2A');
    expect(text).toContain('"GAME"');
    expect(text).toContain('PRG');
    expect(text).toContain('SEQ');
    expect(text).toContain('BLOCKS FREE.');
    expect(bytes.subarray(-2)).toEqual(new Uint8Array([0, 0]));
  });

  it('reads raw sectors with U1 and B-P through a buffer channel', () => {
    const drive = makeDrive();
    open(drive, 15, 'I0');
    open(drive, 2, '#');
    command(drive, 'U1:2,0,018,000');
    expect(status(drive)).toBe('00, OK,00,00');
    command(drive, 'B-P:2,0');

    const { bytes, sawEoi } = read(drive, 2, 256);
    expect(bytes.length).toBe(256);
    expect(sawEoi).toBe(true);
    expect(bytes[0]).toBe(18);
    expect(petsciiToText(bytes.subarray(0x90, 0x95))).toBe('GAMES');

    command(drive, 'B-P 2 144');
    expect(petsciiToText(read(drive, 2, 5).bytes)).toBe('GAMES');
  });

  it('rejects sectors that do not exist', () => {
    const drive = makeDrive();
    open(drive, 2, '#');
    command(drive, 'U1 2 0 40 0');
    expect(status(drive)).toBe('66,ILLEGAL TRACK OR SECTOR,40,00');
  });

  it('refuses writes', () => {
    const drive = makeDrive();
    open(drive, 1, 'NEWFILE');
    expect(status(drive)).toBe('26,WRITE PROTECT ON,00,00');
  });

  it('reports attempts to run code inside the drive', () => {
    const drive = makeDrive();
    const reports: string[] = [];
    drive.onUnsupported = (message) => reports.push(message);
    sendTo(drive, 0x6f, Uint8Array.from([0x4d, 0x2d, 0x45, 0x00, 0x06]));
    command(drive, 'U3');
    command(drive, 'UH');
    expect(reports).toHaveLength(3);
    expect(reports[0]).toMatch(/\$0600/);
    expect(reports[1]).toMatch(/\$0500/);
    expect(reports[2]).toMatch(/\$050F/);
  });

  it('answers M-R with zeros on the command channel', () => {
    const drive = makeDrive();
    sendTo(drive, 0x6f, Uint8Array.from([0x4d, 0x2d, 0x52, 0x00, 0xc0, 0x02]));
    expect(read(drive, 15).bytes).toEqual(new Uint8Array([0, 0]));
  });

  it('closing the command channel closes every channel', () => {
    const drive = makeDrive();
    open(drive, 3, 'GAME');
    sendTo(drive, 0xef, '');
    expect(read(drive, 3).bytes.length).toBe(0);
  });
});
