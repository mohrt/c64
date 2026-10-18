/**
 * C64 keys encoded as (CIA1 port A line << 4) | port B bit, following the
 * standard keyboard matrix layout.
 */
export const Key = {
  Delete: 0x00, Return: 0x01, CursorRight: 0x02, F7: 0x03, F1: 0x04, F3: 0x05, F5: 0x06, CursorDown: 0x07,
  Digit3: 0x10, W: 0x11, A: 0x12, Digit4: 0x13, Z: 0x14, S: 0x15, E: 0x16, LeftShift: 0x17,
  Digit5: 0x20, R: 0x21, D: 0x22, Digit6: 0x23, C: 0x24, F: 0x25, T: 0x26, X: 0x27,
  Digit7: 0x30, Y: 0x31, G: 0x32, Digit8: 0x33, B: 0x34, H: 0x35, U: 0x36, V: 0x37,
  Digit9: 0x40, I: 0x41, J: 0x42, Digit0: 0x43, M: 0x44, K: 0x45, O: 0x46, N: 0x47,
  Plus: 0x50, P: 0x51, L: 0x52, Minus: 0x53, Period: 0x54, Colon: 0x55, At: 0x56, Comma: 0x57,
  Pound: 0x60, Asterisk: 0x61, Semicolon: 0x62, Home: 0x63, RightShift: 0x64, Equals: 0x65, UpArrow: 0x66, Slash: 0x67,
  Digit1: 0x70, LeftArrow: 0x71, Control: 0x72, Digit2: 0x73, Space: 0x74, Commodore: 0x75, Q: 0x76, RunStop: 0x77,
} as const;

export type C64Key = (typeof Key)[keyof typeof Key];

/** The 8x8 key matrix scanned through CIA1. */
export class KeyboardMatrix {
  /** One byte per port A line; a set bit means the key on that port B bit is down. */
  private readonly lines = new Uint8Array(8);

  press(key: C64Key): void {
    this.lines[key >> 4] |= 1 << (key & 0x07);
  }

  release(key: C64Key): void {
    this.lines[key >> 4] &= ~(1 << (key & 0x07));
  }

  releaseAll(): void {
    this.lines.fill(0);
  }

  /** Port B pin levels when port A drives `portA` (selected lines are low). */
  readPortB(portA: number): number {
    let result = 0xff;
    for (let line = 0; line < 8; line++) {
      if (!(portA & (1 << line))) result &= ~this.lines[line];
    }
    return result & 0xff;
  }

  /** Port A pin levels when port B drives `portB`, for programs that scan in reverse. */
  readPortA(portB: number): number {
    let result = 0xff;
    const selected = ~portB & 0xff;
    for (let line = 0; line < 8; line++) {
      if (this.lines[line] & selected) result &= ~(1 << line);
    }
    return result;
  }
}

/** How a mapped browser key overrides the C64 shift state. */
type ShiftMode = 'keep' | 'add' | 'remove';

interface Mapping {
  keys: C64Key[];
  shift: ShiftMode;
}

const map = (keys: C64Key | C64Key[], shift: ShiftMode = 'keep'): Mapping => ({
  keys: Array.isArray(keys) ? keys : [keys],
  shift,
});

/** Non-character keys, matched by `KeyboardEvent.code`. */
const CODE_MAP: Record<string, Mapping> = {
  Enter: map(Key.Return),
  NumpadEnter: map(Key.Return),
  Backspace: map(Key.Delete),
  Insert: map(Key.Delete, 'add'),
  ArrowRight: map(Key.CursorRight, 'remove'),
  ArrowLeft: map(Key.CursorRight, 'add'),
  ArrowDown: map(Key.CursorDown, 'remove'),
  ArrowUp: map(Key.CursorDown, 'add'),
  Home: map(Key.Home),
  Escape: map(Key.RunStop),
  Tab: map(Key.Control),
  ShiftLeft: map(Key.LeftShift),
  ShiftRight: map(Key.RightShift),
  AltLeft: map(Key.Commodore),
  AltRight: map(Key.Commodore),
  Backquote: map(Key.LeftArrow),
  F1: map(Key.F1, 'remove'),
  F2: map(Key.F1, 'add'),
  F3: map(Key.F3, 'remove'),
  F4: map(Key.F3, 'add'),
  F5: map(Key.F5, 'remove'),
  F6: map(Key.F5, 'add'),
  F7: map(Key.F7, 'remove'),
  F8: map(Key.F7, 'add'),
};

