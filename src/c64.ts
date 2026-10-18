import type { Cartridge } from './cartridge/cartridge';
import { Cia } from './cia/cia';
import { Cpu6510 } from './cpu/cpu6510';
import { D64Image } from './disk/d64';
import { mediaToD64 } from './disk/d64-builder';
import { IecTraps } from './disk/iec-traps';
import type { DiskMedia } from './disk/media';
import { VirtualDrive } from './disk/virtual-drive';
import { Drive1541 } from './drive/drive1541';
import { GcrDisk } from './drive/gcr';
import { IecBus, PULL_ATN, PULL_CLK, PULL_DATA, READ_SAMPLE_OFFSET } from './iec/iec-bus';
import { ControlPort } from './io/control-port';
import { KeyboardMatrix } from './io/keyboard';
import { Bus, type Roms } from './memory/bus';
import { Sid } from './sid/sid';
import { captureState, restoreState, type StateNode } from './state/snapshot';
import { Vic2 } from './vic/vic2';
import { videoModel, type VideoModel, type VideoModelName } from './vic/video-model';

/**
 * How device 8 is emulated: `accurate` runs a real 1541 (DOS ROM, drive CPU,
 * serial bus), so drive fast loaders work; `fast` answers the KERNAL's serial
 * routines directly from a virtual drive, which is instant but DOS-commands only.
 */
export type DriveMode = 'accurate' | 'fast';

// CIA2 port A serial bus bits
const CIA2_ATN_OUT = 0x08;
const CIA2_CLK_OUT = 0x10;
const CIA2_DATA_OUT = 0x20;
const CIA2_CLK_IN = 0x40;
const CIA2_DATA_IN = 0x80;

/** How far past "now" the C64's serial outputs are certain not to change. */
const C64_STATE_SETTLED_AFTER_STEP = 1;
const C64_STATE_SETTLED_AFTER_READ = 2;

const STATE_VERSION = 1;

/** A complete snapshot of the machine, as produced by `C64.saveState()`. */
export interface MachineState {
  version: number;
  chips: StateNode;
  /** The inserted disk (including what programs wrote to it), if any. */
  disk: { bytes: Uint8Array; writable: boolean } | null;
  /** ROM contents aren't stored, so the same cartridge must be plugged in to load the state. */
  cartridgeName: string | null;
  hasDrive: boolean;
  /** Missing in states saved before NTSC support, which were all PAL. */
  model?: VideoModelName;
}

/**
 * A Commodore 64 (PAL unless switched to NTSC) with a 1541 disk drive (accurate
 * or virtual) as device 8, and no cartridge.
 */
export class C64 {
  readonly bus: Bus;
  readonly cpu: Cpu6510;
  readonly vic: Vic2;
  readonly cia1: Cia;
  readonly cia2: Cia;
  readonly sid: Sid;
  readonly keyboard = new KeyboardMatrix();
  /** The virtual drive used in fast mode. */
  readonly drive = new VirtualDrive();
  /** The real 1541 used in accurate mode; null without a drive ROM. */
  readonly drive1541: Drive1541 | null;
  readonly iecBus = new IecBus();
  /** Control port 1 is wired to CIA1 port B, port 2 to CIA1 port A. */
  readonly port1 = new ControlPort();
  readonly port2 = new ControlPort();
  /** Total C64 cycles since power-on. */
  clock = 0;

  private readonly iecTraps: IecTraps;
  private disk: D64Image | null = null;
  private gcrDisk: GcrDisk | null = null;
  private mode: DriveMode = 'fast';
  private nmiLevel = false;
  private executing = false;

  constructor(roms: Roms, driveRom?: Uint8Array) {
    this.bus = new Bus(roms);
    // The keyboard matrix and the joysticks share CIA1's port lines.
    this.cia1 = new Cia({
      readPortA: () =>
        this.keyboard.readPortA(this.cia1.portBOutput & this.port1.lines) & this.port2.lines,
      readPortB: () =>
        this.keyboard.readPortB(this.cia1.portAOutput & this.port2.lines) & this.port1.lines,
    });
    this.cia2 = new Cia({
      readPortA: () => this.readSerialLines(),
      onOutputChange: () => this.publishSerialOutputs(),
    });
    this.vic = new Vic2({
      read: (addr14) => this.bus.vicRead(this.vicBank, addr14),
      colorRam: this.bus.colorRam,
    });
    this.sid = new Sid(
      () => this.selectedPotPort(),
      () => this.accessTime,
    );
    this.bus.attachIo({ vic: this.vic, sid: this.sid, cia1: this.cia1, cia2: this.cia2 });
    this.cpu = new Cpu6510(this.bus);
    this.iecTraps = new IecTraps(this.cpu, this.bus, this.drive, roms.kernal);
    this.drive1541 = driveRom ? new Drive1541(driveRom, this.iecBus) : null;
    this.setDriveMode(this.drive1541 ? 'accurate' : 'fast');
    this.reset();
  }

