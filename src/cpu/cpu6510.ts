export interface CpuBus {
  read(addr: number): number;
  write(addr: number, value: number): void;
}

const FLAG_C = 0x01;
const FLAG_Z = 0x02;
const FLAG_I = 0x04;
const FLAG_D = 0x08;
const FLAG_B = 0x10;
const FLAG_U = 0x20;
const FLAG_V = 0x40;
const FLAG_N = 0x80;

const VECTOR_NMI = 0xfffa;
const VECTOR_RESET = 0xfffc;
const VECTOR_IRQ = 0xfffe;

const INTERRUPT_CYCLES = 7;
const JAM_CYCLES = 2;
/** Undocumented immediate ops AND with an unstable "magic" constant; $EE matches most chips. */
const UNSTABLE_MAGIC = 0xee;

// Base cycle counts; page-cross and branch penalties are added at runtime.
const CYCLES = new Uint8Array([
  7,6,2,8,3,3,5,5,3,2,2,2,4,4,6,6,
  2,5,2,8,4,4,6,6,2,4,2,7,4,4,7,7,
  6,6,2,8,3,3,5,5,4,2,2,2,4,4,6,6,
  2,5,2,8,4,4,6,6,2,4,2,7,4,4,7,7,
  6,6,2,8,3,3,5,5,3,2,2,2,3,4,6,6,
  2,5,2,8,4,4,6,6,2,4,2,7,4,4,7,7,
  6,6,2,8,3,3,5,5,4,2,2,2,5,4,6,6,
  2,5,2,8,4,4,6,6,2,4,2,7,4,4,7,7,
  2,6,2,6,3,3,3,3,2,2,2,2,4,4,4,4,
  2,6,2,6,4,4,4,4,2,5,2,5,5,5,5,5,
  2,6,2,6,3,3,3,3,2,2,2,2,4,4,4,4,
  2,5,2,5,4,4,4,4,2,4,2,4,4,4,4,4,
  2,6,2,8,3,3,5,5,2,2,2,2,4,4,6,6,
  2,5,2,8,4,4,6,6,2,4,2,7,4,4,7,7,
  2,6,2,8,3,3,5,5,2,2,2,2,4,4,6,6,
  2,5,2,8,4,4,6,6,2,4,2,7,4,4,7,7,
]);

/**
 * NMOS 6502 core as used in the 6510, stepped one instruction at a time.
 * Implements all 256 opcodes, including the undocumented ones games rely on.
 */
export class Cpu6510 {
  a = 0;
  x = 0;
  y = 0;
  sp = 0xfd;
  pc = 0;

  flagC = false;
  flagZ = false;
  flagI = true;
  flagD = false;
  flagV = false;
  flagN = false;

  /** Level-triggered IRQ input, driven by the machine each step. */
  irqLine = false;
  totalCycles = 0;

  /** Address of the JAM opcode that halted the CPU, or -1 while running. Only reset recovers. */
  jammedAt = -1;

  private nmiPending = false;
  private extraCycles = 0;
  private opcode = 0xea;

  constructor(private readonly bus: CpuBus) {}

  reset(): void {
    this.a = 0;
    this.x = 0;
    this.y = 0;
    this.sp = 0xfd;
    this.flagI = true;
    this.flagD = false;
    this.nmiPending = false;
    this.jammedAt = -1;
    this.pc = this.read16(VECTOR_RESET);
  }

  /** Signals a falling edge on the NMI line. */
  triggerNmi(): void {
    this.nmiPending = true;
  }

  /** The SO input pin: a falling edge sets the overflow flag (the 1541 uses it for BYTE READY). */
  setOverflow(): void {
    this.flagV = true;
  }

  /** Base cycles of the next step (without page-cross penalties), without executing it. */
  get nextStepCycles(): number {
    if (this.jammedAt >= 0) return JAM_CYCLES;
    if (this.nmiPending || (this.irqLine && !this.flagI)) return INTERRUPT_CYCLES;
    return CYCLES[this.bus.read(this.pc)];
  }

  /**
   * While an instruction executes, the cycle within it (0-based) at which its
   * data access happens. Reads and writes land on the instruction's last cycle.
   */
  get accessCycle(): number {
    return CYCLES[this.opcode] + this.extraCycles - 1;
  }

