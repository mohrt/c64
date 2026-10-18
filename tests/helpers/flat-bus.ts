import type { CpuBus } from '../../src/cpu/cpu6510';

/** 64K of plain RAM, for testing the CPU in isolation. */
export class FlatBus implements CpuBus {
  readonly memory = new Uint8Array(0x10000);

  read(addr: number): number {
    return this.memory[addr];
  }

  write(addr: number, value: number): void {
    this.memory[addr] = value;
  }

  load(addr: number, bytes: ArrayLike<number>): void {
    this.memory.set(bytes, addr);
  }
}
