// A compressed v5 CHD written by hand, for maps chdman itself never writes (damaged or crafted files).
// `hunks` lists each hunk as {data} (stored with the deflate codec), {self: n} (a copy of hunk n of the
// file), {data, length} (stored, but with another length in its map entry; the bytes are there to read)
// or {stored} (those bytes, as the first codec's data); `slot: 1` stores either with the second codec slot
// instead. `codec` names the first codec in the header (the others are empty).
// The header has no SHA-1s, so `verify` finds nothing to check: read the data with extractraw.
import zlib from 'node:zlib';

function crc16(buf) {
  let crc = 0xffff;
  for (const b of buf) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export function craftChd(hunks, hunkbytes = 4096, { codec = 'zlib', unitbytes = 512 } = {}) {
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push(Math.floor(v / 2 ** i) & 1); };
  // the map's Huffman tree (16 code lengths of 4 bits): 2-bit codes for the types 0 (first codec), 1,
  // 4 (not compressed) and 5 (a copy of a hunk of this file), which get the codes 0 to 3 in that order
  for (const len of [2, 2, 0, 0, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) put(len, 4);
  for (const h of hunks) put(h.self !== undefined ? 3 : (h.slot ?? 0), 2);
  // then per hunk: a stored length and CRC-16, or the hunk copied
  const lengthbits = 24, selfbits = 16, first = 124;
  const raw = Buffer.alloc(hunks.length * 12), blobs = []; // (the map as chdman holds it: its CRC is checked)
  let offset = first;
  hunks.forEach((h, i) => {
    const e = raw.subarray(i * 12, i * 12 + 12);
    if (h.self !== undefined) {
      e[0] = 5; e.writeUIntBE(h.self, 4, 6);
      put(h.self, selfbits);
      return;
    }
    const packed = h.stored ?? zlib.deflateRawSync(h.data, { level: 9 }), length = h.length ?? packed.length, crc = h.data ? crc16(h.data) : 0;
    e[0] = h.slot ?? 0; e.writeUIntBE(length, 1, 3); e.writeUIntBE(offset, 4, 6); e.writeUInt16BE(crc, 10);
    put(length, lengthbits); put(crc, 16);
    blobs.push(packed, Buffer.alloc(Math.max(0, length - packed.length)));
    offset += Math.max(length, packed.length);
  });
  while (bits.length % 8) bits.push(0);
  const map = Buffer.alloc(bits.length / 8);
  bits.forEach((b, i) => { map[i >> 3] |= b << (7 - (i & 7)); });
  const mapHead = Buffer.alloc(16);
  mapHead.writeUInt32BE(map.length, 0); mapHead.writeUIntBE(first, 4, 6); mapHead.writeUInt16BE(crc16(raw), 10);
  mapHead[12] = lengthbits; mapHead[13] = selfbits;
  const head = Buffer.alloc(124);
  head.write('MComprHD', 0, 'latin1'); head.writeUInt32BE(124, 8); head.writeUInt32BE(5, 12);
  head.write(codec, 16, 'latin1');
  head.writeBigUInt64BE(BigInt(hunks.length * hunkbytes), 32); head.writeBigUInt64BE(BigInt(offset), 40);
  head.writeUInt32BE(hunkbytes, 56); head.writeUInt32BE(unitbytes, 60);
  return Buffer.concat([head, ...blobs, mapHead, map]);
}
