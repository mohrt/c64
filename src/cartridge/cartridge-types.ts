import type { Cartridge } from './cartridge';
import type { CrtImage } from './crt';

const BANK_SIZE = 0x2000;
const ROML_ADDRESS = 0x8000;
const OPEN_BUS = 0xff;

/** The .crt hardware type numbers for the cartridges supported here. */
export const CartridgeType = {
  Normal: 0,
  Ocean: 5,
  FunPlay: 7,
  SuperGames: 8,
  System3: 15,
  Dinamic: 17,
  MagicDesk: 19,
  EasyFlash: 32,
} as const;

const KNOWN_UNSUPPORTED: Record<number, string> = {
  1: 'Action Replay',
  2: 'KCS Power Cartridge',
  3: 'Final Cartridge III',
  4: "Simons' BASIC",
  6: 'Expert Cartridge',
  9: 'Atomic Power',
  10: 'Epyx FastLoad',
  13: 'Final Cartridge',
  20: 'Super Snapshot 5',
};

/**
 * Banked ROM with 8K ROML and ROMH halves per bank, built from the image's CHIP
 * packets. Subclasses implement the bank-switching registers.
 */
abstract class BankedCartridge implements Cartridge {
  readonly name: string;
  exrom: boolean;
  game: boolean;
  onLinesChanged: () => void = () => {};

  protected bank = 0;
  private readonly romL: (Uint8Array | undefined)[] = [];
  private readonly romH: (Uint8Array | undefined)[] = [];

  constructor(protected readonly image: CrtImage) {
    this.name = image.name;
    this.exrom = image.exrom;
    this.game = image.game;
    for (const chip of image.chips) {
      // A 16K chip at $8000 holds both halves; anything else at $A000/$E000/$F000 is ROMH.
      if (chip.loadAddress === ROML_ADDRESS) {
        this.romL[chip.bank] = padBank(chip.data.subarray(0, BANK_SIZE));
        if (chip.data.length > BANK_SIZE) this.romH[chip.bank] = padBank(chip.data.subarray(BANK_SIZE));
      } else {
        const offset = chip.loadAddress === 0xf000 ? 0x1000 : 0;
        const bank = (this.romH[chip.bank] ??= new Uint8Array(BANK_SIZE).fill(OPEN_BUS));
        bank.set(chip.data.subarray(0, BANK_SIZE - offset), offset);
      }
    }
  }

  readRomL(offset: number): number {
    return this.romL[this.bank]?.[offset] ?? OPEN_BUS;
  }

  readRomH(offset: number): number {
    return (this.romH[this.bank] ?? this.romL[this.bank])?.[offset] ?? OPEN_BUS;
  }

  readIo1(_offset: number): number | null {
    return null;
  }

  writeIo1(_offset: number, _value: number): void {}

  readIo2(_offset: number): number | null {
    return null;
  }

  writeIo2(_offset: number, _value: number): void {}

  reset(): void {
    this.bank = 0;
    this.setLines(this.image.exrom, this.image.game);
  }

  protected setLines(exrom: boolean, game: boolean): void {
    if (exrom === this.exrom && game === this.game) return;
    this.exrom = exrom;
    this.game = game;
    this.onLinesChanged();
  }
}

function padBank(data: Uint8Array): Uint8Array {
  if (data.length === BANK_SIZE) return data;
  const bank = new Uint8Array(BANK_SIZE).fill(OPEN_BUS);
  bank.set(data);
  return bank;
}

/** Plain 8K, 16K or Ultimax cartridge without banking. */
class NormalCartridge extends BankedCartridge {}

/** Ocean: write the bank number to $DE00. */
class OceanCartridge extends BankedCartridge {
  override writeIo1(_offset: number, value: number): void {
    this.bank = value & 0x3f;
  }
}

/** Fun Play / Power Play: scrambled bank bits written to $DE00; $86 switches the cartridge off. */
class FunPlayCartridge extends BankedCartridge {
  override writeIo1(_offset: number, value: number): void {
    if (value === 0x86) {
      this.setLines(false, false);
      return;
    }
    this.bank = ((value >> 3) & 0x07) | ((value & 0x01) << 3);
    this.setLines(true, false);
  }
}

