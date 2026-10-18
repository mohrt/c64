import { describe, expect, it } from 'vitest';
import { Cia } from '../src/cia/cia';

describe('Cia', () => {
  it('timer A underflows every latch+1 cycles and raises an interrupt when enabled', () => {
    const cia = new Cia();
    cia.write(0x4, 9);
    cia.write(0x5, 0);
    cia.write(0xd, 0x81);
    cia.write(0xe, 0x11); // start, force load, continuous

    cia.tick(9);
    expect(cia.interrupt).toBe(false);
    cia.tick(1);
    expect(cia.interrupt).toBe(true);
    expect(cia.read(0x4)).toBe(9);

    expect(cia.read(0xd)).toBe(0x81);
    expect(cia.interrupt).toBe(false);
    expect(cia.read(0xd)).toBe(0);

    cia.tick(25); // two full 10-cycle periods, then 5 more
    expect(cia.read(0x4)).toBe(4);
    expect(cia.read(0xd)).toBe(0x81);
  });

  it('does not assert the interrupt when the source is masked', () => {
    const cia = new Cia();
    cia.write(0x4, 1);
    cia.write(0x5, 0);
    cia.write(0xe, 0x11);
    cia.tick(5);
    expect(cia.interrupt).toBe(false);
    expect(cia.read(0xd)).toBe(0x01);
  });

  it('one-shot mode stops after the first underflow', () => {
    const cia = new Cia();
    cia.write(0x4, 4);
    cia.write(0x5, 0);
    cia.write(0xe, 0x19);
    cia.tick(100);
    expect(cia.read(0xe) & 0x01).toBe(0);
    expect(cia.read(0x4)).toBe(4);
  });

  it('timer B can count timer A underflows', () => {
    const cia = new Cia();
    cia.write(0x4, 0);
    cia.write(0x5, 0);
    cia.write(0x6, 2);
    cia.write(0x7, 0);
    cia.write(0xd, 0x82);
    cia.write(0xf, 0x51); // start, force load, count timer A
    cia.write(0xe, 0x11);
    cia.tick(2);
    expect(cia.interrupt).toBe(false);
    cia.tick(1);
    expect(cia.interrupt).toBe(true);
  });

  it('combines port output with external pin levels', () => {
    const cia = new Cia({ readPortB: () => 0xfe });
    cia.write(0x2, 0xff);
    cia.write(0x0, 0x7f);
    expect(cia.portAOutput).toBe(0x7f);
    expect(cia.read(0x1)).toBe(0xfe);
  });
});
