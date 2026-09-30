// A small zip writer for the tests: stored or deflated files, optionally with zip64 records (sizes and
// offsets moved into the zip64 extra field, as a writer does for files over 4 GB), and ways to break one.
import zlib from 'node:zlib';

/**
 * files: [{ name, data, method = 8, crc?, fakeMethod? }]: `crc` overrides the checksum written (a damaged
 * file), `fakeMethod` the method number the directory claims (the data stays deflated or stored).
 */
export function makeZip(files, { zip64 = false, utf8 = true } = {}) {
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, utf8 ? 'utf8' : 'latin1');
    const method = f.method ?? 8;
    const data = method === 8 ? zlib.deflateRawSync(f.data) : f.data;
    const crc = f.crc ?? zlib.crc32(f.data);
    const shown = f.fakeMethod ?? method;
    const flags = utf8 ? 0x800 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(shown, 8);
    local.writeUInt32LE(crc >>> 0, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);
    const extra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
    if (zip64) {
      extra.writeUInt16LE(1, 0); extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(f.data.length), 4); extra.writeBigUInt64LE(BigInt(data.length), 12); extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(45, 4); c.writeUInt16LE(45, 6); c.writeUInt16LE(flags, 8); c.writeUInt16LE(shown, 10);
    c.writeUInt16LE(0x6000, 12); c.writeUInt16LE(0x5b3e, 14); // 12:00, 2025-09-30
    c.writeUInt32LE(crc >>> 0, 16);
    c.writeUInt32LE(zip64 ? 0xffffffff : data.length, 20); c.writeUInt32LE(zip64 ? 0xffffffff : f.data.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt16LE(extra.length, 30);
    c.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    central.push(c, name, extra);
    offset += local.length + name.length + data.length;
  }
  const cd = Buffer.concat(central), cdAt = offset, tail = [];
  if (zip64) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0); z.writeBigUInt64LE(44n, 4); z.writeUInt16LE(45, 12); z.writeUInt16LE(45, 14);
    z.writeBigUInt64LE(BigInt(files.length), 24); z.writeBigUInt64LE(BigInt(files.length), 32);
    z.writeBigUInt64LE(BigInt(cd.length), 40); z.writeBigUInt64LE(BigInt(cdAt), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0); loc.writeBigUInt64LE(BigInt(cdAt + cd.length), 8); loc.writeUInt32LE(1, 16);
    tail.push(z, loc);
  }
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(zip64 ? 0xffff : files.length, 8); e.writeUInt16LE(zip64 ? 0xffff : files.length, 10);
  e.writeUInt32LE(zip64 ? 0xffffffff : cd.length, 12); e.writeUInt32LE(zip64 ? 0xffffffff : cdAt, 16);
  return Buffer.concat([...parts, cd, ...tail, e]);
}
