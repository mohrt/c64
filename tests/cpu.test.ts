import { describe, expect, it } from 'vitest';
import { Cpu6510 } from '../src/cpu/cpu6510';
import { FlatBus } from './helpers/flat-bus';

function setup(program: number[], origin = 0x0200) {
  const bus = new FlatBus();
  bus.load(origin, program);
  bus.memory[0xfffc] = origin & 0xff;
  bus.memory[0xfffd] = origin >> 8;
  const cpu = new Cpu6510(bus);
  cpu.reset();
  return { bus, cpu };
}

describe('Cpu6510', () => {
  it('starts at the reset vector with interrupts disabled', () => {
    const { cpu } = setup([0xea], 0x1234);
    expect(cpu.pc).toBe(0x1234);
    expect(cpu.flagI).toBe(true);
    expect(cpu.sp).toBe(0xfd);
  });

  it('LDA immediate sets Z and N', () => {
    const { cpu } = setup([0xa9, 0x00, 0xa9, 0x80]);
    expect(cpu.step()).toBe(2);
    expect(cpu.flagZ).toBe(true);
    cpu.step();
    expect(cpu.a).toBe(0x80);
    expect(cpu.flagN).toBe(true);
    expect(cpu.flagZ).toBe(false);
  });

  it('ADC binary sets carry and overflow', () => {
    const { cpu } = setup([0x18, 0xa9, 0x7f, 0x69, 0x01, 0xa9, 0xff, 0x69, 0x01]);
    cpu.step();
    cpu.step();
    cpu.step();
    expect(cpu.a).toBe(0x80);
    expect(cpu.flagV).toBe(true);
    expect(cpu.flagC).toBe(false);
    cpu.step();
    cpu.step();
    expect(cpu.a).toBe(0x00);
    expect(cpu.flagC).toBe(true);
    expect(cpu.flagZ).toBe(true);
  });

  it('ADC and SBC in decimal mode', () => {
    // SED; CLC; LDA #$19; ADC #$28 -> $47; SEC; SBC #$48 -> $99 with borrow
    const { cpu } = setup([0xf8, 0x18, 0xa9, 0x19, 0x69, 0x28, 0x38, 0xe9, 0x48]);
    for (let i = 0; i < 4; i++) cpu.step();
    expect(cpu.a).toBe(0x47);
    expect(cpu.flagC).toBe(false);
    cpu.step();
    cpu.step();
    expect(cpu.a).toBe(0x99);
    expect(cpu.flagC).toBe(false);
  });

  it('adds a cycle when absolute,X crosses a page', () => {
    const { cpu } = setup([0xa2, 0x01, 0xbd, 0xff, 0x10, 0xbd, 0x00, 0x10]);
    cpu.step();
    expect(cpu.step()).toBe(5);
    expect(cpu.step()).toBe(4);
  });

  it('charges branch cycles for taken and page-crossing branches', () => {
    // LDA #0; BNE (not taken); BEQ +2 (taken, same page); then a page-crossing BEQ.
    const { cpu, bus } = setup([0xa9, 0x00, 0xd0, 0x10, 0xf0, 0x02], 0x0200);
    cpu.step();
    expect(cpu.step()).toBe(2);
    expect(cpu.step()).toBe(3);
    expect(cpu.pc).toBe(0x0208);

    bus.load(0x02fc, [0xf0, 0x10]);
    cpu.pc = 0x02fc;
    expect(cpu.step()).toBe(4);
    expect(cpu.pc).toBe(0x030e);
  });

  it('JMP indirect wraps within the page', () => {
    const { cpu, bus } = setup([0x6c, 0xff, 0x30]);
    bus.memory[0x30ff] = 0x34;
    bus.memory[0x3000] = 0x12;
    bus.memory[0x3100] = 0x99;
    cpu.step();
    expect(cpu.pc).toBe(0x1234);
  });

  it('JSR and RTS round-trip through the stack', () => {
    const { cpu, bus } = setup([0x20, 0x00, 0x03, 0xea]);
    bus.memory[0x0300] = 0x60;
    expect(cpu.step()).toBe(6);
    expect(cpu.pc).toBe(0x0300);
    expect(cpu.sp).toBe(0xfb);
    expect(cpu.step()).toBe(6);
    expect(cpu.pc).toBe(0x0203);
    expect(cpu.sp).toBe(0xfd);
  });

  it('services IRQ only when I is clear, and RTI restores state', () => {
    const { cpu, bus } = setup([0x58, 0xea, 0xea]);
    bus.memory[0xfffe] = 0x00;
    bus.memory[0xffff] = 0x40;
    bus.memory[0x4000] = 0x40; // RTI
    cpu.irqLine = true;
    cpu.step(); // CLI runs because I was set
    expect(cpu.pc).toBe(0x0201);
    expect(cpu.step()).toBe(7);
    expect(cpu.pc).toBe(0x4000);
    expect(cpu.flagI).toBe(true);
    expect(bus.memory[0x01fb] & 0x10).toBe(0);
    cpu.irqLine = false;
    cpu.step();
    expect(cpu.pc).toBe(0x0201);
    expect(cpu.flagI).toBe(false);
  });

  it('BRK pushes the B flag and skips the padding byte', () => {
    const { cpu, bus } = setup([0x00, 0xff, 0xea]);
    bus.memory[0xfffe] = 0x00;
    bus.memory[0xffff] = 0x50;
    expect(cpu.step()).toBe(7);
    expect(cpu.pc).toBe(0x5000);
    expect(bus.memory[0x01fb] & 0x10).toBe(0x10);
    expect(bus.memory[0x01fc]).toBe(0x02);
    expect(bus.memory[0x01fd]).toBe(0x02);
  });

  it('NMI is taken even with interrupts disabled', () => {
    const { cpu, bus } = setup([0xea]);
    bus.memory[0xfffa] = 0x00;
    bus.memory[0xfffb] = 0x60;
    cpu.triggerNmi();
    cpu.step();
    expect(cpu.pc).toBe(0x6000);
  });

  it('read-modify-write writes the old value before the new one', () => {
    const writes: number[] = [];
    const bus = new FlatBus();
    const originalWrite = bus.write.bind(bus);
    bus.write = (addr, value) => {
      if (addr === 0x0010) writes.push(value);
      originalWrite(addr, value);
    };
    bus.load(0x0200, [0xe6, 0x10]);
    bus.memory[0x0010] = 0x41;
    bus.memory[0xfffc] = 0x00;
    bus.memory[0xfffd] = 0x02;
    const cpu = new Cpu6510(bus);
    cpu.reset();
    expect(cpu.step()).toBe(5);
    expect(writes).toEqual([0x41, 0x42]);
  });
});
