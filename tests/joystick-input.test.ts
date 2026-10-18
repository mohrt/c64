import { describe, expect, it } from 'vitest';
import { ControlPort, Joystick } from '../src/io/control-port';
import { KeyboardJoystick, NUMPAD_KEYS, WASD_KEYS, combineInterceptors } from '../src/io/joystick-input';

const key = (code: string) => ({ code, repeat: false }) as KeyboardEvent;

describe('keyboard joysticks', () => {
  it('drive two ports at the same time', () => {
    const port1 = new ControlPort();
    const port2 = new ControlPort();
    const port2Keys = new KeyboardJoystick(port2);
    const port1Keys = new KeyboardJoystick(port1);
    port2Keys.setKeys(NUMPAD_KEYS);
    port1Keys.setKeys(WASD_KEYS);
    const keys = combineInterceptors(port1Keys, port2Keys);

    expect(keys.handle(key('Numpad8'), true)).toBe(true);
    expect(keys.handle(key('KeyF'), true)).toBe(true);
    expect(port2.lines & Joystick.Up).toBe(0);
    expect(port1.lines & Joystick.Fire).toBe(0);
    expect(port1.lines & Joystick.Up).toBe(Joystick.Up);
  });

  it('leaves keys alone when a port has no keys', () => {
    const port1 = new ControlPort();
    const port1Keys = new KeyboardJoystick(port1);
    port1Keys.setKeys({});
    expect(port1Keys.handle(key('KeyW'), true)).toBe(false);
    expect(port1.lines).toBe(0xff);
  });

  it('releases held directions when its keys change', () => {
    const port2 = new ControlPort();
    const port2Keys = new KeyboardJoystick(port2);
    port2Keys.setKeys(NUMPAD_KEYS);
    port2Keys.handle(key('Numpad0'), true);
    port2Keys.setKeys(WASD_KEYS);
    expect(port2.lines).toBe(0xff);
  });
});
