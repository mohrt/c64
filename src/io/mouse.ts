import { Joystick, type ControlPort } from './control-port';

const MOUSE_SOURCE = 'mouse';
const LEFT_BUTTON = 0;
const RIGHT_BUTTON = 2;

/**
 * Commodore 1351 mouse in proportional mode. The position (mod 64) is read
 * through the SID's paddle registers in bits 1-6; the left button is the
 * joystick fire line and the right button is the "up" line.
 */
export class Mouse1351 {
  private port: ControlPort | null = null;
  private x = 0;
  private y = 0;
  private buttons = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    canvas.addEventListener('click', () => {
      if (this.port && document.pointerLockElement !== canvas) void canvas.requestPointerLock();
    });
    canvas.addEventListener('contextmenu', (event) => {
      if (this.port) event.preventDefault();
    });
    document.addEventListener('mousemove', (event) => this.onMove(event));
    document.addEventListener('mousedown', (event) => this.onButton(event, true));
    document.addEventListener('mouseup', (event) => this.onButton(event, false));
    document.addEventListener('pointerlockchange', () => {
      if (!this.captured) this.setButtons(0);
    });
  }

  /** Plugs the mouse into a control port, or unplugs it with null. */
  setPort(port: ControlPort | null): void {
    if (this.port) {
      this.port.set(MOUSE_SOURCE, 0);
      this.port.releasePots();
    }
    this.port = port;
    if (port) this.updatePots();
    else if (this.captured) document.exitPointerLock();
  }

  private get captured(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  private onMove(event: MouseEvent): void {
    if (!this.port || !this.captured) return;
    this.x += event.movementX;
    // The 1351 counts up when moved away from you, the opposite of screen coordinates.
    this.y -= event.movementY;
    this.updatePots();
  }

  private onButton(event: MouseEvent, down: boolean): void {
    if (!this.port || !this.captured) return;
    const bit = event.button === LEFT_BUTTON ? Joystick.Fire : event.button === RIGHT_BUTTON ? Joystick.Up : 0;
    if (!bit) return;
    event.preventDefault();
    this.setButtons(down ? this.buttons | bit : this.buttons & ~bit);
  }

  private setButtons(bits: number): void {
    this.buttons = bits;
    this.port?.set(MOUSE_SOURCE, bits);
  }

  private updatePots(): void {
    if (!this.port) return;
    this.port.potX = (Math.round(this.x) & 0x3f) << 1;
    this.port.potY = (Math.round(this.y) & 0x3f) << 1;
  }
}
