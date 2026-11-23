// Local Feedback Studio — Passive In-Memory Console Error Buffer (MAIN world)
// Keeps only the last 20 errors in tab RAM. Zero storage, zero network.

(() => {
  if (window.__LFS_CONSOLE_CAPTURE__) return;
  window.__LFS_CONSOLE_CAPTURE__ = true;

  const MAX_ERRORS = 20;
  const buffer = [];

  function pushError(type, message) {
    const text = String(message || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    buffer.push({
      time: new Date().toISOString(),
      type,
      message: text.length > 400 ? text.slice(0, 400) + '…' : text
    });
    if (buffer.length > MAX_ERRORS) {
      buffer.shift();
    }
  }

  function formatArg(arg) {
    if (arg instanceof Error) {
      return arg.stack ? arg.stack.split('\n').slice(0, 3).join(' | ') : arg.message;
    }
    if (typeof arg === 'string') return arg;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }

  const origError = console.error;
  console.error = function (...args) {
    try {
      pushError('console.error', args.map(formatArg).join(' '));
    } catch {
      // never interfere with page execution
    }
    return origError.apply(this, args);
  };

  window.addEventListener('error', (event) => {
    const loc = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : '';
    pushError('uncaught', `${event.message || 'Script error'}${loc}`);
  });

  window.addEventListener('unhandledrejection', (event) => {
    pushError('unhandledrejection', formatArg(event.reason));
  });

  window.addEventListener('__lfs_request_errors__', () => {
    window.dispatchEvent(
      new CustomEvent('__lfs_response_errors__', {
        detail: buffer.slice()
      })
    );
  });
})();
