/** Joystick switch bits, as seen (active low) on the CIA1 port lines. */
export const Joystick = {
  Up: 0x01,
  Down: 0x02,
  Left: 0x04,
  Right: 0x08,
  Fire: 0x10,
} as const;

const POT_RELEASED = 0xff;

/**
 * One of the two control ports. Several inputs can drive it at once (keys,
 * a gamepad, a mouse); their switches are combined like wired-OR hardware.
 */
export class ControlPort {
  /** Paddle/mouse positions read through the SID ($D419/$D41A). */
  potX = POT_RELEASED;
  potY = POT_RELEASED;

  private readonly sources = new Map<string, number>();
  private pressed = 0;

  /** Sets the switches held by one input source (a bitmask of `Joystick` values). */
  set(source: string, bits: number): void {
    if (bits) this.sources.set(source, bits);
    else this.sources.delete(source);
    this.pressed = 0;
    for (const value of this.sources.values()) this.pressed |= value;
  }

  /** Pin levels: closed switches pull their line low. */
  get lines(): number {
    return ~this.pressed & 0xff;
  }

  releasePots(): void {
    this.potX = this.potY = POT_RELEASED;
  }
}
