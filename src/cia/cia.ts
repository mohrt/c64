import type { IoDevice } from '../memory/bus';

const REG_PRA = 0x0;
const REG_PRB = 0x1;
const REG_DDRA = 0x2;
const REG_DDRB = 0x3;
const REG_TA_LO = 0x4;
const REG_TA_HI = 0x5;
const REG_TB_LO = 0x6;
const REG_TB_HI = 0x7;
const REG_ICR = 0xd;
const REG_CRA = 0xe;
const REG_CRB = 0xf;

const ICR_TIMER_A = 0x01;
const ICR_TIMER_B = 0x02;
const ICR_SET = 0x80;

const CR_START = 0x01;
const CR_ONE_SHOT = 0x08;
const CR_FORCE_LOAD = 0x10;
const CRA_COUNT_CNT = 0x20;
const CRB_INPUT_MODE = 0x60;
const CRB_COUNT_PHI2 = 0x00;
const CRB_COUNT_TIMER_A = 0x40;

class Timer {
  counter = 0xffff;
  latch = 0xffff;
  control = 0;

  get running(): boolean {
    return (this.control & CR_START) !== 0;
  }

  setLatchLow(value: number): void {
    this.latch = (this.latch & 0xff00) | value;
  }

  setLatchHigh(value: number): void {
    this.latch = (this.latch & 0x00ff) | (value << 8);
    if (!this.running) this.counter = this.latch;
  }

  writeControl(value: number): void {
    if (value & CR_FORCE_LOAD) this.counter = this.latch;
    this.control = value & ~CR_FORCE_LOAD;
  }

  /** Counts down by `ticks` and returns how many times the timer underflowed. */
  countDown(ticks: number): number {
    this.counter -= ticks;
    if (this.counter >= 0) return 0;

    const overshoot = -this.counter - 1;
    if (this.control & CR_ONE_SHOT) {
      this.control &= ~CR_START;
      this.counter = this.latch;
      return 1;
    }
    const period = this.latch + 1;
    this.counter = this.latch - (overshoot % period);
    return 1 + Math.floor(overshoot / period);
  }
}

export interface CiaPorts {
  /** External pin levels for port A; lines not pulled low should read 1. */
  readPortA?: () => number;
  readPortB?: () => number;
  /** Called after a write that may have changed the port outputs. */
  onOutputChange?: () => void;
}

/**
 * MOS 6526 Complex Interface Adapter. Implements both timers, the interrupt
 * control register and the two parallel ports. The time-of-day clock and
 * serial port registers simply hold the last value written.
 */
export class Cia implements IoDevice {
  /** Interrupt output (IRQ for CIA1, NMI for CIA2). */
  interrupt = false;

  private pra = 0;
  private prb = 0;
  private ddra = 0;
  private ddrb = 0;
  private readonly timerA = new Timer();
  private readonly timerB = new Timer();
  private icrFlags = 0;
  private icrMask = 0;
  private readonly otherRegisters = new Uint8Array(16);

  constructor(private readonly ports: CiaPorts = {}) {}

  reset(): void {
    this.pra = this.prb = this.ddra = this.ddrb = 0;
    this.timerA.counter = this.timerA.latch = 0xffff;
    this.timerB.counter = this.timerB.latch = 0xffff;
    this.timerA.control = this.timerB.control = 0;
    this.icrFlags = this.icrMask = 0;
    this.interrupt = false;
    this.otherRegisters.fill(0);
    this.ports.onOutputChange?.();
  }

  /** Port A levels as driven by the CIA (input lines float high). */
  get portAOutput(): number {
    return (this.pra | ~this.ddra) & 0xff;
  }

  get portBOutput(): number {
    return (this.prb | ~this.ddrb) & 0xff;
  }

  tick(cycles: number): void {
    let timerAUnderflows = 0;
    if (this.timerA.running && !(this.timerA.control & CRA_COUNT_CNT)) {
      timerAUnderflows = this.timerA.countDown(cycles);
      if (timerAUnderflows) this.raise(ICR_TIMER_A);
    }

    if (this.timerB.running) {
      const mode = this.timerB.control & CRB_INPUT_MODE;
      let ticks = 0;
      if (mode === CRB_COUNT_PHI2) ticks = cycles;
      else if (mode & CRB_COUNT_TIMER_A) ticks = timerAUnderflows;
      if (ticks && this.timerB.countDown(ticks)) this.raise(ICR_TIMER_B);
    }
  }

  read(register: number): number {
    switch (register) {
      case REG_PRA:
        return this.portAOutput & (this.ports.readPortA?.() ?? 0xff);
      case REG_PRB:
        return this.portBOutput & (this.ports.readPortB?.() ?? 0xff);
      case REG_DDRA:
        return this.ddra;
      case REG_DDRB:
        return this.ddrb;
      case REG_TA_LO:
        return this.timerA.counter & 0xff;
      case REG_TA_HI:
        return this.timerA.counter >> 8;
      case REG_TB_LO:
        return this.timerB.counter & 0xff;
      case REG_TB_HI:
        return this.timerB.counter >> 8;
      case REG_ICR: {
        const value = this.icrFlags | (this.interrupt ? ICR_SET : 0);
        this.icrFlags = 0;
        this.interrupt = false;
        return value;
      }
      case REG_CRA:
        return this.timerA.control;
      case REG_CRB:
        return this.timerB.control;
      default:
        return this.otherRegisters[register];
    }
  }

  write(register: number, value: number): void {
    switch (register) {
      case REG_PRA:
        this.pra = value;
        this.ports.onOutputChange?.();
        break;
      case REG_PRB:
        this.prb = value;
        this.ports.onOutputChange?.();
        break;
      case REG_DDRA:
        this.ddra = value;
        this.ports.onOutputChange?.();
        break;
      case REG_DDRB:
        this.ddrb = value;
        this.ports.onOutputChange?.();
        break;
      case REG_TA_LO:
        this.timerA.setLatchLow(value);
        break;
      case REG_TA_HI:
        this.timerA.setLatchHigh(value);
        break;
      case REG_TB_LO:
        this.timerB.setLatchLow(value);
        break;
      case REG_TB_HI:
        this.timerB.setLatchHigh(value);
        break;
      case REG_ICR:
        if (value & ICR_SET) this.icrMask |= value & 0x1f;
        else this.icrMask &= ~value & 0x1f;
        this.updateInterrupt();
        break;
      case REG_CRA:
        this.timerA.writeControl(value);
        break;
      case REG_CRB:
        this.timerB.writeControl(value);
        break;
      default:
        this.otherRegisters[register] = value;
    }
  }

  private raise(flag: number): void {
    this.icrFlags |= flag;
    this.updateInterrupt();
  }

  private updateInterrupt(): void {
    // Once asserted, the line stays active until the ICR is read.
    if (this.icrFlags & this.icrMask) this.interrupt = true;
  }
}
