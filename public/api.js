const jsonHeaders = { Accept: 'application/json', 'Content-Type': 'application/json' };

export class AdminApi {
  async request(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', ...options });
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await response.json().catch(() => null) : await response.text();
    if (!response.ok) throw new ApiError(response.status, messageFor(body));
    return body;
  }

  get(path) { return this.request(path); }
  post(path, payload) { return this.request(path, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(payload) }); }
  put(path, payload) { return this.request(path, { method: 'PUT', headers: jsonHeaders, body: JSON.stringify(payload) }); }
  login(key) { return this.post('/admin/login', { key }); }
  logout() { return this.post('/admin/logout', {}); }

  async playground(payload, signal, onEvent) {
    const response = await fetch('/admin/playground', { method: 'POST', credentials: 'same-origin', headers: jsonHeaders, body: JSON.stringify(payload), signal });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new ApiError(response.status, messageFor(body));
    }
    if (!response.headers.get('content-type')?.includes('text/event-stream')) return { stream: false, body: await response.json() };
    await readSse(response.body, onEvent);
    return { stream: true };
  }
}

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function messageFor(body) {
  return body?.error?.message || body?.message || (typeof body === 'string' && body) || '请求未完成，请稍后重试。';
}

async function readSse(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const messages = pending.split(/\r?\n\r?\n/);
      pending = messages.pop() || '';
      messages.forEach((message) => {
        const data = message.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
        if (data && data !== '[DONE]') onEvent(data);
      });
    }
  } finally { reader.releaseLock(); }
}
