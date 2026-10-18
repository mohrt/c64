# C64 in the browser

A Commodore 64 emulator written from scratch in TypeScript: 6510 CPU, VIC-II, SID sound, CIAs, a cycle-synchronised 1541 disk drive, cartridges, joystick, mouse and keyboard. Drop a `.d64`, `.prg`, `.t64` or `.crt` file (or a `.zip` containing one) onto the page to run it.

## Keys

Esc is RUN/STOP, Tab is CTRL, Alt is the Commodore key, Page Up is RESTORE and Caps Lock is SHIFT LOCK. Characters type as labelled on your keyboard (`"` gives `"` even though the C64 has it on Shift+2), F1-F8 are the function keys, and the numpad is joystick 1. Settings are remembered between visits.

## ROMs and games

No ROM or game files are included in this repository.

- **Open ROMs** (MEGA65, LGPL) are downloaded with `npm run fetch:roms`. They boot to BASIC.
- **System ROMs**: for the full machine, download the C64 system ROMs and the 1541 drive ROM yourself and place them in `public/roms/system/` as `basic.rom`, `kernal.rom`, `chargen.rom` and `dos1541.rom`. When present they are used instead of the Open ROMs, and the 1541 ROM enables accurate drive emulation (needed for most games with fast loaders).
- **Games**: download disk, tape or cartridge images yourself and drop them onto the page. They stay in your browser and are never uploaded.

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
