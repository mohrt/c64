import { Joystick, type ControlPort } from './control-port';
import { MIN_KEY_HOLD_MS, type KeyInterceptor } from './keyboard';

const { Up, Down, Left, Right, Fire } = Joystick;

/** The numeric keypad, which has no other use on a C64. */
export const NUMPAD_KEYS: Record<string, number> = {
  Numpad8: Up,
  Numpad2: Down,
  Numpad4: Left,
  Numpad6: Right,
  Numpad7: Up | Left,
  Numpad9: Up | Right,
  Numpad1: Down | Left,
  Numpad3: Down | Right,
  Numpad0: Fire,
  Numpad5: Fire,
};

/** Arrow keys + Space; while used as a joystick they don't reach the C64 keyboard. */
export const ARROW_KEYS: Record<string, number> = {
  ArrowUp: Up,
  ArrowDown: Down,
  ArrowLeft: Left,
  ArrowRight: Right,
  Space: Fire,
};

/** W A S D + F; while used as a joystick they don't reach the C64 keyboard. */
export const WASD_KEYS: Record<string, number> = {
  KeyW: Up,
  KeyS: Down,
  KeyA: Left,
  KeyD: Right,
  KeyF: Fire,
};

export const KEY_SETS = { numpad: NUMPAD_KEYS, arrows: ARROW_KEYS, wasd: WASD_KEYS } as const;
export type KeySetName = keyof typeof KEY_SETS;

const AXIS_THRESHOLD = 0.5;

// Standard gamepad mapping (https://w3c.github.io/gamepad/#remapping)
const BUTTON_A = 0;
const BUTTON_B = 1;
const DPAD_UP = 12;
const DPAD_DOWN = 13;
const DPAD_LEFT = 14;
const DPAD_RIGHT = 15;

/** Drives a control port from a set of keyboard keys. */
export class KeyboardJoystick implements KeyInterceptor {
  private keys: Record<string, number> = {};
  private readonly held = new Map<string, number>();
  private readonly pressedAt = new Map<string, number>();
  private readonly pendingReleases = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly port: ControlPort) {}

  /** Chooses which keys act as this joystick (an empty map turns it off). */
  setKeys(keys: Record<string, number>): void {
    this.releaseAll();
    this.keys = keys;
  }

  /** Handles joystick keys; returns false for keys that belong to the C64 keyboard. */
  handle(event: KeyboardEvent, down: boolean): boolean {
    const bits = this.keys[event.code];
    if (bits === undefined) return false;
    const code = event.code;

    if (down) {
      if (event.repeat) return true;
      const pending = this.pendingReleases.get(code);
      if (pending !== undefined) clearTimeout(pending);
      this.pendingReleases.delete(code);
      this.held.set(code, bits);
      this.pressedAt.set(code, performance.now());
      this.update();
      return true;
    }

    // Keep very short taps down long enough for a game polling once per frame.
    const remaining = MIN_KEY_HOLD_MS - (performance.now() - (this.pressedAt.get(code) ?? 0));
    if (remaining > 0) {
      this.pendingReleases.set(code, setTimeout(() => this.release(code), remaining));
    } else {
      this.release(code);
    }
    return true;
  }

  releaseAll(): void {
    this.pendingReleases.forEach((timer) => clearTimeout(timer));
    this.pendingReleases.clear();
    this.held.clear();
    this.update();
  }

  private release(code: string): void {
    this.pendingReleases.delete(code);
    this.held.delete(code);
    this.update();
  }

  private update(): void {
    let bits = 0;
    for (const value of this.held.values()) bits |= value;
    this.port.set('keyboard', bits);
  }
}

/** Lets several key interceptors (e.g. two keyboard joysticks) look at each key in turn. */
export function combineInterceptors(...interceptors: KeyInterceptor[]): KeyInterceptor {
  return {
    handle: (event, down) => interceptors.some((interceptor) => interceptor.handle(event, down)),
    releaseAll: () => interceptors.forEach((interceptor) => interceptor.releaseAll()),
  };
}

/** Drives a control port from one gamepad (D-pad or left stick, A/B to fire). */
export class GamepadJoystick {
  private padIndex: number | null = null;

  constructor(private readonly port: ControlPort) {}

  /** Chooses the gamepad by its browser index; null disconnects it from the port. */
  setPad(index: number | null): void {
    this.padIndex = index;
    this.port.set('gamepad', 0);
  }

  /** Gamepads have no events for button state, so this runs once per animation frame. */
  poll(): void {
    if (this.padIndex === null) return;
    const pad = navigator.getGamepads?.()[this.padIndex];
    this.port.set('gamepad', pad ? gamepadBits(pad) : 0);
  }
}

/** A one-line description of each connected gamepad and what is pressed, for the controls panel. */
export function describeGamepads(): string {
  const pads = [...(navigator.getGamepads?.() ?? [])].filter((pad): pad is Gamepad => pad !== null);
  return pads
    .map((pad) => {
      const bits = gamepadBits(pad);
      const pressed = [
        bits & Up ? 'up' : '',
        bits & Down ? 'down' : '',
        bits & Left ? 'left' : '',
        bits & Right ? 'right' : '',
        bits & Fire ? 'FIRE' : '',
        ...pad.buttons.flatMap((button, index) => (button.pressed ? [`button ${index}`] : [])),
      ].filter(Boolean);
      const name = pad.id.replace(/\s*\(.*\)\s*$/, '').trim() || 'gamepad';
      return `Gamepad ${pad.index + 1} (${name}): ${pressed.length ? pressed.join(', ') : 'nothing pressed'}`;
    })
    .join(' · ');
}

function gamepadBits(pad: Gamepad): number {
  const pressed = (index: number) => pad.buttons[index]?.pressed ?? false;
  const x = pad.axes[0] ?? 0;
  const y = pad.axes[1] ?? 0;
  let bits = 0;
  if (pressed(DPAD_UP) || y < -AXIS_THRESHOLD) bits |= Up;
  if (pressed(DPAD_DOWN) || y > AXIS_THRESHOLD) bits |= Down;
  if (pressed(DPAD_LEFT) || x < -AXIS_THRESHOLD) bits |= Left;
  if (pressed(DPAD_RIGHT) || x > AXIS_THRESHOLD) bits |= Right;
  if (pressed(BUTTON_A) || pressed(BUTTON_B)) bits |= Fire;
  return bits;
}
