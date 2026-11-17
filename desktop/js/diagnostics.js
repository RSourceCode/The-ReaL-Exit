/** Captures renderer logs for the in-app Diagnostics panel and DevTools console. */
const MAX_LOG_ENTRIES = 500;
const entries = [];

function format(value) {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

export function installDiagnostics() {
  if (window.gameDiagnostics) return window.gameDiagnostics;

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      const time = new Date().toLocaleTimeString();
      entries.push({ level, time, message: args.map(format).join(' ') });
      if (entries.length > MAX_LOG_ENTRIES) entries.shift();
      original(...args);
    };
  }

  const diagnostics = {
    getLogs() { return entries.map(({ time, level, message }) => `[${time}] ${level.toUpperCase()} ${message}`).join('\n'); },
    clear() { entries.length = 0; console.info('[diagnostics] log cleared'); },
  };
  window.gameDiagnostics = diagnostics;

  window.addEventListener('error', (event) => {
    console.error('[window] uncaught error', event.error || event.message, event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : '');
  });
  window.addEventListener('unhandledrejection', (event) => {
    console.error('[window] unhandled promise rejection', event.reason);
  });

  console.info('[boot] renderer diagnostics installed');
  return diagnostics;
}
