import { describe, it, expect } from 'vitest';
import { resolveDbDir } from './resolveDbDir';

/**
 * Regression test for a real, live data-hygiene incident: on a Windows dev machine where an
 * unrelated `C:\data` directory already existed (in this case, the user's personal document
 * folder), Argus was silently writing its live database and daily backups there instead of the
 * project's own data/ folder.
 */
describe('resolveDbDir', () => {
  it('never picks /data on win32, even when something already exists there', () => {
    const alwaysTrue = () => true;
    const dir = resolveDbDir('win32', alwaysTrue, 'C:\\WorkProjects\\Argus', (...s) => s.join('\\'));
    expect(dir).not.toBe('/data');
    expect(dir).toBe('C:\\WorkProjects\\Argus\\data');
  });

  it('falls back to the project-relative data dir on win32 even when /data does not exist either', () => {
    const alwaysFalse = () => false;
    const dir = resolveDbDir('win32', alwaysFalse, 'C:\\WorkProjects\\Argus', (...s) => s.join('\\'));
    expect(dir).toBe('C:\\WorkProjects\\Argus\\data');
  });

  it('uses the real /data container-volume convention on Linux when it exists', () => {
    const existsSync = (p: string) => p === '/data';
    const dir = resolveDbDir('linux', existsSync, '/app', (...s) => s.join('/'));
    expect(dir).toBe('/data');
  });

  it('falls back to the project-relative data dir on Linux when /data does not exist', () => {
    const alwaysFalse = () => false;
    const dir = resolveDbDir('linux', alwaysFalse, '/app', (...s) => s.join('/'));
    expect(dir).toBe('/app/data');
  });
});
