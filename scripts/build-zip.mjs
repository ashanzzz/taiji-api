import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const safeRoots = ['src', 'public', 'test', 'docs', 'issues', 'scripts'];
const safeFiles = [
  'package.json',
  'README.md',
  'Dockerfile',
  'docker-compose.yml',
  '.dockerignore',
  '.gitignore',
  '.gitattributes',
  '.env.example',
];

const entries = [];

for (const file of safeFiles) {
  if (fs.existsSync(file)) {
    entries.push({
      name: `太极/${file}`,
      data: fs.readFileSync(file),
    });
  }
}

for (const dir of safeRoots) {
  if (fs.existsSync(dir)) {
    const walk = (d) => {
      for (const item of fs.readdirSync(d)) {
        const full = path.join(d, item).replace(/\\/g, '/');
        if (fs.statSync(full).isDirectory()) {
          walk(full);
        } else {
          entries.push({
            name: `太极/${full}`,
            data: fs.readFileSync(full),
          });
        }
      }
    };
    walk(dir);
  }
}

entries.sort((a, b) => a.name.localeCompare(b.name));

const localChunks = [];
const centralChunks = [];
let offset = 0;

for (const { name, data } of entries) {
  const nameBuf = Buffer.from(name, 'utf8');
  const uncompressedSize = data.length;
  const compressedData = zlib.deflateRawSync(data);
  const compressedSize = compressedData.length;
  const crc = zlib.crc32(data);

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0x0800, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0x5200, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(compressedSize, 18);
  localHeader.writeUInt32LE(uncompressedSize, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  localHeader.writeUInt16LE(0, 28);

  localChunks.push(localHeader, nameBuf, compressedData);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0x0800, 8);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(0x5200, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(compressedSize, 20);
  centralHeader.writeUInt32LE(uncompressedSize, 24);
  centralHeader.writeUInt16LE(nameBuf.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(offset, 42);

  centralChunks.push(centralHeader, nameBuf);

  offset += localHeader.length + nameBuf.length + compressedData.length;
}

const centralOffset = offset;
const centralSize = centralChunks.reduce((acc, c) => acc + c.length, 0);

const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(entries.length, 8);
eocd.writeUInt16LE(entries.length, 10);
eocd.writeUInt32LE(centralSize, 12);
eocd.writeUInt32LE(centralOffset, 16);
eocd.writeUInt16LE(0, 20);

const zipBuffer = Buffer.concat([...localChunks, ...centralChunks, eocd]);
fs.writeFileSync('太极.zip', zipBuffer);
console.log(`Successfully packed ${entries.length} files into 太极.zip (${zipBuffer.length} bytes)`);
