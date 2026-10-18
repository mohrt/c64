import { describe, expect, it } from 'vitest';
import { ControlPort, Joystick } from '../src/io/control-port';
import { KeyboardJoystick, NUMPAD_KEYS, WASD_KEYS, combineInterceptors } from '../src/io/joystick-input';

const key = (code: string) => ({ code, repeat: false }) as KeyboardEvent;

describe('two keyboard joysticks', () => {
  it('drive two ports at the same time', () => {
    const port1 = new ControlPort();
    const port2 = new ControlPort();
    const player1 = new KeyboardJoystick(port2, 'keyboard-1');
    const player2 = new KeyboardJoystick(port1, 'keyboard-2');
    player1.setKeys(NUMPAD_KEYS);
    player2.setKeys(WASD_KEYS);
    const keys = combineInterceptors(player1, player2);

    expect(keys.handle(key('Numpad8'), true)).toBe(true);
    expect(keys.handle(key('KeyF'), true)).toBe(true);
    expect(port2.lines & Joystick.Up).toBe(0);
    expect(port1.lines & Joystick.Fire).toBe(0);
    expect(port1.lines & Joystick.Up).toBe(Joystick.Up);
  });

  it('leaves keys alone when the second joystick is off', () => {
    const port1 = new ControlPort();
    const player2 = new KeyboardJoystick(port1, 'keyboard-2');
    player2.setKeys({});
    expect(player2.handle(key('KeyW'), true)).toBe(false);
    expect(port1.lines).toBe(0xff);
  });

  it('moves to another port, releasing the old one', () => {
    const port1 = new ControlPort();
    const port2 = new ControlPort();
    const player1 = new KeyboardJoystick(port2, 'keyboard-1');
    player1.setKeys(NUMPAD_KEYS);
    player1.handle(key('Numpad0'), true);
    player1.setPort(port1);
    expect(port2.lines).toBe(0xff);
    expect(port1.lines & Joystick.Fire).toBe(0);
  });
});