  get model(): VideoModel {
    return this.vic.model;
  }

  /** Turns the machine into a PAL or NTSC C64, which resets it (disk and cartridge stay in). */
  setModel(model: VideoModel): void {
    this.vic.setModel(model);
    this.sid.setClockRate(model.clockHz);
    this.drive1541?.setC64ClockRate(model.clockHz);
    this.reset();
  }

  get driveMode(): DriveMode {
    return this.mode;
  }

  setDriveMode(mode: DriveMode): void {
    if (mode === 'accurate' && !this.drive1541) throw new Error('Accurate drive mode needs the 1541 DOS ROM');
    // The virtual drive reads the disk image, so it needs anything the 1541 wrote.
    if (mode === 'fast') this.syncDisk();
    this.mode = mode;
    this.iecBus.driveConnected = mode === 'accurate';
    if (this.drive1541) this.drive1541.time = this.clock;
  }

  /** Whether the drive in use is spinning (used to warp through loading). */
  get driveBusy(): boolean {
    return this.mode === 'accurate' && (this.drive1541?.motorOn ?? false);
  }

  get driveLed(): boolean {
    return this.mode === 'accurate' && (this.drive1541?.ledOn ?? false);
  }

  /** Plugs in a cartridge (or removes it with null) and resets, as you would on a real C64. */
  insertCartridge(cartridge: Cartridge | null): void {
    this.bus.setCartridge(cartridge);
    this.reset();
  }

  /**
   * Inserts a disk into drive 8, or ejects it when given null. Writable disks
   * accept saves from programs on the 1541 (accurate mode).
   */
  insertDisk(media: DiskMedia | null, options: { writable?: boolean } = {}): void {
    const image = media ? mediaToD64(media) : null;
    this.disk = image;
    this.drive.insert(image);
    this.gcrDisk = image ? GcrDisk.fromD64(image) : null;
    if (this.gcrDisk) this.gcrDisk.writeProtected = !options.writable;
    this.drive1541?.insert(this.gcrDisk);
  }

  /** The inserted disk, including everything the drive has written to it. */
  get diskImage(): D64Image | null {
    this.syncDisk();
    return this.disk;
  }

  saveState(): MachineState {
    this.syncDisk();
    return {
      version: STATE_VERSION,
      chips: captureState(this),
      disk: this.disk ? { bytes: this.disk.bytes, writable: !(this.gcrDisk?.writeProtected ?? true) } : null,
      cartridgeName: this.bus.cartridgeName,
      hasDrive: this.drive1541 !== null,
      model: this.model.name,
    };
  }

  /** Restores a snapshot. Throws if it needs a cartridge or drive this machine doesn't have. */
  loadState(state: MachineState): void {
    if (state.version !== STATE_VERSION) throw new Error('This save state was made by a different version.');
    if (state.cartridgeName !== this.bus.cartridgeName) {
      throw new Error(
        state.cartridgeName
          ? `This save state needs the cartridge "${state.cartridgeName}" plugged in.`
          : 'Remove the cartridge to load this save state.',
      );
    }
    if (state.hasDrive && !this.drive1541) throw new Error('This save state needs the 1541 drive ROM.');
    const model = videoModel(state.model ?? 'pal');
    if (model !== this.model) this.setModel(model);
    this.insertDisk(state.disk ? new D64Image(state.disk.bytes.slice()) : null, { writable: state.disk?.writable });
    restoreState(this, state.chips);
  }

  /** Copies sectors the 1541 has written back into the disk image; true if anything changed. */
  syncDisk(): boolean {
    if (!this.disk || !this.gcrDisk?.modified) return false;
    this.gcrDisk.writeChangesTo(this.disk);
    return true;
  }

