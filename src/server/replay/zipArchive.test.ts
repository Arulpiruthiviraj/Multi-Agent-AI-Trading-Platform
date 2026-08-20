import { describe, it, expect } from 'vitest';
import { crc32 } from 'node:zlib';
import { buildZipArchive } from './zipArchive';

/** Minimal local-file-header reader, test-only - round-trips what buildZipArchive wrote to prove it's a well-formed ZIP, not just "looks like bytes". */
function readLocalEntries(buf: Buffer): Array<{ name: string; content: Buffer; crc: number }> {
  const entries: Array<{ name: string; content: Buffer; crc: number }> = [];
  let pos = 0;
  while (pos < buf.length) {
    const sig = buf.readUInt32LE(pos);
    if (sig !== 0x04034b50) break; // reached central directory
    const crc = buf.readUInt32LE(pos + 14);
    const size = buf.readUInt32LE(pos + 18);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);
    const nameStart = pos + 30;
    const name = buf.subarray(nameStart, nameStart + nameLen).toString('utf8');
    const dataStart = nameStart + nameLen + extraLen;
    const content = buf.subarray(dataStart, dataStart + size);
    entries.push({ name, content: Buffer.from(content), crc });
    pos = dataStart + size;
  }
  return entries;
}

function crc32Of(buf: Buffer): number {
  const out = crc32(buf);
  return typeof out === 'number' ? out >>> 0 : Number(out) >>> 0;
}

describe('buildZipArchive', () => {
  it('produces a buffer starting with the real ZIP local-file-header magic number', () => {
    const zip = buildZipArchive([{ name: 'a.txt', content: 'hello' }]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
  });

  it('ends with the real end-of-central-directory magic number', () => {
    const zip = buildZipArchive([{ name: 'a.txt', content: 'hello' }]);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
  });

  it('round-trips file names and content exactly for multiple files', () => {
    const files = [
      { name: 'summary.json', content: JSON.stringify({ ok: true }) },
      { name: 'trades.csv', content: 'timestamp,symbol\n1,AAPL' },
      { name: 'report.md', content: '# Report\n\nSome text.' },
    ];
    const zip = buildZipArchive(files);
    const entries = readLocalEntries(zip);
    expect(entries).toHaveLength(3);
    for (let i = 0; i < files.length; i++) {
      expect(entries[i].name).toBe(files[i].name);
      expect(entries[i].content.toString('utf8')).toBe(files[i].content);
    }
  });

  it('stores a real CRC32 that matches recomputing the CRC of the extracted content', () => {
    const content = 'some content to checksum';
    const zip = buildZipArchive([{ name: 'x.txt', content }]);
    const [entry] = readLocalEntries(zip);
    expect(entry.crc).toBe(crc32Of(Buffer.from(content, 'utf8')));
  });

  it('handles an empty file list without throwing (valid, empty archive)', () => {
    const zip = buildZipArchive([]);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    expect(zip.readUInt16LE(zip.length - 22 + 10)).toBe(0); // total entries = 0
  });

  it('handles binary/Buffer content, not just strings', () => {
    const bin = Buffer.from([0, 1, 2, 255, 254, 253]);
    const zip = buildZipArchive([{ name: 'bin.dat', content: bin }]);
    const [entry] = readLocalEntries(zip);
    expect(entry.content.equals(bin)).toBe(true);
  });

  it('records the correct total-entries count in the end-of-central-directory record', () => {
    const zip = buildZipArchive([
      { name: 'a', content: '1' }, { name: 'b', content: '2' }, { name: 'c', content: '3' },
    ]);
    const totalEntries = zip.readUInt16LE(zip.length - 22 + 10);
    expect(totalEntries).toBe(3);
  });
});
