import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Cpu6510 } from '../src/cpu/cpu6510';
import { FlatBus } from './helpers/flat-bus';

const binPath = join(import.meta.dirname, 'fixtures', 'dormann', '6502_functional_test.bin');
const START = 0x0400;
const SUCCESS_TRAP = 0x3469;
const MAX_INSTRUCTIONS = 100_000_000;

describe.skipIf(!existsSync(binPath))('Klaus Dormann 6502 functional test', () => {
  it('reaches the success trap', () => {
    const bus = new FlatBus();
    bus.load(0, readFileSync(binPath));
    const cpu = new Cpu6510(bus);
    cpu.pc = START;

    for (let i = 0; i < MAX_INSTRUCTIONS; i++) {
      const pc = cpu.pc;
      cpu.step();
      if (cpu.pc === pc) break;
    }
    expect(cpu.pc.toString(16)).toBe(SUCCESS_TRAP.toString(16));
  }, 120_000);
});
