import type { Cpu6510 } from '../cpu/cpu6510';
import type { Bus } from '../memory/bus';
import type { VirtualDrive } from './virtual-drive';

/** KERNAL I/O status byte (ST). */
const STATUS = 0x90;
const STATUS_READ_TIMEOUT = 0x02;
const STATUS_EOI = 0x40;
const STATUS_DEVICE_NOT_PRESENT = 0x80;

const KERNAL_BASE = 0xe000;
const JMP_ABSOLUTE = 0x4c;
/** Roughly what the CPU would spend in the real routine; keeps the chips ticking. */
const TRAP_CYCLES = 40;

/** Jump-table entries for the serial bus primitives that every disk access goes through. */
const SERIAL_JUMP_TABLE = {
  second: 0xff93,
  tksa: 0xff96,
  acptr: 0xffa5,
  ciout: 0xffa8,
  untlk: 0xffab,
  unlsn: 0xffae,
  listen: 0xffb1,
  talk: 0xffb4,
} as const;

type Primitive = keyof typeof SERIAL_JUMP_TABLE;

/**
 * Replaces the KERNAL's serial bus routines with calls into the virtual drive.
 * Each routine's real address is read from the jump table of the loaded
 * KERNAL, so both outside programs and the KERNAL's own LOAD/OPEN/CHRIN paths
 * are intercepted. Traps only fire while the KERNAL ROM is banked in.
 */
export class IecTraps {
  private readonly handlers = new Map<number, () => void>();
  private readonly isTrapAddress = new Uint8Array(0x10000);
  private driveAddressed = false;

  constructor(
    private readonly cpu: Cpu6510,
    private readonly bus: Bus,
    private readonly drive: VirtualDrive,
    kernal: Uint8Array,
  ) {
    const actions: Record<Primitive, () => void> = {
      listen: () => this.address(() => this.drive.listen()),
      talk: () => this.address(() => this.drive.talk()),
      second: () => this.driveAddressed && this.drive.secondaryAfterListen(this.cpu.a),
      tksa: () => this.driveAddressed && this.drive.secondaryAfterTalk(this.cpu.a),
      ciout: () => this.driveAddressed && this.drive.receive(this.cpu.a),
      acptr: () => this.receiveByte(),
      unlsn: () => this.drive.unlisten(),
      untlk: () => this.drive.untalk(),
    };

    for (const [name, entry] of Object.entries(SERIAL_JUMP_TABLE) as [Primitive, number][]) {
      const offset = entry - KERNAL_BASE;
      if (kernal[offset] !== JMP_ABSOLUTE) continue;
      const target = kernal[offset + 1] | (kernal[offset + 2] << 8);
      this.handlers.set(target, actions[name]);
      this.isTrapAddress[target] = 1;
    }
  }

  /** True when executing `pc` would enter a trapped KERNAL routine. */
  shouldTrap(pc: number): boolean {
    return this.isTrapAddress[pc] === 1 && this.bus.kernalVisible;
  }

  /** Performs the routine at `pc`, returns to its caller, and reports the cycles used. */
  run(pc: number): number {
    this.handlers.get(pc)?.();
    this.cpu.flagC = false;
    this.cpu.returnFromSubroutine();
    return TRAP_CYCLES;
  }

  /** LISTEN and TALK take the device number in A. */
  private address(select: () => void): void {
    this.driveAddressed = (this.cpu.a & 0x1f) === this.drive.deviceNumber;
    if (this.driveAddressed) select();
    else this.setStatus(STATUS_DEVICE_NOT_PRESENT);
  }

  private receiveByte(): void {
    const next = this.driveAddressed ? this.drive.send() : null;
    if (!next) {
      this.cpu.a = 0;
      this.setStatus(STATUS_READ_TIMEOUT | STATUS_EOI);
      return;
    }
    this.cpu.a = next.value;
    this.cpu.flagZ = next.value === 0;
    this.cpu.flagN = (next.value & 0x80) !== 0;
    if (next.eoi) this.setStatus(STATUS_EOI);
  }

  private setStatus(bits: number): void {
    this.bus.ram[STATUS] |= bits;
  }
}
