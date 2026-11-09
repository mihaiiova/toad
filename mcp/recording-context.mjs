/** Minimal saved-target provenance, outside executable/proof-checked recording folders. */
import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { underBase, validWebUrl } from '../agent/tools/toad-web-recording.mjs';
import { SUITE_NAME } from './projects.mjs';
import { definitionError, validateDefinition } from './definition-diagnostics.mjs';
import { readRecordingFile, recordingHash, recordingText, validateRecordingDefinition } from './recordings.mjs';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z.object({ version: z.literal(1), entries: z.record(digest, z.object({ envelopeHash: digest, originalTarget: z.string().max(2048).refine(validWebUrl) }).strict()).refine(v => Object.keys(v).length <= 1000) }).strict();
function contextPath(project, suite) {
  if (typeof suite !== 'string' || !SUITE_NAME.test(suite)) throw new Error('Invalid suite name');
  return join(project, '.toad', 'suites', `${suite}.recording-context.json`);
}

export function readRecordingContext(project, suite) {
  const file = contextPath(project, suite);
  let value;
  try { value = readRecordingFile(file, 1024 * 1024); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, entries: {} }; throw error; }
  return validateRecordingDefinition(value, schema, file);
}

/** Common whole-segment confinement for both HTTP and web projections. */
export function recordingUnder(envelope, base) {
  if (envelope.kind === 'cli') return true;
  const urls = envelope.kind === 'web' ? envelope.payload.steps.filter(s => s.action === 'goto').map(s => s.url) : [envelope.payload.url];
  return urls.every(url => underBase(url, base));
}

export function originalTargetMatches(context, envelope) {
  const entry = context.entries[envelope.scenarioId];
  return !!entry && entry.envelopeHash === recordingHash(envelope) && recordingUnder(envelope, entry.originalTarget);
}

/** Publish context first: an interrupted envelope update never grants a stale-target exception. */
export function writeRecordingContext(project, suite, envelope, target) {
  if (envelope.kind === 'cli') return;
  const file = contextPath(project, suite);
  if (!validWebUrl(target) || !recordingUnder(envelope, target)) throw definitionError(null, { code: 'unsafe', path: ['target', 'url'] }, { file, remedy: 'Use a credential-free HTTP(S) target and re-record within it.' });
  const parent = join(project, '.toad', 'suites');
  if (!lstatSync(parent).isDirectory() || realpathSync(parent) !== parent) throw new Error('Saved recording context needs a plain suites folder');
  const context = readRecordingContext(project, suite);
  context.entries[envelope.scenarioId] = { envelopeHash: recordingHash(envelope), originalTarget: target };
  validateDefinition({ data: context }, schema, file);
  const text = recordingText(context);
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw definitionError(null, { code: 'unsafe' }, { file, remedy: 'Reduce saved target context below 1 MiB and re-record.' });
  const temp = join(parent, `.context-${randomUUID()}`);
  try {
    writeFileSync(temp, text, { flag: 'wx', mode: 0o644 });
    // Do not replace a symlink with trusted-looking metadata.
    try { if (!lstatSync(file).isFile() || realpathSync(file) !== file) throw new Error('Unsafe saved recording context'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    renameSync(temp, file);
  } finally { try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