/** Super Games: 16K banks via $DF00 bits 0-1; bit 2 switches off, bit 3 locks the register. */
class SuperGamesCartridge extends BankedCartridge {
  private locked = false;

  override writeIo2(_offset: number, value: number): void {
    if (this.locked) return;
    this.bank = value & 0x03;
    if (value & 0x04) this.setLines(false, false);
    else this.setLines(true, true);
    if (value & 0x08) this.locked = true;
  }

  override reset(): void {
    super.reset();
    this.locked = false;
  }
}

/** System 3 / C64GS: writing $DE00+n selects bank n; reading $DE00 selects bank 0. */
class System3Cartridge extends BankedCartridge {
  override writeIo1(offset: number): void {
    this.bank = offset & 0x3f;
  }

  override readIo1(): number | null {
    this.bank = 0;
    return null;
  }
}

/** Dinamic: reading $DE00+n selects bank n. */
class DinamicCartridge extends BankedCartridge {
  override readIo1(offset: number): number | null {
    this.bank = offset & 0x0f;
    return null;
  }
}

/** Magic Desk / Domark / HES Australia: bank in $DE00 bits 0-6; bit 7 switches the cartridge off. */
class MagicDeskCartridge extends BankedCartridge {
  override writeIo1(_offset: number, value: number): void {
    this.bank = value & 0x7f;
    this.setLines(!(value & 0x80), false);
  }
}

const EASYFLASH_BANK = 0x00;
const EASYFLASH_CONTROL = 0x02;
const EASYFLASH_GAME = 0x01;
const EASYFLASH_EXROM = 0x02;
const EASYFLASH_MODE = 0x04;

/**
 * EasyFlash: 64 banks of ROML/ROMH, bank register $DE00, control register
 * $DE02, and 256 bytes of RAM at $DF00. It boots in Ultimax mode (the boot
 * jumper holds GAME low). Writes to flash are ignored.
 */
class EasyFlashCartridge extends BankedCartridge {
  private readonly ram = new Uint8Array(0x100);

  override writeIo1(offset: number, value: number): void {
    if (offset === EASYFLASH_BANK) {
      this.bank = value & 0x3f;
    } else if (offset === EASYFLASH_CONTROL) {
      const exrom = (value & EASYFLASH_EXROM) !== 0;
      const game = value & EASYFLASH_MODE ? (value & EASYFLASH_GAME) !== 0 : true;
      this.setLines(exrom, game);
    }
  }

  override readIo2(offset: number): number | null {
    return this.ram[offset];
  }

  override writeIo2(offset: number, value: number): void {
    this.ram[offset] = value;
  }

  override reset(): void {
    this.bank = 0;
    this.setLines(false, true);
  }
}

/** Creates the cartridge for a parsed .crt image, or explains why it isn't supported. */
export function createCartridge(image: CrtImage): Cartridge {
  let cartridge: BankedCartridge;
  switch (image.hardwareType) {
    case CartridgeType.Normal:
      cartridge = new NormalCartridge(image);
      break;
    case CartridgeType.Ocean:
      cartridge = new OceanCartridge(image);
      break;
    case CartridgeType.FunPlay:
      cartridge = new FunPlayCartridge(image);
      break;
    case CartridgeType.SuperGames:
      cartridge = new SuperGamesCartridge(image);
      break;
    case CartridgeType.System3:
      cartridge = new System3Cartridge(image);
      break;
    case CartridgeType.Dinamic:
      cartridge = new DinamicCartridge(image);
      break;
    case CartridgeType.MagicDesk:
      cartridge = new MagicDeskCartridge(image);
      break;
    case CartridgeType.EasyFlash:
      cartridge = new EasyFlashCartridge(image);
      break;
    default: {
      const kind = KNOWN_UNSUPPORTED[image.hardwareType];
      throw new Error(
        `This cartridge uses ${kind ? `${kind} hardware` : `hardware type ${image.hardwareType}`}, which isn't supported yet.`,
      );
    }
  }
  cartridge.reset();
  return cartridge;
}
