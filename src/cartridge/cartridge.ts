/**
 * A cartridge in the expansion port. It drives the EXROM and GAME lines,
 * supplies the ROML ($8000) and ROMH ($A000 or $E000) banks, and may have
 * registers in the I/O1 ($DE00) and I/O2 ($DF00) areas.
 */
export interface Cartridge {
  readonly name: string;
  /** True while the cartridge pulls the EXROM line low. */
  readonly exrom: boolean;
  /** True while the cartridge pulls the GAME line low. */
  readonly game: boolean;
  /** Called by the C64 so the memory map follows changes to EXROM/GAME. */
  onLinesChanged: () => void;

  /** `offset` is 0-$1FFF within the 8K window. */
  readRomL(offset: number): number;
  readRomH(offset: number): number;
  /** Returns null when nothing answers (open bus). `offset` is 0-$FF. */
  readIo1(offset: number): number | null;
  writeIo1(offset: number, value: number): void;
  readIo2(offset: number): number | null;
  writeIo2(offset: number, value: number): void;
  reset(): void;
}
