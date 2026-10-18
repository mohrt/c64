/**
 * Freely distributable games a site can offer, listed in `games/index.json`:
 *
 *   { "games": [{ "title": "Some Game", "file": "some-game.d64" }] }
 *
 * `file` is relative to `games/`. Without the manifest no games are offered.
 */
export interface BundledGame {
  title: string;
  file: string;
}

const GAMES_DIR = 'games/';

/** Plain relative paths only, so the manifest can't point outside the games folder. */
function isSafeGamePath(file: string): boolean {
  return /^[\w][\w .()+-]*(\/[\w][\w .()+-]*)*$/.test(file) && !file.split('/').includes('..');
}

/** The well-formed entries of a manifest; anything else is ignored. */
export function parseGameManifest(json: unknown): BundledGame[] {
  const games = (json as { games?: unknown } | null)?.games;
  if (!Array.isArray(games)) return [];
  return games.flatMap((entry: unknown) => {
    const { title, file } = (entry ?? {}) as Record<string, unknown>;
    if (typeof title !== 'string' || !title.trim() || typeof file !== 'string' || !isSafeGamePath(file)) return [];
    return [{ title: title.trim(), file }];
  });
}

/** The site's game list, or none if it has no (valid) manifest. */
export async function loadGameManifest(baseUrl: string): Promise<BundledGame[]> {
  try {
    const response = await fetch(`${baseUrl}${GAMES_DIR}index.json`);
    if (!response.ok) return [];
    return parseGameManifest(await response.json());
  } catch {
    return [];
  }
}

export async function fetchGame(baseUrl: string, game: BundledGame): Promise<File> {
  const response = await fetch(`${baseUrl}${GAMES_DIR}${game.file}`);
  // Some servers (like the dev server) answer missing files with the page itself.
  const isPage = response.headers.get('content-type')?.includes('text/html') ?? false;
  if (!response.ok || isPage) throw new Error(`Could not download ${game.title} (${isPage ? 'not found' : `HTTP ${response.status}`}).`);
  const name = game.file.slice(game.file.lastIndexOf('/') + 1);
  return new File([await response.arrayBuffer()], name);
}
