export type VideoModelName = 'pal' | 'ntsc';

/** The timing and picture of a VIC-II variant, which also sets the machine's clock. */
export interface VideoModel {
  name: VideoModelName;
  /** System clock in Hz (the VIC-II's dot clock divided by 8). */
  clockHz: number;
  cyclesPerLine: number;
  linesPerFrame: number;
  /** Raster line shown at the top of the picture. */
  firstVisibleLine: number;
  /** Lines in the picture; they may run past the last raster line and on from line 0. */
  visibleLines: number;
  /** Sprite X coordinates from here on appear at the left of the line. */
  spriteXWrap: number;
  /** Width of a pixel relative to its height on a TV of this standard. */
  pixelAspect: number;
}

/** MOS 6569 (Europe, Australia). */
export const PAL: VideoModel = Object.freeze({
  name: 'pal',
  clockHz: 985_248,
  cyclesPerLine: 63,
  linesPerFrame: 312,
  firstVisibleLine: 15,
  visibleLines: 272,
  spriteXWrap: 0x1f8,
  pixelAspect: 0.936,
});

/** MOS 6567R8 (North America, Japan). Lines 13-40 are in the vertical blank. */
export const NTSC: VideoModel = Object.freeze({
  name: 'ntsc',
  clockHz: 1_022_727,
  cyclesPerLine: 65,
  linesPerFrame: 263,
  firstVisibleLine: 41,
  visibleLines: 235,
  spriteXWrap: 0x200,
  pixelAspect: 0.75,
});

export const videoModel = (name: VideoModelName): VideoModel => (name === 'ntsc' ? NTSC : PAL);
