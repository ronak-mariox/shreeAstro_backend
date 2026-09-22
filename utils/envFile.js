/**
 * Reads and writes the `.env` file directly.
 *
 * Used only by services/integrations.service.js, so that when an admin saves
 * a third-party credential on the panel, it lands in the same file every
 * other secret in this app already lives in (see config/env.js) — not a
 * separate encrypted database row — and the change takes effect on this
 * running process immediately, without a restart.
 *
 * This only works for a long-running, single-instance, self-hosted server.
 * A serverless deployment's filesystem is read-only in production, which is
 * exactly why this is not wired into the Vercel entry point (api/index.js) —
 * third-party config there would have to keep coming from real deployment
 * environment variables instead.
 */

const fs = require('fs');
const path = require('path');

/** Same resolution dotenv itself uses by default, so a write always lands in the file a read already came from. */
const ENV_PATH = path.resolve(process.cwd(), '.env');

function readEnvFile() {
  try {
    return fs.readFileSync(ENV_PATH, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

/** Quotes a value when it needs it — spaces, a `#`, or an empty string — so dotenv reads it back exactly as saved. */
function formatEnvValue(value) {
  const str = String(value ?? '');
  return str === '' || /[\s#"']/.test(str) ? JSON.stringify(str) : str;
}

/**
 * Sets one or more `KEY=VALUE` pairs in the `.env` file — replacing an
 * existing line for a key that's already there, appending a new line for one
 * that isn't. Comments, blank lines and every unrelated key are left exactly
 * as they were. Every value is also mirrored onto `process.env`, which is
 * what makes the change effective immediately.
 */
function setEnvValues(values) {
  const entries = Object.entries(values);
  if (entries.length === 0) {
    return;
  }

  const remaining = new Map(entries);
  const content = readEnvFile();
  const lines = content.length ? content.split(/\r?\n/) : [];

  const updatedLines = lines.map(line => {
    const match = /^\s*([\w.-]+)\s*=/.exec(line);
    if (!match || !remaining.has(match[1])) {
      return line;
    }
    const key = match[1];
    const value = remaining.get(key);
    remaining.delete(key);
    return `${key}=${formatEnvValue(value)}`;
  });

  for (const [key, value] of remaining) {
    updatedLines.push(`${key}=${formatEnvValue(value)}`);
  }

  /** Exactly one trailing newline — not none, not a growing pile of them across repeated saves. */
  const next = `${updatedLines.join('\n').replace(/\n+$/, '')}\n`;
  fs.writeFileSync(ENV_PATH, next, 'utf8');

  for (const [key, value] of entries) {
    process.env[key] = String(value ?? '');
  }
}

module.exports = { readEnvFile, setEnvValues, ENV_PATH };