/** Printable characters, matched by `KeyboardEvent.key`, mapped to where they sit on a C64. */
const CHAR_MAP: Record<string, Mapping> = {
  ' ': map(Key.Space),
  '1': map(Key.Digit1, 'remove'), '2': map(Key.Digit2, 'remove'), '3': map(Key.Digit3, 'remove'),
  '4': map(Key.Digit4, 'remove'), '5': map(Key.Digit5, 'remove'), '6': map(Key.Digit6, 'remove'),
  '7': map(Key.Digit7, 'remove'), '8': map(Key.Digit8, 'remove'), '9': map(Key.Digit9, 'remove'),
  '0': map(Key.Digit0, 'remove'),
  '!': map(Key.Digit1, 'add'), '"': map(Key.Digit2, 'add'), '#': map(Key.Digit3, 'add'),
  '$': map(Key.Digit4, 'add'), '%': map(Key.Digit5, 'add'), '&': map(Key.Digit6, 'add'),
  "'": map(Key.Digit7, 'add'), '(': map(Key.Digit8, 'add'), ')': map(Key.Digit9, 'add'),
  '+': map(Key.Plus, 'remove'), '-': map(Key.Minus, 'remove'), '*': map(Key.Asterisk, 'remove'),
  '/': map(Key.Slash, 'remove'), '=': map(Key.Equals, 'remove'), ':': map(Key.Colon, 'remove'),
  ';': map(Key.Semicolon, 'remove'), ',': map(Key.Comma, 'remove'), '.': map(Key.Period, 'remove'),
  '@': map(Key.At, 'remove'), '^': map(Key.UpArrow, 'remove'), '\\': map(Key.Pound, 'remove'),
  '<': map(Key.Comma, 'add'), '>': map(Key.Period, 'add'), '?': map(Key.Slash, 'add'),
  '[': map(Key.Colon, 'add'), ']': map(Key.Semicolon, 'add'),
};

const LETTER_KEYS: Record<string, C64Key> = {
  a: Key.A, b: Key.B, c: Key.C, d: Key.D, e: Key.E, f: Key.F, g: Key.G, h: Key.H, i: Key.I,
  j: Key.J, k: Key.K, l: Key.L, m: Key.M, n: Key.N, o: Key.O, p: Key.P, q: Key.Q, r: Key.R,
  s: Key.S, t: Key.T, u: Key.U, v: Key.V, w: Key.W, x: Key.X, y: Key.Y, z: Key.Z,
};

const RESTORE_CODE = 'PageUp';
/** The KERNAL scans the keyboard every 1/60 s, so shorter taps would be missed. */
export const MIN_KEY_HOLD_MS = 50;

/** Gets first pick of key events, e.g. to use some keys as a joystick. */
export interface KeyInterceptor {
  /** Returns true if it consumed the event. */
  handle(event: KeyboardEvent, down: boolean): boolean;
  releaseAll(): void;
}

/** Buttons and form fields on the page keep their own keys (Space/Enter must still work on them). */
function isPageControl(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLButtonElement ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement
  );
}

function resolve(event: KeyboardEvent): Mapping | undefined {
  const byCode = CODE_MAP[event.code];
  if (byCode) return byCode;
  if (event.key.length !== 1) return undefined;
  const letter = LETTER_KEYS[event.key.toLowerCase()];
  return letter !== undefined ? map(letter) : CHAR_MAP[event.key];
}

/**
 * Translates browser keyboard events into C64 matrix presses. Characters are
 * mapped symbolically (typing `"` presses SHIFT+2 as on a real C64).
 */
export class BrowserKeyboard {
  private readonly active = new Map<string, Mapping>();
  private readonly pressedAt = new Map<string, number>();
  private readonly pendingReleases = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly matrix: KeyboardMatrix,
    private readonly onRestore: () => void,
    private readonly interceptor?: KeyInterceptor,
  ) {}

  attach(target: Window): void {
    target.addEventListener('keydown', (event) => this.onKeyDown(event));
    target.addEventListener('keyup', (event) => this.onKeyUp(event));
    target.addEventListener('blur', () => {
      this.releaseAll();
      this.interceptor?.releaseAll();
    });
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || isPageControl(event.target)) return;
    if (this.interceptor?.handle(event, true)) {
      event.preventDefault();
      return;
    }
    if (event.code === RESTORE_CODE) {
      event.preventDefault();
      if (!event.repeat) this.onRestore();
      return;
    }
    const mapping = resolve(event);
    if (!mapping) return;
    event.preventDefault();
    if (event.repeat) return;
    this.cancelPendingRelease(event.code);
    this.pressedAt.set(event.code, performance.now());
    if (this.active.has(event.code)) return;
    this.active.set(event.code, mapping);
    this.rebuild();
  }

  private onKeyUp(event: KeyboardEvent): void {
    if (this.interceptor?.handle(event, false)) {
      event.preventDefault();
      return;
    }
    const code = event.code;
    if (!this.active.has(code)) return;
    event.preventDefault();
    const remaining = MIN_KEY_HOLD_MS - (performance.now() - (this.pressedAt.get(code) ?? 0));
    if (remaining > 0) {
      this.pendingReleases.set(code, setTimeout(() => this.release(code), remaining));
    } else {
      this.release(code);
    }
  }

  private release(code: string): void {
    this.pendingReleases.delete(code);
    this.pressedAt.delete(code);
    if (this.active.delete(code)) this.rebuild();
  }

  private cancelPendingRelease(code: string): void {
    const timer = this.pendingReleases.get(code);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.pendingReleases.delete(code);
  }

  private releaseAll(): void {
    this.pendingReleases.forEach((timer) => clearTimeout(timer));
    this.pendingReleases.clear();
    this.pressedAt.clear();
    this.active.clear();
    this.rebuild();
  }

  private rebuild(): void {
    this.matrix.releaseAll();
    let shift: ShiftMode = 'keep';
    for (const mapping of this.active.values()) {
      for (const key of mapping.keys) this.matrix.press(key);
      if (mapping.shift !== 'keep') shift = mapping.shift;
    }
    if (shift === 'add') {
      this.matrix.press(Key.LeftShift);
    } else if (shift === 'remove') {
      this.matrix.release(Key.LeftShift);
      this.matrix.release(Key.RightShift);
    }
  }
}
