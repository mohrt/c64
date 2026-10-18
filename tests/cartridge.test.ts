import { describe, expect, it } from 'vitest';
import { CartridgeType, createCartridge } from '../src/cartridge/cartridge-types';
import { parseCrt } from '../src/cartridge/crt';
import { autostartHeader, bank8k, buildCrt } from './helpers/crt-builder';
import { createMachine, runFrames } from './helpers/machine';

const MODE_8K = { exrom: true, game: false };
const MODE_16K = { exrom: true, game: true };
const MODE_ULTIMAX = { exrom: false, game: true };

// LDA #color; STA $D020; JMP *
const setBorder = (color: number, at: number) => [0xa9, color, 0x8d, 0x20, 0xd0, 0x4c, at & 0xff, at >> 8];

function machineWith(crt: Uint8Array) {
  const c64 = createMachine('system');
  c64.insertCartridge(createCartridge(parseCrt(crt)));
  return c64;
}

describe('CRT parsing', () => {
  it('reads the header and chip packets', () => {
    const image = parseCrt(buildCrt(CartridgeType.Ocean, MODE_16K, [{ bank: 3, loadAddress: 0x8000, data: bank8k(7) }], 'OCEAN GAME'));
    expect(image.name).toBe('OCEAN GAME');
    expect(image.hardwareType).toBe(5);
    expect(image.exrom).toBe(true);
    expect(image.game).toBe(true);
    expect(image.chips).toHaveLength(1);
    expect(image.chips[0]).toMatchObject({ bank: 3, loadAddress: 0x8000 });
    expect(image.chips[0].data.length).toBe(0x2000);
  });

  it('rejects files that are not cartridges', () => {
    expect(() => parseCrt(new Uint8Array(100))).toThrow(/Not a \.crt/);
  });

  it('explains unsupported cartridge hardware', () => {
    const image = parseCrt(buildCrt(1, MODE_8K, []));
    expect(() => createCartridge(image)).toThrow(/Action Replay/);
  });
});

describe('cartridge memory map', () => {
  it('starts an 8K cartridge through its CBM80 signature', () => {
    const c64 = machineWith(
      buildCrt(CartridgeType.Normal, MODE_8K, [
        { bank: 0, loadAddress: 0x8000, data: bank8k(0xea, [...autostartHeader(), ...setBorder(5, 0x800e)]) },
      ]),
    );
    runFrames(c64, 10);
    expect(c64.bus.read(0xd020) & 0x0f).toBe(5);
    expect(c64.bus.read(0xa000)).toBe(c64.bus.roms.basic[0]); // BASIC still at $A000 in 8K mode
  });

  it('maps ROMH over BASIC in 16K mode', () => {
    const romL = bank8k(0, [...autostartHeader(), 0x4c, 0x00, 0xa0]); // JMP $A000
    const c64 = machineWith(
      buildCrt(CartridgeType.Normal, MODE_16K, [
        { bank: 0, loadAddress: 0x8000, data: new Uint8Array([...romL, ...bank8k(0, setBorder(7, 0xa005))]) },
      ]),
    );
    runFrames(c64, 10);
    expect(c64.bus.read(0xd020) & 0x0f).toBe(7);
  });

  it('boots an Ultimax cartridge from its own reset vector', () => {
    const romH = bank8k(0xff, setBorder(2, 0xe005));
    romH.set([0x00, 0xe0], 0x1ffc); // reset vector -> $E000
    const c64 = machineWith(buildCrt(CartridgeType.Normal, MODE_ULTIMAX, [{ bank: 0, loadAddress: 0xe000, data: romH }]));
    runFrames(c64, 5);
    expect(c64.bus.read(0xd020) & 0x0f).toBe(2);
    expect(c64.bus.kernalVisible).toBe(false);
    c64.bus.write(0x4000, 0x12);
    expect(c64.bus.read(0x4000)).toBe(0xff); // unmapped in Ultimax mode
    c64.bus.write(0x0800, 0x34);
    expect(c64.bus.read(0x0800)).toBe(0x34);
  });
});

