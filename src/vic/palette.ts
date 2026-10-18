/** Pepto's measured PAL VIC-II colors as 0xRRGGBB. */
export const PEPTO_PALETTE_RGB = [
  0x000000, 0xffffff, 0x68372b, 0x70a4b2, 0x6f3d86, 0x588d43, 0x352879, 0xb8c76f,
  0x6f4f25, 0x433900, 0x9a6759, 0x444444, 0x6c6c6c, 0x9ad284, 0x6c5eb5, 0x959595,
];

/** The palette as opaque pixels for a little-endian RGBA framebuffer viewed as Uint32. */
export const PALETTE_ABGR = Uint32Array.from(PEPTO_PALETTE_RGB, (rgb) => {
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
});