  /** Returns from the current subroutine as if RTS had executed (used by KERNAL traps). */
  returnFromSubroutine(): void {
    const lo = this.pull();
    this.pc = ((lo | (this.pull() << 8)) + 1) & 0xffff;
  }

  get status(): number {
    return (
      (this.flagC ? FLAG_C : 0) |
      (this.flagZ ? FLAG_Z : 0) |
      (this.flagI ? FLAG_I : 0) |
      (this.flagD ? FLAG_D : 0) |
      FLAG_U |
      (this.flagV ? FLAG_V : 0) |
      (this.flagN ? FLAG_N : 0)
    );
  }

  set status(p: number) {
    this.flagC = (p & FLAG_C) !== 0;
    this.flagZ = (p & FLAG_Z) !== 0;
    this.flagI = (p & FLAG_I) !== 0;
    this.flagD = (p & FLAG_D) !== 0;
    this.flagV = (p & FLAG_V) !== 0;
    this.flagN = (p & FLAG_N) !== 0;
  }

  /** Executes one instruction (or interrupt entry) and returns the cycles used. */
  step(): number {
    let cycles: number;
    if (this.jammedAt >= 0) {
      cycles = JAM_CYCLES;
    } else if (this.nmiPending) {
      this.nmiPending = false;
      this.interrupt(VECTOR_NMI, false);
      cycles = INTERRUPT_CYCLES;
    } else if (this.irqLine && !this.flagI) {
      this.interrupt(VECTOR_IRQ, false);
      cycles = INTERRUPT_CYCLES;
    } else {
      this.extraCycles = 0;
      const opcode = this.fetch();
      this.opcode = opcode;
      if (this.execute(opcode)) {
        cycles = CYCLES[opcode] + this.extraCycles;
      } else {
        this.pc = (this.pc - 1) & 0xffff;
        this.jammedAt = this.pc;
        cycles = JAM_CYCLES;
      }
    }
    this.totalCycles += cycles;
    return cycles;
  }

  // --- Memory helpers -------------------------------------------------------

  private read16(addr: number): number {
    return this.bus.read(addr) | (this.bus.read((addr + 1) & 0xffff) << 8);
  }

