import { Joystick, type ControlPort } from './control-port';
import { MIN_KEY_HOLD_MS } from './keyboard';

const { Up, Down, Left, Right, Fire } = Joystick;

/** The numeric keypad is always a joystick; it has no other use on a C64. */
const NUMPAD_KEYS: Record<string, number> = {
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

/** Arrow keys + Space, used only when enabled because they are also C64 keys. */
const ARROW_KEYS: Record<string, number> = {
  ArrowUp: Up,
  ArrowDown: Down,
  ArrowLeft: Left,
  ArrowRight: Right,
  Space: Fire,
};

const KEYBOARD_SOURCE = 'keyboard';
const GAMEPAD_SOURCE = 'gamepad';
const AXIS_THRESHOLD = 0.5;

// Standard gamepad mapping (https://w3c.github.io/gamepad/#remapping)
const BUTTON_A = 0;
const BUTTON_B = 1;
const DPAD_UP = 12;
const DPAD_DOWN = 13;
const DPAD_LEFT = 14;
const DPAD_RIGHT = 15;

/** Drives a control port from keyboard keys. */
export class KeyboardJoystick {
  arrowKeysEnabled = false;

  private readonly held = new Map<string, number>();
  private readonly pressedAt = new Map<string, number>();
  private readonly pendingReleases = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private port: ControlPort) {}

  setPort(port: ControlPort): void {
    this.port.set(KEYBOARD_SOURCE, 0);
    this.port = port;
    this.update();
  }

  /** Handles joystick keys; returns false for keys that belong to the C64 keyboard. */
  handle(event: KeyboardEvent, down: boolean): boolean {
    const bits = NUMPAD_KEYS[event.code] ?? (this.arrowKeysEnabled ? ARROW_KEYS[event.code] : undefined);
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
    this.port.set(KEYBOARD_SOURCE, bits);
  }
}

/** Drives a control port from any connected gamepad (D-pad or left stick, A/B to fire). */
export class GamepadJoystick {
  constructor(private port: ControlPort) {}

  setPort(port: ControlPort): void {
    this.port.set(GAMEPAD_SOURCE, 0);
    this.port = port;
  }

  /** Gamepads have no events for button state, so this runs once per animation frame. */
  poll(): void {
    let bits = 0;
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (pad) bits |= gamepadBits(pad);
    }
    this.port.set(GAMEPAD_SOURCE, bits);
  }
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
