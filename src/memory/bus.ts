import type { Cartridge } from '../cartridge/cartridge';
import type { CpuBus } from '../cpu/cpu6510';

export interface Roms {
  basic: Uint8Array;
  kernal: Uint8Array;
  chargen: Uint8Array;
}

/** A chip whose registers are mapped into the I/O area. */
export interface IoDevice {
  read(register: number): number;
  write(register: number, value: number): void;
}

export interface IoDevices {
  vic: IoDevice;
  sid: IoDevice;
  cia1: IoDevice;
  cia2: IoDevice;
}

const LORAM = 0x01;
const HIRAM = 0x02;
const CHAREN = 0x04;

/** Processor port bits that read back as 1 when configured as inputs (pull-ups, no datasette). */
const PORT_INPUT_PULLUPS = 0x17;
const OPEN_BUS = 0xff;

/** What answers in each 4K page of the CPU's address space. */
const enum Region {
  Ram,
  Basic,
  Kernal,
  CharRom,
  Io,
  RomL,
  RomH,
  /** Ultimax mode leaves most of the map unconnected. */
  Open,
}

/**
 * The CPU's view of memory: 64K RAM with BASIC, KERNAL, CHARGEN, I/O and an
 * optional cartridge, banked in by the 6510 processor port at $00/$01 and the
 * cartridge's EXROM/GAME lines (the PLA's job on a real C64).
 */
export class Bus implements CpuBus {
  readonly ram = new Uint8Array(0x10000);
  readonly colorRam = new Uint8Array(0x400);

  private portDirection = 0;
  private portData = 0;
  private readonly pages = new Uint8Array(16);
  private ultimax = false;
  private io: IoDevices | null = null;
  private cartridge: Cartridge | null = null;

  constructor(readonly roms: Roms) {
    this.updateBanking();
  }

  get kernalVisible(): boolean {
    return this.pages[0xe] === Region.Kernal;
  }

  get cartridgeName(): string | null {
    return this.cartridge?.name ?? null;
  }

  get basicVisible(): boolean {
    return this.pages[0xa] === Region.Basic;
  }

  attachIo(devices: IoDevices): void {
    this.io = devices;
  }

  /** Plugs in (or with null, removes) a cartridge. The machine should be reset afterwards. */
  setCartridge(cartridge: Cartridge | null): void {
    this.cartridge = cartridge;
    if (cartridge) cartridge.onLinesChanged = () => this.updateBanking();
    this.updateBanking();
  }

  reset(): void {
    this.portDirection = 0;
    this.portData = 0;
    this.cartridge?.reset();
    this.updateBanking();
  }

  /**
   * Memory as seen by the VIC-II: RAM in the selected 16K bank, with the
   * character ROM at $1000-$1FFF of banks 0 and 2. In Ultimax mode the
   * cartridge's ROMH replaces $3000-$3FFF of every bank instead.
   */
  vicRead(bank: number, addr14: number): number {
    if (this.ultimax) {
      if ((addr14 & 0x3000) === 0x3000) return this.cartridge!.readRomH(0x1000 | (addr14 & 0x0fff));
    } else if ((bank & 1) === 0 && (addr14 & 0x3000) === 0x1000) {
      return this.roms.chargen[addr14 & 0x0fff];
    }
    return this.ram[(bank << 14) | addr14];
  }

  read(addr: number): number {
    if (addr < 2) {
      return addr === 0 ? this.portDirection : this.readPort();
    }
    switch (this.pages[addr >> 12]) {
      case Region.Ram:
        return this.ram[addr];
      case Region.Basic:
        return this.roms.basic[addr & 0x1fff];
      case Region.Kernal:
        return this.roms.kernal[addr & 0x1fff];
      case Region.CharRom:
        return this.roms.chargen[addr & 0x0fff];
      case Region.Io:
        return this.readIo(addr);
      case Region.RomL:
        return this.cartridge!.readRomL(addr & 0x1fff);
      case Region.RomH:
        return this.cartridge!.readRomH(addr & 0x1fff);
      default:
        return OPEN_BUS;
    }
  }

