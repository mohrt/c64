# C64 in the browser

A Commodore 64 emulator written from scratch in TypeScript: 6510 CPU, VIC-II, SID sound, CIAs, a cycle-synchronised 1541 disk drive, cartridges, joystick, mouse and keyboard. Drop a `.d64`, `.prg`, `.t64` or `.crt` file (or a `.zip` containing one) onto the page to run it. The toolbar switches between a PAL and an NTSC machine; some games and fast loaders only work on one of them.

## Keys

Esc is RUN/STOP, Tab is CTRL, Alt is the Commodore key, Page Up is RESTORE and Caps Lock is SHIFT LOCK. Characters type as labelled on your keyboard (`"` gives `"` even though the C64 has it on Shift+2), and F1-F8 are the function keys. Joysticks are set per port under the screen: a gamepad, and optionally the numpad, the arrow keys + Space or W A S D + F (keys used as a joystick don't type on the C64). Settings are remembered between visits.

## ROMs and games

No ROM or game files are included in this repository.

- **Open ROMs** (MEGA65, LGPL) are downloaded with `npm run fetch:roms`. They boot to BASIC.
- **System ROMs**: for the full machine, download the C64 system ROMs and the 1541 drive ROM yourself and place them in `public/roms/system/` as `basic.rom`, `kernal.rom`, `chargen.rom` and `dos1541.rom`. When present they are used instead of the Open ROMs, and the 1541 ROM enables accurate drive emulation (needed for most games with fast loaders).
- **Games**: download disk, tape or cartridge images yourself and drop them onto the page. They stay in your browser and are never uploaded.
- **Offering games on your own site**: put freely distributable games in `public/games/` with an `index.json` such as `{ "games": [{ "title": "Some Game", "file": "some-game.d64" }] }`, and they appear in a "Free games" picker.

## Development

```sh
npm install
npm run fetch:roms      # Open ROMs into public/roms/
npm run dev             # http://localhost:5173
npm test                # tests needing ROMs or disk images skip when they're missing
npm run fetch:dormann   # optional: 6502 functional test binary for the CPU test
```

## Deploying

`.github/workflows/pages.yml` builds the site and deploys it to GitHub Pages on every push to `main` (Pages source: "GitHub Actions").
