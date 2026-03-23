interface ZipFileInput {
  name: string;
  data: Uint8Array<ArrayBuffer>;
}

interface ZipEntry {
  nameBytes: Uint8Array;
  data: Uint8Array<ArrayBuffer>;
  crc32: number;
  offset: number;
  dosTime: number;
  dosDate: number;
}

const textEncoder = new TextEncoder();
const crcTable = new Uint32Array(256);

for (let i = 0; i < 256; i += 1) {
  let value = i;
  for (let j = 0; j < 8; j += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[i] = value >>> 0;
}

function createCrc32(data: Uint8Array<ArrayBuffer>): number {
  let crc = 0xffffffff;

  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function getDosDateTime(date: Date): { dosDate: number; dosTime: number } {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  return {
    dosDate: ((year - 1980) << 9) | (month << 5) | day,
    dosTime: (hours << 11) | (minutes << 5) | seconds,
  };
}

function writeUint16(view: DataView, offset: number, value: number): number {
  view.setUint16(offset, value, true);
  return offset + 2;
}

function writeUint32(view: DataView, offset: number, value: number): number {
  view.setUint32(offset, value >>> 0, true);
  return offset + 4;
}

function writeBytes(
  target: Uint8Array<ArrayBuffer>,
  offset: number,
  bytes: Uint8Array,
): number {
  target.set(bytes, offset);
  return offset + bytes.length;
}

export function buildZipArchive(
  files: ZipFileInput[],
): Uint8Array<ArrayBuffer> {
  const now = new Date();
  const entries: ZipEntry[] = [];
  let totalSize = 0;

  for (const file of files) {
    const nameBytes = textEncoder.encode(file.name);
    const { dosDate, dosTime } = getDosDateTime(now);
    entries.push({
      nameBytes,
      data: file.data,
      crc32: createCrc32(file.data),
      offset: totalSize,
      dosDate,
      dosTime,
    });
    totalSize += 30 + nameBytes.length + file.data.length;
  }

  const centralDirectoryOffset = totalSize;

  for (const entry of entries) {
    totalSize += 46 + entry.nameBytes.length;
  }

  const endOfCentralDirectoryOffset = totalSize;
  totalSize += 22;

  const zip = new Uint8Array(new ArrayBuffer(totalSize));
  const view = new DataView(zip.buffer);
  let offset = 0;

  for (const entry of entries) {
    offset = writeUint32(view, offset, 0x04034b50);
    offset = writeUint16(view, offset, 20);
    offset = writeUint16(view, offset, 0x0800);
    offset = writeUint16(view, offset, 0);
    offset = writeUint16(view, offset, entry.dosTime);
    offset = writeUint16(view, offset, entry.dosDate);
    offset = writeUint32(view, offset, entry.crc32);
    offset = writeUint32(view, offset, entry.data.length);
    offset = writeUint32(view, offset, entry.data.length);
    offset = writeUint16(view, offset, entry.nameBytes.length);
    offset = writeUint16(view, offset, 0);
    offset = writeBytes(zip, offset, entry.nameBytes);
    offset = writeBytes(zip, offset, entry.data);
  }

  for (const entry of entries) {
    offset = writeUint32(view, offset, 0x02014b50);
    offset = writeUint16(view, offset, 20);
    offset = writeUint16(view, offset, 20);
    offset = writeUint16(view, offset, 0x0800);
    offset = writeUint16(view, offset, 0);
    offset = writeUint16(view, offset, entry.dosTime);
    offset = writeUint16(view, offset, entry.dosDate);
    offset = writeUint32(view, offset, entry.crc32);
    offset = writeUint32(view, offset, entry.data.length);
    offset = writeUint32(view, offset, entry.data.length);
    offset = writeUint16(view, offset, entry.nameBytes.length);
    offset = writeUint16(view, offset, 0);
    offset = writeUint16(view, offset, 0);
    offset = writeUint16(view, offset, 0);
    offset = writeUint16(view, offset, 0);
    offset = writeUint32(view, offset, 0);
    offset = writeUint32(view, offset, entry.offset);
    offset = writeBytes(zip, offset, entry.nameBytes);
  }

  const centralDirectorySize =
    endOfCentralDirectoryOffset - centralDirectoryOffset;

  offset = writeUint32(view, offset, 0x06054b50);
  offset = writeUint16(view, offset, 0);
  offset = writeUint16(view, offset, 0);
  offset = writeUint16(view, offset, entries.length);
  offset = writeUint16(view, offset, entries.length);
  offset = writeUint32(view, offset, centralDirectorySize);
  offset = writeUint32(view, offset, centralDirectoryOffset);
  writeUint16(view, offset, 0);

  return zip;
}
