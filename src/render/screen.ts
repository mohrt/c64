import { FRAME_HEIGHT, FRAME_WIDTH } from '../vic/vic2';

/** Copies completed VIC-II frames to a canvas. */
export class Screen {
  private readonly context: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private readonly pixels: Uint32Array;
  private hasNewFrame = false;

  constructor(canvas: HTMLCanvasElement) {
    canvas.width = FRAME_WIDTH;
    canvas.height = FRAME_HEIGHT;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is not available');
    this.context = context;
    this.image = context.createImageData(FRAME_WIDTH, FRAME_HEIGHT);
    this.pixels = new Uint32Array(this.image.data.buffer);
  }

  /** Snapshots a finished frame so a half-drawn one is never shown. */
  capture(framebuffer: Uint32Array): void {
    this.pixels.set(framebuffer);
    this.hasNewFrame = true;
  }

  present(): void {
    if (!this.hasNewFrame) return;
    this.context.putImageData(this.image, 0, 0);
    this.hasNewFrame = false;
  }
}
