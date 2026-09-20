export class HttpError extends Error {
  constructor(status, message, details) { super(message); this.name = 'HttpError'; this.status = status; this.details = details; }
}
export function openAiError(error) {
  const status = error instanceof HttpError ? error.status : 502;
  return { status, body: { error: { message: error instanceof HttpError ? error.message : 'Network error, timeout, or cancelled request',
    type: status >= 500 ? 'server_error' : 'invalid_request_error', param: null, code: error?.details?.code ?? null } } };
}
