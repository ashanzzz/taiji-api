import { HttpError } from './errors.js';

export async function* parseSse(body) {
  if (!body) throw new HttpError(502, 'Upstream returned no body');
  const decoder = new TextDecoder();
  let buffer = '', data = [], pendingCR = false, eventSize = 0;
  for await (const chunk of body) {
    let text = decoder.decode(chunk, { stream: true });
    if (pendingCR && text.startsWith('\n')) text = text.slice(1);
    pendingCR = text.endsWith('\r');
    buffer += text.replace(/\r\n|\r/g, '\n');
    if (buffer.length > 4_000_000) throw new HttpError(502, 'SSE line too large');
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line === '') {
        if (data.length) yield { data: data.join('\n') };
        data = []; eventSize = 0;
      } else if (line.startsWith('data:')) {
        eventSize += Buffer.byteLength(line);
        if (eventSize > 4_000_000) throw new HttpError(502, 'SSE event too large');
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  }
  if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, ''));
  if (data.length) yield { data: data.join('\n') };
}
