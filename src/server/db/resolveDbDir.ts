/**
 * Pure, testable extraction of db/index.ts's data-directory selection logic.
 *
 * Real bug found and fixed this pass: `/data` is meant as a Docker/Linux volume-mount convention
 * (see docker-compose.yml) - but `fs.existsSync('/data')` on Windows resolves relative to the
 * current drive, so if a `C:\data` directory happens to already exist for any unrelated reason,
 * this used to silently redirect the real live DB (and DbBackupService's daily backups) there
 * instead of the project's own data/ folder. On the machine this was found on, that collided with
 * the user's personal document folder. `/data` is now only ever considered on a real
 * container/Linux filesystem, never on Windows, regardless of what happens to exist at that path.
 */
export function resolveDbDir(
  platform: NodeJS.Platform,
  existsSync: (p: string) => boolean,
  cwd: string,
  pathResolve: (...segments: string[]) => string
): string {
  if (platform !== 'win32' && existsSync('/data')) return '/data';
  return pathResolve(cwd, 'data');
}