  write(addr: number, value: number): void {
    if (addr < 2) {
      if (addr === 0) this.portDirection = value;
      else this.portData = value;
      this.updateBanking();
      return;
    }
    const region = this.pages[addr >> 12];
    if (region === Region.Io) {
      this.writeIo(addr, value);
    } else if (region !== Region.Open && !(this.ultimax && (region === Region.RomL || region === Region.RomH))) {
      // Writes to ROM areas land in the RAM underneath, except in Ultimax mode.
      this.ram[addr] = value;
    }
  }

  private readPort(): number {
    return (this.portData & this.portDirection) | (PORT_INPUT_PULLUPS & ~this.portDirection);
  }

  private updateBanking(): void {
    const lines = (this.portData | ~this.portDirection) & 0x07;
    const loram = (lines & LORAM) !== 0;
    const hiram = (lines & HIRAM) !== 0;
    const charen = (lines & CHAREN) !== 0;
    const exrom = this.cartridge?.exrom ?? false;
    const game = this.cartridge?.game ?? false;
    const pages = this.pages;

    this.ultimax = game && !exrom;
    if (this.ultimax) {
      pages.fill(Region.Open);
      pages[0x0] = Region.Ram;
      pages[0x8] = pages[0x9] = Region.RomL;
      pages[0xd] = Region.Io;
      pages[0xe] = pages[0xf] = Region.RomH;
      return;
    }

    pages.fill(Region.Ram);
    if (exrom && loram && hiram) pages[0x8] = pages[0x9] = Region.RomL;
    if (exrom && game) {
      if (hiram) pages[0xa] = pages[0xb] = Region.RomH;
    } else if (loram && hiram) {
      pages[0xa] = pages[0xb] = Region.Basic;
    }
    if (loram || hiram) pages[0xd] = charen ? Region.Io : Region.CharRom;
    if (hiram) pages[0xe] = pages[0xf] = Region.Kernal;
  }

  private readIo(addr: number): number {
    const io = this.io;
    if (!io) return OPEN_BUS;
    switch ((addr >> 8) & 0x0f) {
      case 0x0: case 0x1: case 0x2: case 0x3:
        return io.vic.read(addr & 0x3f);
      case 0x4: case 0x5: case 0x6: case 0x7:
        return io.sid.read(addr & 0x1f);
      case 0x8: case 0x9: case 0xa: case 0xb:
        return this.colorRam[addr & 0x3ff] | 0xf0;
      case 0xc:
        return io.cia1.read(addr & 0x0f);
      case 0xd:
        return io.cia2.read(addr & 0x0f);
      case 0xe:
        return this.cartridge?.readIo1(addr & 0xff) ?? OPEN_BUS;
      default:
        return this.cartridge?.readIo2(addr & 0xff) ?? OPEN_BUS;
    }
  }

  private writeIo(addr: number, value: number): void {
    const io = this.io;
    if (!io) return;
    switch ((addr >> 8) & 0x0f) {
      case 0x0: case 0x1: case 0x2: case 0x3:
        io.vic.write(addr & 0x3f, value);
        break;
      case 0x4: case 0x5: case 0x6: case 0x7:
        io.sid.write(addr & 0x1f, value);
        break;
      case 0x8: case 0x9: case 0xa: case 0xb:
        this.colorRam[addr & 0x3ff] = value & 0x0f;
        break;
      case 0xc:
        io.cia1.write(addr & 0x0f, value);
        break;
      case 0xd:
        io.cia2.write(addr & 0x0f, value);
        break;
      case 0xe:
        this.cartridge?.writeIo1(addr & 0xff, value);
        break;
      default:
        this.cartridge?.writeIo2(addr & 0xff, value);
    }
  }
}
