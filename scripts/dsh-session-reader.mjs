import { readFile } from 'node:fs/promises';
import { zstdDecompressSync } from 'node:zlib';

/** DSH journals contain independent concatenated zstd frames. */
export async function* readSession(path) {
  const bytes = await readFile(path);
  let offset = 0, pending = '', expanded = 0;
  while (offset < bytes.length) {
    const frameOffset = offset;
    const decoded = zstdDecompressSync(bytes.subarray(offset), {
      info: true, maxOutputLength: 256 * 1024 * 1024,
    });
    const consumed = decoded.engine.bytesWritten;
    if (!Number.isSafeInteger(consumed) || consumed <= 0 || consumed > bytes.length - offset)
      throw Error(`Invalid frame progress at ${offset}`);
    offset += consumed;
    expanded += decoded.buffer.length;
    if (expanded > 1024 * 1024 * 1024) throw Error('Session exceeds 1 GiB expanded bound');
    const lines = (pending + decoded.buffer.toString('utf8')).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      yield { record: JSON.parse(line), frameOffset };
    }
  }
  if (pending.trim()) yield { record: JSON.parse(pending), frameOffset: offset };
}
