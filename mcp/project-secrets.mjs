import { constants, openSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// A deliberately small dotenv grammar: NAME=value, single/double quoted or
// unquoted, one entry per line. No interpolation, commands, or shell escapes.
// Only explicitly requested values are returned; errors never contain values.
export function resolveSecretReferences(folder, credentials) {
  const names = Object.values(credentials ?? {}).map(ref => ref.env);
  if (!names.length) return {}; 
  const requested = new Set(names);
  if (requested.size !== names.length) throw new Error('Each credential must reference a distinct environment name');
  let fd;
  try {
    fd = openSync(join(folder, '.env'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) throw new Error('Credential store must be a regular file');
    const text = readFileSync(fd, 'utf8');
    const seen = new Set();
    const selected = Object.create(null);
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (!match) throw new Error('Malformed project .env entry');
      const [, name, value] = match;
      if (value.includes('\u0000')) throw new Error('Malformed project .env entry');
      if (seen.has(name)) throw new Error('Duplicate name in project .env');
      seen.add(name);
      if (value.startsWith('"') || value.startsWith("'")) {
        if (value.length < 2 || !value.endsWith(value[0]) || value.slice(1, -1).includes(value[0])) throw new Error('Malformed quoted project .env entry');
      } else if (value.includes('"') || value.includes("'") || value.includes('\u0000')) {
        throw new Error('Malformed project .env entry');
      }
      if (requested.has(name)) {
        const decoded = value.startsWith('"') || value.startsWith("'") ? value.slice(1, -1) : value;
        if (!decoded) throw new Error(`Empty referenced environment variable: ${name}`);
        selected[name] = decoded;
      }
    }
    for (const name of requested) if (!seen.has(name)) throw new Error(`Missing referenced environment variable: ${name}`);
    return selected;
  } catch (error) {
    if (error.code) throw new Error('Cannot safely read project .env');
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
