import { describe, expect, it } from 'vitest';
import { VIA_IRQ_CA1, VIA_IRQ_T1, VIA_IRQ_T2, Via6522 } from '../src/drive/via6522';

describe('Via6522', () => {
  it('reads port A pins and port B output bits according to DDR', () => {
    const via = new Via6522({ readPortA: () => 0x5a, readPortB: () => 0x0f });
    via.write(0x3, 0x00);
    expect(via.read(0x1)).toBe(0x5a);
    via.write(0x2, 0xf0);
    via.write(0x0, 0xa5);
    expect(via.read(0x0)).toBe(0xaf); // outputs from ORB, inputs from pins
    expect(via.portBOutput).toBe(0xaf);
  });

  it('T1 one-shot interrupts once after latch + 1 cycles', () => {
    const via = new Via6522();
    via.write(0xe, 0x80 | VIA_IRQ_T1);
    via.write(0x4, 10);
    via.write(0x5, 0);
    via.tick(10);
    expect(via.irq).toBe(false);
    via.tick(1);
    expect(via.irq).toBe(true);
    expect(via.read(0xd) & 0xc0).toBe(0xc0);
    via.read(0x4); // reading T1 low clears the flag
    expect(via.irq).toBe(false);
    via.tick(70000);
    expect(via.irq).toBe(false);
  });

  it('T1 free-run repeats every latch + 2 cycles', () => {
    const via = new Via6522();
    via.write(0xb, 0x40);
    via.write(0x4, 8);
    via.write(0x5, 0);
    via.tick(9);
    expect(via.read(0xd) & VIA_IRQ_T1).toBe(VIA_IRQ_T1);
    via.write(0xd, VIA_IRQ_T1);
    via.tick(9);
    expect(via.read(0xd) & VIA_IRQ_T1).toBe(0);
    via.tick(1);
    expect(via.read(0xd) & VIA_IRQ_T1).toBe(VIA_IRQ_T1);
  });

  it('T2 one-shot interrupts once', () => {
    const via = new Via6522();
    via.write(0x8, 5);
    via.write(0x9, 0);
    via.tick(6);
    expect(via.read(0xd) & VIA_IRQ_T2).toBe(VIA_IRQ_T2);
    via.read(0x8);
    via.tick(70000);
    expect(via.read(0xd) & VIA_IRQ_T2).toBe(0);
  });

  it('flags CA1 on the selected edge, latches port A, and clears on ORA read', () => {
    let pins = 0x11;
    const via = new Via6522({ readPortA: () => pins });
    via.write(0xb, 0x01); // latch port A
    via.write(0xc, 0x01); // positive edge
    via.setCa1(false);
    expect(via.read(0xd) & VIA_IRQ_CA1).toBe(0);
    via.setCa1(true);
    pins = 0x22;
    expect(via.read(0xd) & VIA_IRQ_CA1).toBe(VIA_IRQ_CA1);
    expect(via.read(0x1)).toBe(0x11);
    expect(via.read(0xd) & VIA_IRQ_CA1).toBe(0);
  });

  it('sets and clears interrupt enables', () => {
    const via = new Via6522();
    via.write(0xe, 0x80 | 0x42);
    expect(via.read(0xe)).toBe(0xc2);
    via.write(0xe, 0x02);
    expect(via.read(0xe)).toBe(0xc0);
  });

  it('reports CA2 and CB2 manual outputs', () => {
    const via = new Via6522();
    via.write(0xc, 0xee);
    expect(via.ca2High).toBe(true);
    expect(via.cb2High).toBe(true);
    via.write(0xc, 0xcc);
    expect(via.ca2High).toBe(false);
    expect(via.cb2High).toBe(false);
  });
});