  private fetch(): number {
    const value = this.bus.read(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return value;
  }

  private fetch16(): number {
    const lo = this.fetch();
    return lo | (this.fetch() << 8);
  }

  private push(value: number): void {
    this.bus.write(0x100 | this.sp, value);
    this.sp = (this.sp - 1) & 0xff;
  }

  private pull(): number {
    this.sp = (this.sp + 1) & 0xff;
    return this.bus.read(0x100 | this.sp);
  }

  private interrupt(vector: number, isBrk: boolean): void {
    this.push(this.pc >> 8);
    this.push(this.pc & 0xff);
    this.push(this.status | (isBrk ? FLAG_B : 0));
    this.flagI = true;
    this.pc = this.read16(vector);
  }

  // --- Addressing modes (return effective address) --------------------------

  private zp(): number {
    return this.fetch();
  }

  private zpX(): number {
    return (this.fetch() + this.x) & 0xff;
  }

  private zpY(): number {
    return (this.fetch() + this.y) & 0xff;
  }

  private abs(): number {
    return this.fetch16();
  }

  private indexed(base: number, index: number, pagePenalty: boolean): number {
    const addr = (base + index) & 0xffff;
    if (pagePenalty && (addr & 0xff00) !== (base & 0xff00)) this.extraCycles++;
    return addr;
  }

  private absX(pagePenalty: boolean): number {
    return this.indexed(this.fetch16(), this.x, pagePenalty);
  }

  private absY(pagePenalty: boolean): number {
    return this.indexed(this.fetch16(), this.y, pagePenalty);
  }

  private indX(): number {
    const ptr = (this.fetch() + this.x) & 0xff;
    return this.bus.read(ptr) | (this.bus.read((ptr + 1) & 0xff) << 8);
  }

  private indY(pagePenalty: boolean): number {
    const ptr = this.fetch();
    const base = this.bus.read(ptr) | (this.bus.read((ptr + 1) & 0xff) << 8);
    return this.indexed(base, this.y, pagePenalty);
  }

  // --- Operations -------------------------------------------------------------

  private setNZ(value: number): number {
    this.flagZ = value === 0;
    this.flagN = (value & 0x80) !== 0;
    return value;
  }

  private adc(value: number): void {
    const carry = this.flagC ? 1 : 0;
    if (this.flagD) {
      let lo = (this.a & 0x0f) + (value & 0x0f) + carry;
      if (lo > 9) lo += 6;
      let result =
        lo <= 0x0f
          ? (lo & 0x0f) + (this.a & 0xf0) + (value & 0xf0)
          : (lo & 0x0f) + (this.a & 0xf0) + (value & 0xf0) + 0x10;
      this.flagZ = ((this.a + value + carry) & 0xff) === 0;
      this.flagN = (result & 0x80) !== 0;
      this.flagV = ((this.a ^ result) & 0x80) !== 0 && ((this.a ^ value) & 0x80) === 0;
      if ((result & 0x1f0) > 0x90) result += 0x60;
      this.flagC = (result & 0xff0) > 0xf0;
      this.a = result & 0xff;
    } else {
      const result = this.a + value + carry;
      this.flagV = (~(this.a ^ value) & (this.a ^ result) & 0x80) !== 0;
      this.flagC = result > 0xff;
      this.a = this.setNZ(result & 0xff);
    }
  }

  private sbc(value: number): void {
    const borrow = this.flagC ? 0 : 1;
    const result = this.a - value - borrow;
    this.flagV = ((this.a ^ value) & (this.a ^ result) & 0x80) !== 0;
    this.flagC = result >= 0;
    this.setNZ(result & 0xff);
    if (this.flagD) {
      const lo = (this.a & 0x0f) - (value & 0x0f) - borrow;
      let bcd =
        lo & 0x10
          ? ((lo - 6) & 0x0f) | ((this.a & 0xf0) - (value & 0xf0) - 0x10)
          : (lo & 0x0f) | ((this.a & 0xf0) - (value & 0xf0));
      if (bcd & 0x100) bcd -= 0x60;
      this.a = bcd & 0xff;
    } else {
      this.a = result & 0xff;
    }
  }

  private compare(register: number, value: number): void {
    const result = register - value;
    this.flagC = result >= 0;
    this.setNZ(result & 0xff);
  }

  private bit(value: number): void {
    this.flagZ = (this.a & value) === 0;
    this.flagN = (value & 0x80) !== 0;
    this.flagV = (value & 0x40) !== 0;
  }

  private asl(value: number): number {
    this.flagC = (value & 0x80) !== 0;
    return this.setNZ((value << 1) & 0xff);
  }

  private lsr(value: number): number {
    this.flagC = (value & 0x01) !== 0;
    return this.setNZ(value >> 1);
  }

  private rol(value: number): number {
    const result = ((value << 1) | (this.flagC ? 1 : 0)) & 0xff;
    this.flagC = (value & 0x80) !== 0;
    return this.setNZ(result);
  }

  private ror(value: number): number {
    const result = (value >> 1) | (this.flagC ? 0x80 : 0);
    this.flagC = (value & 0x01) !== 0;
    return this.setNZ(result);
  }

  /** Read-modify-write: the 6502 writes the unmodified value back before the result. */
  private rmw(addr: number, op: (value: number) => number): void {
    const value = this.bus.read(addr);
    this.bus.write(addr, value);
    this.bus.write(addr, op(value));
  }

  private branch(condition: boolean): void {
    const offset = this.fetch();
    if (!condition) return;
    const target = (this.pc + (offset < 0x80 ? offset : offset - 0x100)) & 0xffff;
    this.extraCycles += (target & 0xff00) !== (this.pc & 0xff00) ? 2 : 1;
    this.pc = target;
  }

  private readonly aslOp = (v: number) => this.asl(v);
  private readonly lsrOp = (v: number) => this.lsr(v);
  private readonly rolOp = (v: number) => this.rol(v);
  private readonly rorOp = (v: number) => this.ror(v);
  private readonly incOp = (v: number) => this.setNZ((v + 1) & 0xff);
  private readonly decOp = (v: number) => this.setNZ((v - 1) & 0xff);

  // Undocumented read-modify-write combinations: shift/increment memory, then use the result.
  private readonly sloOp = (v: number) => {
    const r = this.asl(v);
    this.a = this.setNZ(this.a | r);
    return r;
  };
  private readonly rlaOp = (v: number) => {
    const r = this.rol(v);
    this.a = this.setNZ(this.a & r);
    return r;
  };
  private readonly sreOp = (v: number) => {
    const r = this.lsr(v);
    this.a = this.setNZ(this.a ^ r);
    return r;
  };
  private readonly rraOp = (v: number) => {
    const r = this.ror(v);
    this.adc(r);
    return r;
  };
  private readonly dcpOp = (v: number) => {
    const r = (v - 1) & 0xff;
    this.compare(this.a, r);
    return r;
  };
  private readonly iscOp = (v: number) => {
    const r = (v + 1) & 0xff;
    this.sbc(r);
    return r;
  };

  private lax(value: number): void {
    this.a = this.x = this.setNZ(value);
  }

  private arr(value: number): void {
    const t = this.a & value;
    const carryIn = this.flagC ? 0x80 : 0;
    let result = (t >> 1) | carryIn;
    if (!this.flagD) {
      this.setNZ(result);
      this.flagC = (result & 0x40) !== 0;
      this.flagV = (((result >> 6) ^ (result >> 5)) & 1) !== 0;
    } else {
      this.flagN = carryIn !== 0;
      this.flagZ = result === 0;
      this.flagV = ((t ^ result) & 0x40) !== 0;
      if ((t & 0x0f) + (t & 0x01) > 5) result = (result & 0xf0) | ((result + 6) & 0x0f);
      this.flagC = ((t + (t & 0x10)) & 0x1f0) > 0x50;
      if (this.flagC) result += 0x60;
    }
    this.a = result & 0xff;
  }

  /**
   * SHA/SHX/SHY/TAS store `value & (high byte of base + 1)`. When indexing
   * crosses a page, that same value also replaces the target's high byte.
   */
  private storeAndHigh(base: number, index: number, value: number): void {
    const stored = value & (((base >> 8) + 1) & 0xff);
    let addr = (base + index) & 0xffff;
    if ((base & 0xff) + index > 0xff) addr = (addr & 0x00ff) | (stored << 8);
    this.bus.write(addr, stored);
  }

  private indirectBaseY(): number {
    const ptr = this.fetch();
    return this.bus.read(ptr) | (this.bus.read((ptr + 1) & 0xff) << 8);
  }

  /** Returns false for the JAM opcodes, which halt the CPU. */
  private execute(opcode: number): boolean {
    const bus = this.bus;
    switch (opcode) {
      // ORA
      case 0x09: this.a = this.setNZ(this.a | this.fetch()); break;
      case 0x05: this.a = this.setNZ(this.a | bus.read(this.zp())); break;
      case 0x15: this.a = this.setNZ(this.a | bus.read(this.zpX())); break;
      case 0x0d: this.a = this.setNZ(this.a | bus.read(this.abs())); break;
      case 0x1d: this.a = this.setNZ(this.a | bus.read(this.absX(true))); break;
      case 0x19: this.a = this.setNZ(this.a | bus.read(this.absY(true))); break;
      case 0x01: this.a = this.setNZ(this.a | bus.read(this.indX())); break;
      case 0x11: this.a = this.setNZ(this.a | bus.read(this.indY(true))); break;

      // AND
      case 0x29: this.a = this.setNZ(this.a & this.fetch()); break;
      case 0x25: this.a = this.setNZ(this.a & bus.read(this.zp())); break;
      case 0x35: this.a = this.setNZ(this.a & bus.read(this.zpX())); break;
      case 0x2d: this.a = this.setNZ(this.a & bus.read(this.abs())); break;
      case 0x3d: this.a = this.setNZ(this.a & bus.read(this.absX(true))); break;
      case 0x39: this.a = this.setNZ(this.a & bus.read(this.absY(true))); break;
      case 0x21: this.a = this.setNZ(this.a & bus.read(this.indX())); break;
      case 0x31: this.a = this.setNZ(this.a & bus.read(this.indY(true))); break;

      // EOR
      case 0x49: this.a = this.setNZ(this.a ^ this.fetch()); break;
      case 0x45: this.a = this.setNZ(this.a ^ bus.read(this.zp())); break;
      case 0x55: this.a = this.setNZ(this.a ^ bus.read(this.zpX())); break;
      case 0x4d: this.a = this.setNZ(this.a ^ bus.read(this.abs())); break;
      case 0x5d: this.a = this.setNZ(this.a ^ bus.read(this.absX(true))); break;
      case 0x59: this.a = this.setNZ(this.a ^ bus.read(this.absY(true))); break;
      case 0x41: this.a = this.setNZ(this.a ^ bus.read(this.indX())); break;
      case 0x51: this.a = this.setNZ(this.a ^ bus.read(this.indY(true))); break;

      // ADC
      case 0x69: this.adc(this.fetch()); break;
      case 0x65: this.adc(bus.read(this.zp())); break;
      case 0x75: this.adc(bus.read(this.zpX())); break;
      case 0x6d: this.adc(bus.read(this.abs())); break;
      case 0x7d: this.adc(bus.read(this.absX(true))); break;
      case 0x79: this.adc(bus.read(this.absY(true))); break;
      case 0x61: this.adc(bus.read(this.indX())); break;
      case 0x71: this.adc(bus.read(this.indY(true))); break;

      // SBC
      case 0xe9: this.sbc(this.fetch()); break;
      case 0xe5: this.sbc(bus.read(this.zp())); break;
      case 0xf5: this.sbc(bus.read(this.zpX())); break;
      case 0xed: this.sbc(bus.read(this.abs())); break;
      case 0xfd: this.sbc(bus.read(this.absX(true))); break;
      case 0xf9: this.sbc(bus.read(this.absY(true))); break;
      case 0xe1: this.sbc(bus.read(this.indX())); break;
      case 0xf1: this.sbc(bus.read(this.indY(true))); break;

      // CMP / CPX / CPY
      case 0xc9: this.compare(this.a, this.fetch()); break;
      case 0xc5: this.compare(this.a, bus.read(this.zp())); break;
      case 0xd5: this.compare(this.a, bus.read(this.zpX())); break;
      case 0xcd: this.compare(this.a, bus.read(this.abs())); break;
      case 0xdd: this.compare(this.a, bus.read(this.absX(true))); break;
      case 0xd9: this.compare(this.a, bus.read(this.absY(true))); break;
      case 0xc1: this.compare(this.a, bus.read(this.indX())); break;
      case 0xd1: this.compare(this.a, bus.read(this.indY(true))); break;
      case 0xe0: this.compare(this.x, this.fetch()); break;
      case 0xe4: this.compare(this.x, bus.read(this.zp())); break;
      case 0xec: this.compare(this.x, bus.read(this.abs())); break;
      case 0xc0: this.compare(this.y, this.fetch()); break;
      case 0xc4: this.compare(this.y, bus.read(this.zp())); break;
      case 0xcc: this.compare(this.y, bus.read(this.abs())); break;

      // BIT
      case 0x24: this.bit(bus.read(this.zp())); break;
      case 0x2c: this.bit(bus.read(this.abs())); break;

      // LDA / LDX / LDY
      case 0xa9: this.a = this.setNZ(this.fetch()); break;
      case 0xa5: this.a = this.setNZ(bus.read(this.zp())); break;
      case 0xb5: this.a = this.setNZ(bus.read(this.zpX())); break;
      case 0xad: this.a = this.setNZ(bus.read(this.abs())); break;
      case 0xbd: this.a = this.setNZ(bus.read(this.absX(true))); break;
      case 0xb9: this.a = this.setNZ(bus.read(this.absY(true))); break;
      case 0xa1: this.a = this.setNZ(bus.read(this.indX())); break;
      case 0xb1: this.a = this.setNZ(bus.read(this.indY(true))); break;
      case 0xa2: this.x = this.setNZ(this.fetch()); break;
      case 0xa6: this.x = this.setNZ(bus.read(this.zp())); break;
      case 0xb6: this.x = this.setNZ(bus.read(this.zpY())); break;
      case 0xae: this.x = this.setNZ(bus.read(this.abs())); break;
      case 0xbe: this.x = this.setNZ(bus.read(this.absY(true))); break;
      case 0xa0: this.y = this.setNZ(this.fetch()); break;
      case 0xa4: this.y = this.setNZ(bus.read(this.zp())); break;
      case 0xb4: this.y = this.setNZ(bus.read(this.zpX())); break;
      case 0xac: this.y = this.setNZ(bus.read(this.abs())); break;
      case 0xbc: this.y = this.setNZ(bus.read(this.absX(true))); break;

      // STA / STX / STY
      case 0x85: bus.write(this.zp(), this.a); break;
      case 0x95: bus.write(this.zpX(), this.a); break;
      case 0x8d: bus.write(this.abs(), this.a); break;
      case 0x9d: bus.write(this.absX(false), this.a); break;
      case 0x99: bus.write(this.absY(false), this.a); break;
      case 0x81: bus.write(this.indX(), this.a); break;
      case 0x91: bus.write(this.indY(false), this.a); break;
      case 0x86: bus.write(this.zp(), this.x); break;
      case 0x96: bus.write(this.zpY(), this.x); break;
      case 0x8e: bus.write(this.abs(), this.x); break;
      case 0x84: bus.write(this.zp(), this.y); break;
      case 0x94: bus.write(this.zpX(), this.y); break;
      case 0x8c: bus.write(this.abs(), this.y); break;

      // Shifts and rotates
      case 0x0a: this.a = this.asl(this.a); break;
      case 0x06: this.rmw(this.zp(), this.aslOp); break;
      case 0x16: this.rmw(this.zpX(), this.aslOp); break;
      case 0x0e: this.rmw(this.abs(), this.aslOp); break;
      case 0x1e: this.rmw(this.absX(false), this.aslOp); break;
      case 0x4a: this.a = this.lsr(this.a); break;
      case 0x46: this.rmw(this.zp(), this.lsrOp); break;
      case 0x56: this.rmw(this.zpX(), this.lsrOp); break;
      case 0x4e: this.rmw(this.abs(), this.lsrOp); break;
      case 0x5e: this.rmw(this.absX(false), this.lsrOp); break;
      case 0x2a: this.a = this.rol(this.a); break;
      case 0x26: this.rmw(this.zp(), this.rolOp); break;
      case 0x36: this.rmw(this.zpX(), this.rolOp); break;
      case 0x2e: this.rmw(this.abs(), this.rolOp); break;
      case 0x3e: this.rmw(this.absX(false), this.rolOp); break;
      case 0x6a: this.a = this.ror(this.a); break;
      case 0x66: this.rmw(this.zp(), this.rorOp); break;
      case 0x76: this.rmw(this.zpX(), this.rorOp); break;
      case 0x6e: this.rmw(this.abs(), this.rorOp); break;
      case 0x7e: this.rmw(this.absX(false), this.rorOp); break;

      // INC / DEC memory
      case 0xe6: this.rmw(this.zp(), this.incOp); break;
      case 0xf6: this.rmw(this.zpX(), this.incOp); break;
      case 0xee: this.rmw(this.abs(), this.incOp); break;
      case 0xfe: this.rmw(this.absX(false), this.incOp); break;
      case 0xc6: this.rmw(this.zp(), this.decOp); break;
      case 0xd6: this.rmw(this.zpX(), this.decOp); break;
      case 0xce: this.rmw(this.abs(), this.decOp); break;
      case 0xde: this.rmw(this.absX(false), this.decOp); break;

      // Register increments, decrements and transfers
      case 0xe8: this.x = this.setNZ((this.x + 1) & 0xff); break;
      case 0xca: this.x = this.setNZ((this.x - 1) & 0xff); break;
      case 0xc8: this.y = this.setNZ((this.y + 1) & 0xff); break;
      case 0x88: this.y = this.setNZ((this.y - 1) & 0xff); break;
      case 0xaa: this.x = this.setNZ(this.a); break;
      case 0x8a: this.a = this.setNZ(this.x); break;
      case 0xa8: this.y = this.setNZ(this.a); break;
      case 0x98: this.a = this.setNZ(this.y); break;
      case 0xba: this.x = this.setNZ(this.sp); break;
      case 0x9a: this.sp = this.x; break;

      // Stack
      case 0x48: this.push(this.a); break;
      case 0x68: this.a = this.setNZ(this.pull()); break;
      case 0x08: this.push(this.status | FLAG_B); break;
      case 0x28: this.status = this.pull(); break;

      // Flags
      case 0x18: this.flagC = false; break;
      case 0x38: this.flagC = true; break;
      case 0x58: this.flagI = false; break;
      case 0x78: this.flagI = true; break;
      case 0xb8: this.flagV = false; break;
      case 0xd8: this.flagD = false; break;
      case 0xf8: this.flagD = true; break;

      // Branches
      case 0x10: this.branch(!this.flagN); break;
      case 0x30: this.branch(this.flagN); break;
      case 0x50: this.branch(!this.flagV); break;
      case 0x70: this.branch(this.flagV); break;
      case 0x90: this.branch(!this.flagC); break;
      case 0xb0: this.branch(this.flagC); break;
      case 0xd0: this.branch(!this.flagZ); break;
      case 0xf0: this.branch(this.flagZ); break;

      // Jumps, subroutines, interrupts
      case 0x4c: this.pc = this.fetch16(); break;
      case 0x6c: {
        const ptr = this.fetch16();
        // NMOS bug: the high byte is read without carrying into the page.
        const hiAddr = (ptr & 0xff00) | ((ptr + 1) & 0xff);
        this.pc = bus.read(ptr) | (bus.read(hiAddr) << 8);
        break;
      }
      case 0x20: {
        const target = this.fetch16();
        const ret = (this.pc - 1) & 0xffff;
        this.push(ret >> 8);
        this.push(ret & 0xff);
        this.pc = target;
        break;
      }
      case 0x60: {
        const lo = this.pull();
        this.pc = ((lo | (this.pull() << 8)) + 1) & 0xffff;
        break;
      }
      case 0x40: {
        this.status = this.pull();
        const lo = this.pull();
        this.pc = lo | (this.pull() << 8);
        break;
      }
      case 0x00:
        this.pc = (this.pc + 1) & 0xffff;
        this.interrupt(VECTOR_IRQ, true);
        break;

      case 0xea: break;

      // --- Undocumented opcodes ---------------------------------------------

      // NOPs of various lengths (they still perform their operand reads)
      case 0x1a: case 0x3a: case 0x5a: case 0x7a: case 0xda: case 0xfa: break;
      case 0x80: case 0x82: case 0x89: case 0xc2: case 0xe2: this.fetch(); break;
      case 0x04: case 0x44: case 0x64: bus.read(this.zp()); break;
      case 0x14: case 0x34: case 0x54: case 0x74: case 0xd4: case 0xf4: bus.read(this.zpX()); break;
      case 0x0c: bus.read(this.abs()); break;
      case 0x1c: case 0x3c: case 0x5c: case 0x7c: case 0xdc: case 0xfc: bus.read(this.absX(true)); break;

      // SLO: ASL memory, then ORA
      case 0x07: this.rmw(this.zp(), this.sloOp); break;
      case 0x17: this.rmw(this.zpX(), this.sloOp); break;
      case 0x0f: this.rmw(this.abs(), this.sloOp); break;
      case 0x1f: this.rmw(this.absX(false), this.sloOp); break;
      case 0x1b: this.rmw(this.absY(false), this.sloOp); break;
      case 0x03: this.rmw(this.indX(), this.sloOp); break;
      case 0x13: this.rmw(this.indY(false), this.sloOp); break;

      // RLA: ROL memory, then AND
      case 0x27: this.rmw(this.zp(), this.rlaOp); break;
      case 0x37: this.rmw(this.zpX(), this.rlaOp); break;
      case 0x2f: this.rmw(this.abs(), this.rlaOp); break;
      case 0x3f: this.rmw(this.absX(false), this.rlaOp); break;
      case 0x3b: this.rmw(this.absY(false), this.rlaOp); break;
      case 0x23: this.rmw(this.indX(), this.rlaOp); break;
      case 0x33: this.rmw(this.indY(false), this.rlaOp); break;

      // SRE: LSR memory, then EOR
      case 0x47: this.rmw(this.zp(), this.sreOp); break;
      case 0x57: this.rmw(this.zpX(), this.sreOp); break;
      case 0x4f: this.rmw(this.abs(), this.sreOp); break;
      case 0x5f: this.rmw(this.absX(false), this.sreOp); break;
      case 0x5b: this.rmw(this.absY(false), this.sreOp); break;
      case 0x43: this.rmw(this.indX(), this.sreOp); break;
      case 0x53: this.rmw(this.indY(false), this.sreOp); break;

      // RRA: ROR memory, then ADC
      case 0x67: this.rmw(this.zp(), this.rraOp); break;
      case 0x77: this.rmw(this.zpX(), this.rraOp); break;
      case 0x6f: this.rmw(this.abs(), this.rraOp); break;
      case 0x7f: this.rmw(this.absX(false), this.rraOp); break;
      case 0x7b: this.rmw(this.absY(false), this.rraOp); break;
      case 0x63: this.rmw(this.indX(), this.rraOp); break;
      case 0x73: this.rmw(this.indY(false), this.rraOp); break;

      // SAX: store A & X
      case 0x87: bus.write(this.zp(), this.a & this.x); break;
      case 0x97: bus.write(this.zpY(), this.a & this.x); break;
      case 0x8f: bus.write(this.abs(), this.a & this.x); break;
      case 0x83: bus.write(this.indX(), this.a & this.x); break;

      // LAX: load A and X
      case 0xa7: this.lax(bus.read(this.zp())); break;
      case 0xb7: this.lax(bus.read(this.zpY())); break;
      case 0xaf: this.lax(bus.read(this.abs())); break;
      case 0xbf: this.lax(bus.read(this.absY(true))); break;
      case 0xa3: this.lax(bus.read(this.indX())); break;
      case 0xb3: this.lax(bus.read(this.indY(true))); break;

      // DCP: DEC memory, then CMP
      case 0xc7: this.rmw(this.zp(), this.dcpOp); break;
      case 0xd7: this.rmw(this.zpX(), this.dcpOp); break;
      case 0xcf: this.rmw(this.abs(), this.dcpOp); break;
      case 0xdf: this.rmw(this.absX(false), this.dcpOp); break;
      case 0xdb: this.rmw(this.absY(false), this.dcpOp); break;
      case 0xc3: this.rmw(this.indX(), this.dcpOp); break;
      case 0xd3: this.rmw(this.indY(false), this.dcpOp); break;

      // ISC: INC memory, then SBC
      case 0xe7: this.rmw(this.zp(), this.iscOp); break;
      case 0xf7: this.rmw(this.zpX(), this.iscOp); break;
      case 0xef: this.rmw(this.abs(), this.iscOp); break;
      case 0xff: this.rmw(this.absX(false), this.iscOp); break;
      case 0xfb: this.rmw(this.absY(false), this.iscOp); break;
      case 0xe3: this.rmw(this.indX(), this.iscOp); break;
      case 0xf3: this.rmw(this.indY(false), this.iscOp); break;

      // Immediate-mode combinations
      case 0x0b: case 0x2b: // ANC
        this.a = this.setNZ(this.a & this.fetch());
        this.flagC = this.flagN;
        break;
      case 0x4b: this.a = this.lsr(this.a & this.fetch()); break; // ALR
      case 0x6b: this.arr(this.fetch()); break;
      case 0xcb: { // SBX: X = (A & X) - immediate, flags as CMP
        const result = (this.a & this.x) - this.fetch();
        this.flagC = result >= 0;
        this.x = this.setNZ(result & 0xff);
        break;
      }
      case 0xeb: this.sbc(this.fetch()); break;
      case 0x8b: this.a = this.setNZ((this.a | UNSTABLE_MAGIC) & this.x & this.fetch()); break; // ANE
      case 0xab: this.lax((this.a | UNSTABLE_MAGIC) & this.fetch()); break; // LXA

      case 0xbb: { // LAS
        const value = bus.read(this.absY(true)) & this.sp;
        this.a = this.x = this.sp = this.setNZ(value);
        break;
      }

      // Stores that AND with the high address byte + 1
      case 0x9f: this.storeAndHigh(this.fetch16(), this.y, this.a & this.x); break; // SHA abs,Y
      case 0x93: this.storeAndHigh(this.indirectBaseY(), this.y, this.a & this.x); break; // SHA (zp),Y
      case 0x9e: this.storeAndHigh(this.fetch16(), this.y, this.x); break; // SHX
      case 0x9c: this.storeAndHigh(this.fetch16(), this.x, this.y); break; // SHY
      case 0x9b: // TAS
        this.sp = this.a & this.x;
        this.storeAndHigh(this.fetch16(), this.y, this.sp);
        break;

      // JAM: 0x02, 0x12, 0x22, 0x32, 0x42, 0x52, 0x62, 0x72, 0x92, 0xb2, 0xd2, 0xf2
      default:
        return false;
    }
    return true;
  }
}
