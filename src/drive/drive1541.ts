import { Cpu6510, type CpuBus } from '../cpu/cpu6510';
import { DRIVE_ATNA, PULL_CLK, PULL_DATA, READ_SAMPLE_OFFSET, type IecBus } from '../iec/iec-bus';
import { DiskMechanics } from './disk-mechanics';
import type { GcrDisk } from './gcr';
import { Via6522 } from './via6522';

/** The C64 runs at 985,248 Hz and the drive at 1 MHz; drive time is kept in C64 cycles. */
export const C64_CYCLES_PER_DRIVE_CYCLE = 985_248 / 1_000_000;

const RAM_SIZE = 0x800;
const ROM_SIZE = 0x4000;
const VIA1_BASE = 0x1800;
const VIA2_BASE = 0x1c00;
const ROM_BASE = 0x8000;

// VIA1 port B: serial bus
const VIA1_DATA_IN = 0x01;
const VIA1_DATA_OUT = 0x02;
const VIA1_CLK_IN = 0x04;
const VIA1_CLK_OUT = 0x08;
const VIA1_ATNA = 0x10;
/** PB5/PB6 are the device-number jumpers; both closed (0) selects device 8. */
const VIA1_DEVICE_JUMPERS = 0x60;
const VIA1_ATN_IN = 0x80;

/** A Commodore 1541 disk drive: its own 6502, 2 KB RAM, DOS ROM, two VIAs and the disk mechanics. */
export class Drive1541 {
  readonly cpu: Cpu6510;
  readonly via1: Via6522;
  readonly via2: Via6522;
  readonly mechanics = new DiskMechanics();
  /** Current drive time, in C64 cycles. */
  time = 0;

  private readonly ram = new Uint8Array(RAM_SIZE);
  private readonly rom: Uint8Array;
  private instructionStart = 0;

  constructor(
    rom: Uint8Array,
    private readonly bus: IecBus,
  ) {
    if (rom.length !== ROM_SIZE) throw new Error(`1541 ROM must be ${ROM_SIZE} bytes, got ${rom.length}`);
    this.rom = rom;

    const memory: CpuBus = {
      read: (addr) => this.read(addr),
      write: (addr, value) => this.write(addr, value),
    };
    this.cpu = new Cpu6510(memory);

    this.via1 = new Via6522({
      readPortB: () => this.serialPins(),
      onOutputChange: () => this.publishSerialOutputs(),
    });
    this.via2 = new Via6522({
      readPortA: () => this.mechanics.dataByte,
      readPortB: () => this.mechanics.portBPins,
      onOutputChange: () => this.mechanics.setControl(this.via2.portBOutput),
    });
    this.mechanics.onByteReady = () => {
      this.via2.pulseCa1();
      // CA2 is the "SO enable" line: when high, BYTE READY sets the CPU's overflow flag.
      if (this.via2.ca2High) this.cpu.setOverflow();
    };
    this.reset();
  }

  get motorOn(): boolean {
    return this.mechanics.motorOn;
  }

  get ledOn(): boolean {
    return this.mechanics.ledOn;
  }

  reset(): void {
    this.via1.reset();
    this.via2.reset();
    this.cpu.reset();
  }

  insert(disk: GcrDisk | null): void {
    this.mechanics.insert(disk);
  }

  /**
   * Runs the drive as far as the C64's bus state is known (up to `c64KnownUntil`).
   * An instruction only runs if its bus access lands no later than that, so the
   * drive never acts on serial lines the C64 might still change before then.
   */
  runUntil(c64KnownUntil: number): void {
    for (;;) {
      this.cpu.irqLine = this.via1.irq || this.via2.irq;
      const accessOffset = (this.cpu.nextStepCycles - 1) * C64_CYCLES_PER_DRIVE_CYCLE;
      if (this.time + accessOffset > c64KnownUntil) return;

      this.instructionStart = this.time;
      this.updateAtnInput();
      this.cpu.irqLine = this.via1.irq || this.via2.irq;
      const cycles = this.cpu.step();
      this.via1.tick(cycles);
      this.via2.tick(cycles);
      this.mechanics.tick(cycles);
      this.time += cycles * C64_CYCLES_PER_DRIVE_CYCLE;
    }
  }

  /** The moment, in C64 cycles, of the bus access in the current drive instruction. */
  private get accessTime(): number {
    return this.instructionStart + this.cpu.accessCycle * C64_CYCLES_PER_DRIVE_CYCLE;
  }

  /** ATN from the C64 is wired (inverted) to VIA1 CA1, which interrupts the DOS. */
  private updateAtnInput(): void {
    this.via1.setCa1(this.bus.linesForDrive(this.time).atnLow);
  }

  /** VIA1 port B inputs are inverted: a 1 means the line is pulled low. */
  private serialPins(): number {
    const lines = this.bus.linesForDrive(this.accessTime - READ_SAMPLE_OFFSET);
    let pins = 0xff & ~(VIA1_DATA_IN | VIA1_CLK_IN | VIA1_ATN_IN | VIA1_DEVICE_JUMPERS);
    if (lines.dataLow) pins |= VIA1_DATA_IN;
    if (lines.clkLow) pins |= VIA1_CLK_IN;
    if (lines.atnLow) pins |= VIA1_ATN_IN;
    return pins;
  }

  private publishSerialOutputs(): void {
    const port = this.via1.portBOutput;
    let outputs = 0;
    if (port & VIA1_DATA_OUT) outputs |= PULL_DATA;
    if (port & VIA1_CLK_OUT) outputs |= PULL_CLK;
    if (port & VIA1_ATNA) outputs |= DRIVE_ATNA;
    this.bus.setDriveOutputs(this.accessTime, outputs);
  }

  private read(addr: number): number {
    if (addr >= ROM_BASE) return this.rom[addr & (ROM_SIZE - 1)];
    if (addr < VIA1_BASE) return this.ram[addr & (RAM_SIZE - 1)];
    if (addr < VIA2_BASE) return this.via1.read(addr);
    if (addr < 0x2000) return this.via2.read(addr);
    return addr >> 8;
  }

  private write(addr: number, value: number): void {
    if (addr < VIA1_BASE) this.ram[addr & (RAM_SIZE - 1)] = value;
    else if (addr < VIA2_BASE) this.via1.write(addr, value);
    else if (addr < 0x2000) this.via2.write(addr, value);
  }
}
