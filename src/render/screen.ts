import { FRAME_WIDTH } from '../vic/vic2';

/** Copies completed VIC-II frames to a canvas, which follows the picture's size (PAL or NTSC). */
export class Screen {
  private readonly context: CanvasRenderingContext2D;
  private image: ImageData;
  private pixels: Uint32Array;
  private hasNewFrame = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    height: number,
  ) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is not available');
    this.context = context;
    [this.image, this.pixels] = this.createImage(height);
  }

  /** Snapshots a finished frame so a half-drawn one is never shown. */
  capture(framebuffer: Uint32Array): void {
    if (framebuffer.length !== this.pixels.length) {
      [this.image, this.pixels] = this.createImage(framebuffer.length / FRAME_WIDTH);
    }
    this.pixels.set(framebuffer);
    this.hasNewFrame = true;
  }

  present(): void {
    if (!this.hasNewFrame) return;
    this.context.putImageData(this.image, 0, 0);
    this.hasNewFrame = false;
  }

  private createImage(height: number): [ImageData, Uint32Array] {
    this.canvas.width = FRAME_WIDTH;
    this.canvas.height = height;
    const image = this.context.createImageData(FRAME_WIDTH, height);
    return [image, new Uint32Array(image.data.buffer)];
  }
}
