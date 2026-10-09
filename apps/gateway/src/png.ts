import { inflateSync } from 'node:zlib';
import { GatewayError } from './types.ts';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Accept non-interlaced PNGs produced by Canvas; verify chunks and compressed image data.
export function decodePngBase64(input: unknown, maxBytes: number): Buffer {
  const fail = () => { throw new GatewayError('INVALID_IMAGE', '请上传有效的非交错 PNG 选区图片。'); };
  if (typeof input !== 'string') fail();
  const encoded = (input as string).replace(/^data:image\/png;base64,/, '');
  if (!encoded || encoded.length > Math.ceil(maxBytes / 3) * 4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) fail();
  const image = Buffer.from(encoded, 'base64');
  if (image.length > maxBytes) throw new GatewayError('IMAGE_TOO_LARGE', '选区图片过大，请缩小圈选范围。', 413);
  if (image.toString('base64') !== encoded || image.length < 57 || !image.subarray(0, 8).equals(signature)) fail();
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let color = 0;
  let palette = false;
  let sawHeader = false;
  let sawEnd = false;
  const idat: Buffer[] = [];
  while (offset < image.length) {
    if (offset + 12 > image.length) fail();
    const size = image.readUInt32BE(offset);
    if (size > image.length - offset - 12) fail();
    const type = image.toString('ascii', offset + 4, offset + 8);
    const data = image.subarray(offset + 8, offset + 8 + size);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(image.subarray(offset + 4, offset + 8 + size)) !== image.readUInt32BE(offset + 8 + size)) fail();
    if (!sawHeader && type !== 'IHDR') fail();
    if (type === 'IHDR') {
      if (sawHeader || size !== 13) fail();
      sawHeader = true;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      color = data[9];
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width > 4096 || height > 4096 || width * height > 4_194_304 || !depths[color]?.includes(bitDepth) || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) fail();
    } else if (type === 'PLTE') {
      if (!size || size % 3 || size > 768 || idat.length) fail();
      palette = true;
    } else if (type === 'IDAT') {
      if (sawEnd || color === 3 && !palette) fail();
      idat.push(data);
    } else if (type === 'IEND') {
      if (size || !idat.length || offset + 12 !== image.length) fail();
      sawEnd = true;
    } else if ((image[offset + 4] & 32) === 0) {
      fail(); // Unknown critical chunks are not PNG Canvas output.
    }
    offset += size + 12;
  }
  if (!sawEnd) fail();
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const rowBytes = Math.ceil(width * channels[color] * bitDepth / 8);
  const decodedBytes = (rowBytes + 1) * height;
  let decoded: Buffer;
  try {
    decoded = inflateSync(Buffer.concat(idat), { maxOutputLength: decodedBytes });
  } catch { return fail(); }
  if (decoded.length !== decodedBytes) fail();
  for (let row = 0; row < height; row++) if (decoded[row * (rowBytes + 1)] > 4) fail();
  return image;
}