describe('bank switching', () => {
  const twoBanks = (type: number, lines = MODE_8K) =>
    machineWith(
      buildCrt(type, lines, [
        { bank: 0, loadAddress: 0x8000, data: bank8k(0xa0) },
        { bank: 1, loadAddress: 0x8000, data: bank8k(0xa1) },
      ]),
    );

  it('Ocean selects banks by writing $DE00', () => {
    const c64 = twoBanks(CartridgeType.Ocean);
    expect(c64.bus.read(0x8000)).toBe(0xa0);
    c64.bus.write(0xde00, 1);
    expect(c64.bus.read(0x8000)).toBe(0xa1);
  });

  it('System 3 selects banks by the address written in $DE00-$DEFF', () => {
    const c64 = twoBanks(CartridgeType.System3);
    c64.bus.write(0xde01, 0);
    expect(c64.bus.read(0x8000)).toBe(0xa1);
    c64.bus.read(0xde00);
    expect(c64.bus.read(0x8000)).toBe(0xa0);
  });

  it('Dinamic selects banks by reading $DE00-$DEFF', () => {
    const c64 = twoBanks(CartridgeType.Dinamic);
    c64.bus.read(0xde01);
    expect(c64.bus.read(0x8000)).toBe(0xa1);
  });

  it('Magic Desk switches banks and can switch itself off', () => {
    const c64 = twoBanks(CartridgeType.MagicDesk);
    c64.bus.write(0xde00, 1);
    expect(c64.bus.read(0x8000)).toBe(0xa1);
    c64.bus.ram[0x8000] = 0x55;
    c64.bus.write(0xde00, 0x80);
    expect(c64.bus.read(0x8000)).toBe(0x55);
  });

  it('Fun Play decodes its scrambled bank bits', () => {
    const c64 = twoBanks(CartridgeType.FunPlay);
    c64.bus.write(0xde00, 0x08); // bank 1 lives in bits 3-5
    expect(c64.bus.read(0x8000)).toBe(0xa1);
  });

  it('Super Games switches 16K banks through $DF00 and can lock', () => {
    const c64 = twoBanks(CartridgeType.SuperGames, MODE_16K);
    c64.bus.write(0xdf00, 0x09); // bank 1, then lock
    expect(c64.bus.read(0x8000)).toBe(0xa1);
    c64.bus.write(0xdf00, 0x00);
    expect(c64.bus.read(0x8000)).toBe(0xa1);
  });

  it('EasyFlash boots in Ultimax mode, switches modes via $DE02, and has RAM at $DF00', () => {
    const romH = bank8k(0xb0);
    romH.set([0x00, 0xe0], 0x1ffc);
    romH.set([0x4c, 0x00, 0xe0], 0); // JMP $E000 (idle)
    const c64 = machineWith(
      buildCrt(CartridgeType.EasyFlash, MODE_ULTIMAX, [
        { bank: 0, loadAddress: 0x8000, data: bank8k(0xa0) },
        { bank: 0, loadAddress: 0xa000, data: romH },
        { bank: 1, loadAddress: 0x8000, data: bank8k(0xa1) },
      ]),
    );
    expect(c64.bus.read(0xfffd)).toBe(0xe0);
    expect(c64.bus.kernalVisible).toBe(false);

    c64.bus.write(0xde02, 0x07); // mode bit + EXROM + GAME: 16K
    expect(c64.bus.kernalVisible).toBe(true);
    expect(c64.bus.read(0xa000)).toBe(0x4c);
    c64.bus.write(0xde00, 1);
    expect(c64.bus.read(0x8000)).toBe(0xa1);

    c64.bus.write(0xdf42, 0x99);
    expect(c64.bus.read(0xdf42)).toBe(0x99);

    c64.bus.write(0xde02, 0x04); // mode bit only: cartridge invisible
    expect(c64.bus.read(0xa000)).toBe(c64.bus.roms.basic[0]);
  });

  it('removing the cartridge restores the normal machine', () => {
    const c64 = twoBanks(CartridgeType.Ocean);
    c64.insertCartridge(null);
    runFrames(c64, 150);
    expect(c64.bus.read(0x8000)).toBe(c64.bus.ram[0x8000]);
    expect(c64.bus.read(0xa000)).toBe(c64.bus.roms.basic[0]);
  });
});