  /** The 16K bank the VIC-II sees, selected by the inverted low bits of CIA2 port A. */
  private get vicBank(): number {
    return ~this.cia2.portAOutput & 0x03;
  }

  /** CIA1 port A bits 6-7 switch the SID's paddle inputs to port 1 (%01) or port 2 (%10). */
  private selectedPotPort(): ControlPort | null {
    switch (this.cia1.portAOutput >> 6) {
      case 0b01:
        return this.port1;
      case 0b10:
        return this.port2;
      default:
        return null;
    }
  }

  /** The moment (in C64 cycles) of the current instruction's bus access. */
  private get accessTime(): number {
    return this.executing ? this.clock + this.cpu.accessCycle : this.clock;
  }

  /** CIA2 bits 6-7 read the CLK and DATA lines; in accurate mode the drive catches up first. */
  private readSerialLines(): number {
    const time = this.accessTime;
    // This instruction writes nothing after its read, and the next one can't write
    // before time + 3, so the drive may safely run a little past the read.
    if (this.mode === 'accurate') this.drive1541?.runUntil(time + C64_STATE_SETTLED_AFTER_READ);
    const lines = this.iecBus.linesForC64(time - READ_SAMPLE_OFFSET);
    return 0xff & ~((lines.clkLow ? CIA2_CLK_IN : 0) | (lines.dataLow ? CIA2_DATA_IN : 0));
  }

  /** CIA2 bits 3-5 drive ATN, CLK and DATA through inverters: a 1 pulls the line low. */
  private publishSerialOutputs(): void {
    const port = this.cia2.portAOutput;
    let pulls = 0;
    if (port & CIA2_ATN_OUT) pulls |= PULL_ATN;
    if (port & CIA2_CLK_OUT) pulls |= PULL_CLK;
    if (port & CIA2_DATA_OUT) pulls |= PULL_DATA;
    this.iecBus.setC64Pulls(this.accessTime, pulls);
  }

  /** Resets the computer; the reset line also resets the drive on the serial bus. */
  reset(): void {
    this.bus.reset();
    this.vic.reset();
    this.cia1.reset();
    this.cia2.reset();
    this.sid.reset();
    this.keyboard.releaseAll();
    this.drive.reset();
    this.drive1541?.reset();
    this.nmiLevel = false;
    this.cpu.reset();
  }

  /** The RESTORE key is wired straight to the CPU's NMI line. */
  pressRestore(): void {
    this.cpu.triggerNmi();
  }

  /** Executes one CPU instruction (or trapped KERNAL routine) and advances the chips to match. */
  step(): number {
    const pc = this.cpu.pc;
    this.executing = true;
    let cycles =
      this.mode === 'fast' && this.iecTraps.shouldTrap(pc) ? this.iecTraps.run(pc) : this.cpu.step();
    this.executing = false;
    this.advanceChips(cycles);

    // The VIC-II halts the CPU while it fetches character pointers and sprite data.
    for (let stalled = this.vic.takeStalledCycles(); stalled > 0; stalled = this.vic.takeStalledCycles()) {
      this.advanceChips(stalled);
      cycles += stalled;
    }

    this.clock += cycles;
    // The next instruction's earliest possible write is two cycles in.
    if (this.mode === 'accurate') this.drive1541?.runUntil(this.clock + C64_STATE_SETTLED_AFTER_STEP);

    this.cpu.irqLine = this.vic.irq || this.cia1.interrupt;
    const nmi = this.cia2.interrupt;
    if (nmi && !this.nmiLevel) this.cpu.triggerNmi();
    this.nmiLevel = nmi;
    return cycles;
  }

  private advanceChips(cycles: number): void {
    this.vic.tick(cycles);
    this.cia1.tick(cycles);
    this.cia2.tick(cycles);
  }

  /** Brings the SID up to date and returns the audio it produced since the last call. */
  takeAudioSamples(): Float32Array {
    this.sid.catchUp(this.clock);
    return this.sid.takeSamples();
  }

  /** Runs for at least `budget` cycles and returns the number actually executed. */
  runCycles(budget: number): number {
    let executed = 0;
    while (executed < budget) executed += this.step();
    return executed;
  }

  /** Runs until the VIC-II finishes the current frame. */
  runFrame(): void {
    const frame = this.vic.frameCount;
    while (this.vic.frameCount === frame) this.step();
  }
}
