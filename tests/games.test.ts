import { describe, expect, it } from 'vitest';
import { parseGameManifest } from '../src/games';

describe('bundled games manifest', () => {
  it('reads titles and files', () => {
    expect(
      parseGameManifest({
        games: [
          { title: ' Game One ', file: 'game-one.d64' },
          { title: 'Game Two', file: 'collection/Game Two (PD).prg' },
        ],
      }),
    ).toEqual([
      { title: 'Game One', file: 'game-one.d64' },
      { title: 'Game Two', file: 'collection/Game Two (PD).prg' },
    ]);
  });

  it('ignores malformed manifests and entries', () => {
    expect(parseGameManifest(null)).toEqual([]);
    expect(parseGameManifest({ games: 'nope' })).toEqual([]);
    expect(parseGameManifest({ games: [null, { title: 'No file' }, { title: '', file: 'x.d64' }] })).toEqual([]);
  });

  it('keeps credits and safe links', () => {
    const [game] = parseGameManifest({
      games: [
        {
          title: 'Game',
          file: 'game.prg',
          credit: 'Someone',
          license: 'MIT licence',
          licenseUrl: 'games/game.prg.license.txt',
          sourceUrl: 'javascript:alert(1)',
          hint: 'Joystick in port 1.',
        },
      ],
    });
    expect(game).toEqual({
      title: 'Game',
      file: 'game.prg',
      credit: 'Someone',
      license: 'MIT licence',
      licenseUrl: 'games/game.prg.license.txt',
      hint: 'Joystick in port 1.',
    });
    expect(parseGameManifest({ games: [{ title: 'G', file: 'g.prg', licenseUrl: 'http://x' }] })[0].licenseUrl).toBe(
      undefined,
    );
  });

  it('only accepts paths inside the games folder', () => {
    const files = ['../secret.d64', '/etc/passwd', 'https://example.com/x.d64', 'a/../../b.d64', '.hidden.d64'];
    expect(parseGameManifest({ games: files.map((file) => ({ title: 'Bad', file })) })).toEqual([]);
  });
});
