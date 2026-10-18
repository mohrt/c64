import { describe, expect, it } from 'vitest';
import { Cpu6510 } from '../src/cpu/cpu6510';
import { FlatBus } from './helpers/flat-bus';

function setup(program: number[]) {
  const bus = new FlatBus();
  bus.load(0x0200, program);
  bus.memory[0xfffc] = 0x00;
  bus.memory[0xfffd] = 0x02;
  const cpu = new Cpu6510(bus);
  cpu.reset();
  return { bus, cpu };
}

describe('Cpu6510 undocumented opcodes', () => {
  it('LAX loads A and X', () => {
    const { cpu, bus } = setup([0xa7, 0x10]);
    bus.memory[0x10] = 0x85;
    expect(cpu.step()).toBe(3);
    expect(cpu.a).toBe(0x85);
    expect(cpu.x).toBe(0x85);
    expect(cpu.flagN).toBe(true);
  });

  it('SAX stores A & X without touching flags', () => {
    const { cpu, bus } = setup([0xa9, 0xf0, 0xa2, 0x3c, 0x87, 0x20]);
    cpu.step();
    cpu.step();
    cpu.step();
    expect(bus.memory[0x20]).toBe(0x30);
  });

  it('SLO shifts memory left and ORs it into A', () => {
    const { cpu, bus } = setup([0xa9, 0x01, 0x07, 0x10]);
    bus.memory[0x10] = 0x81;
    cpu.step();
    expect(cpu.step()).toBe(5);
    expect(bus.memory[0x10]).toBe(0x02);
    expect(cpu.a).toBe(0x03);
    expect(cpu.flagC).toBe(true);
  });

  it('DCP decrements memory and compares with A', () => {
    const { cpu, bus } = setup([0xa9, 0x40, 0xc7, 0x10]);
    bus.memory[0x10] = 0x41;
    cpu.step();
    cpu.step();
    expect(bus.memory[0x10]).toBe(0x40);
    expect(cpu.flagZ).toBe(true);
    expect(cpu.flagC).toBe(true);
  });

  it('ISC increments memory and subtracts it from A', () => {
    const { cpu, bus } = setup([0x38, 0xa9, 0x10, 0xe7, 0x10]);
    bus.memory[0x10] = 0x04;
    cpu.step();
    cpu.step();
    cpu.step();
    expect(bus.memory[0x10]).toBe(0x05);
    expect(cpu.a).toBe(0x0b);
  });

  it('RLA, SRE and RRA combine rotates with AND, EOR and ADC', () => {
    const { cpu, bus } = setup([0x18, 0xa9, 0xff, 0x27, 0x10, 0x47, 0x11, 0x18, 0x67, 0x12]);
    bus.memory[0x10] = 0x40;
    bus.memory[0x11] = 0x02;
    bus.memory[0x12] = 0x04;
    cpu.step();
    cpu.step();
    cpu.step(); // RLA: mem 0x80, A = 0xff & 0x80
    expect(cpu.a).toBe(0x80);
    cpu.step(); // SRE: mem 0x01, A = 0x80 ^ 0x01
    expect(cpu.a).toBe(0x81);
    cpu.step();
    cpu.step(); // RRA: mem 0x02, A = 0x81 + 0x02
    expect(bus.memory[0x12]).toBe(0x02);
    expect(cpu.a).toBe(0x83);
  });

  it('ANC, ALR and SBX', () => {
    const { cpu } = setup([0xa9, 0xff, 0x0b, 0x80, 0xa9, 0x07, 0x4b, 0x03, 0xa9, 0x0f, 0xa2, 0x3c, 0xcb, 0x02]);
    cpu.step();
    cpu.step();
    expect(cpu.a).toBe(0x80);
    expect(cpu.flagC).toBe(true);
    cpu.step();
    cpu.step();
    expect(cpu.a).toBe(0x01);
    expect(cpu.flagC).toBe(true);
    cpu.step();
    cpu.step();
    cpu.step();
    expect(cpu.x).toBe(0x0a);
    expect(cpu.flagC).toBe(true);
  });

  it('ARR rotates the AND result and sets C and V from bits 6 and 5', () => {
    const { cpu } = setup([0x38, 0xa9, 0xff, 0x6b, 0xc0]);
    cpu.step();
    cpu.step();
    cpu.step();
    expect(cpu.a).toBe(0xe0);
    expect(cpu.flagC).toBe(true);
    expect(cpu.flagV).toBe(false);
  });

  it('multi-byte NOPs skip their operands with the right timing', () => {
    const { cpu } = setup([0x80, 0xff, 0x04, 0x10, 0x14, 0x10, 0x0c, 0x00, 0x30, 0x1a]);
    expect(cpu.step()).toBe(2);
    expect(cpu.step()).toBe(3);
    expect(cpu.step()).toBe(4);
    expect(cpu.step()).toBe(4);
    expect(cpu.step()).toBe(2);
    expect(cpu.pc).toBe(0x020a);
  });

  it('SHX stores X & (high byte + 1)', () => {
    const { cpu, bus } = setup([0xa2, 0xff, 0xa0, 0x01, 0x9e, 0x00, 0x12]);
    cpu.step();
    cpu.step();
    cpu.step();
    expect(bus.memory[0x1201]).toBe(0x13);
  });

  it('JAM halts the CPU until reset, ignoring interrupts', () => {
    const { cpu } = setup([0x02, 0xea]);
    cpu.step();
    expect(cpu.jammedAt).toBe(0x0200);
    cpu.triggerNmi();
    cpu.step();
    expect(cpu.pc).toBe(0x0200);
    cpu.reset();
    expect(cpu.jammedAt).toBe(-1);
  });
});
