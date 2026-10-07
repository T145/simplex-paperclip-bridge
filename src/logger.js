// Minimal leveled logger. Writes to stderr so stdout stays available for
// structured tooling. No external dependencies.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function normalizeLevel(level) {
  const key = String(level ?? "info").toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, key) ? key : "info";
}

export function createLogger(level = "info", sink = console) {
  const threshold = LEVELS[normalizeLevel(level)];

  function write(name, args) {
    if (LEVELS[name] < threshold) return;
    const line = `[${new Date().toISOString()}] ${name.toUpperCase()} ${args
      .map(formatArg)
      .join(" ")}`;
    sink.error(line);
  }

  return {
    level: normalizeLevel(level),
    debug: (...args) => write("debug", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
    child: (prefix) => {
      const base = createLogger(level, sink);
      const wrap = (name) => (...args) => base[name](prefix, ...args);
      return {
        level: base.level,
        debug: wrap("debug"),
        info: wrap("info"),
        warn: wrap("warn"),
        error: wrap("error"),
        child: (more) => base.child(`${prefix} ${more}`),
      };
    },
  };
}

function formatArg(arg) {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack || arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}
