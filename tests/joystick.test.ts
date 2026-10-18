import { describe, expect, it } from 'vitest';
import { ControlPort, Joystick } from '../src/io/control-port';
import { Key } from '../src/io/keyboard';
import { createMachine, hasOpenRoms, runFrames } from './helpers/machine';

describe('ControlPort', () => {
  it('combines switches from several sources, active low', () => {
    const port = new ControlPort();
    expect(port.lines).toBe(0xff);
    port.set('keys', Joystick.Up);
    port.set('pad', Joystick.Fire);
    expect(port.lines).toBe(0xff & ~(Joystick.Up | Joystick.Fire));
    port.set('keys', 0);
    expect(port.lines).toBe(0xff & ~Joystick.Fire);
  });
});

describe.skipIf(!hasOpenRoms)('C64 joystick wiring', () => {
  it('reads port 2 on $DC00 and port 1 on $DC01', () => {
    const c64 = createMachine();
    runFrames(c64, 150);

    c64.port2.set('test', Joystick.Fire | Joystick.Left);
    expect(c64.bus.read(0xdc00) & 0x1f).toBe(0x1f & ~(Joystick.Fire | Joystick.Left));
    c64.port2.set('test', 0);

    c64.bus.write(0xdc00, 0xff); // deselect the keyboard so only the joystick shows
    c64.port1.set('test', Joystick.Down);
    expect(c64.bus.read(0xdc01) & 0x1f).toBe(0x1f & ~Joystick.Down);
  });

  it('leaves the keyboard working alongside the joystick', () => {
    const c64 = createMachine();
    runFrames(c64, 150);
    c64.port2.set('test', Joystick.Up);
    c64.keyboard.press(Key.A); // column 1, row 2
    c64.bus.write(0xdc00, 0xfd);
    expect(c64.bus.read(0xdc01) & 0x04).toBe(0);
  });

  it('switches the SID paddle inputs between ports', () => {
    const c64 = createMachine();
    c64.port1.potX = 0x12;
    c64.port2.potX = 0x34;
    c64.bus.write(0xdc02, 0xff);
    c64.bus.write(0xdc00, 0x40);
    expect(c64.bus.read(0xd419)).toBe(0x12);
    c64.bus.write(0xdc00, 0x80);
    expect(c64.bus.read(0xd419)).toBe(0x34);
  });
});
