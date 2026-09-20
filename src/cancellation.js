export function abortable(promise, signal, onLate) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    let cancelled = false;
    const abort = () => { cancelled = true; reject(signal.reason || new Error('Cancelled')); };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', abort);
      if (cancelled) Promise.resolve(onLate?.(value)).catch(() => {});
      else resolve(value);
    }, error => { signal.removeEventListener('abort', abort); if (!cancelled) reject(error); });
  });
}
