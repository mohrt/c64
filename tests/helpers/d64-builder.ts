export { buildD64 } from '../../src/disk/d64-builder';

/** A program that loads at `address` with the given body bytes. */
export function prg(address: number, body: number[] | Uint8Array): Uint8Array {
  const data = new Uint8Array(body.length + 2);
  data[0] = address & 0xff;
  data[1] = address >> 8;
  data.set(body, 2);
  return data;
}
