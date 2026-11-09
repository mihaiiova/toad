/** Source-aware definition errors. Never render parser messages, source or literal values. */
import { LineCounter, parseDocument } from 'yaml';

const fields = new Set(('web cli api url workdir program image setup path spec models lead tester timeout_minutes kind title target goal tags writes credentials env allow_installs scenarios name steps expected limitations version status scenarioId intentHash codec payload args expect exitCode stdout equals contains method headers body action value role label text assertion request context entries envelopeHash originalTarget').split(' '));
const displayPath = path => path.length ? path.map(p => typeof p === 'number' ? p : fields.has(p) ? p : '[entry]').join('.') : '(root)';

export function definitionDiagnostic(document, issue, { file = 'definition', remedy = 'Edit this field to the supported schema, then retry.', explanation: override } = {}) {
  const path = issue.path ?? [];
  let node = document?.doc?.contents;
  // Fall back to the nearest existing parent for a missing required field.
  for (const part of path) {
    const child = node?.get?.(part, true);
    if (!child) break;
    node = child;
  }
  const offset = issue.offset ?? node?.range?.[0];
  const pos = Number.isInteger(offset) && document?.lines ? document.lines.linePos(offset) : null;
  const explanation = override ?? (issue.code === 'syntax' ? 'Malformed definition syntax'
    : issue.code === 'custom' && issue.message === 'scenario names must be distinct' ? 'Scenario names must be distinct'
    : issue.code === 'unrecognized_keys' ? 'Unsupported field; remove unknown fields'
    : issue.code === 'codec' ? 'Unknown recording codec; use a built-in codec or re-record'
    : issue.code === 'context' ? 'Recording no longer matches the suite context'
    : issue.code === 'unsafe' ? 'Unsupported or unsafe recording data'
    : issue.code === 'read' ? 'Definition must be a bounded regular file without symlinks'
    : issue.code === 'invalid_type' && ['string', 'number', 'array', 'object', 'boolean'].includes(issue.expected) ? `Invalid or missing field; expected ${issue.expected}`
    : issue.code === 'invalid_value' ? 'Unsupported choice'
    : issue.code === 'too_small' || issue.code === 'too_big' ? 'Field is outside the supported size or numeric bounds'
    : issue.code === 'invalid_format' ? 'Field has an unsupported format'
    : 'Invalid or missing field');
  return { file, code: issue.code ?? 'schema', path: displayPath(path), ...(pos ? { line: pos.line, column: pos.col } : {}), explanation, remedy };
}

export function renderDefinitionDiagnostic(d) {
  return `${d.file}${d.line ? `:${d.line}:${d.column}` : ''}: ${d.path}: ${d.explanation}. ${d.remedy}`;
}

export class DefinitionError extends Error {
  constructor(diagnostics) {
    super(diagnostics.map(renderDefinitionDiagnostic).join('\n'));
    this.name = 'DefinitionError';
    this.diagnostics = diagnostics;
  }
}

export function definitionError(document, issue, options) {
  return new DefinitionError([definitionDiagnostic(document, issue, options)]);
}

/** JSON uses JSON.parse's grammar, with the installed YAML AST solely for ranges. */
export function definitionDocument(text, file, { json = false } = {}) {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false, uniqueKeys: true });
  const document = { doc, lines };
  if (json) {
    try { JSON.parse(text); }
    catch (error) {
      const at = /position (\d+)/.exec(error.message);
      const lc = /line (\d+) column (\d+)/.exec(error.message);
      const offset = at ? Number(at[1]) : lc ? text.split('\n').slice(0, Number(lc[1]) - 1).reduce((n, line) => n + line.length + 1, 0) + Number(lc[2]) - 1 : text.length;
      throw definitionError(document, { code: 'syntax', offset }, { file, remedy: 'Fix the JSON syntax; no source excerpts are displayed.' });
    }
  }
  if (doc.errors.length) throw definitionError(document, { code: 'syntax', offset: doc.errors[0].pos?.[0] ?? 0 }, { file, remedy: `Fix the ${json ? 'JSON' : 'YAML'} syntax; no source excerpts are displayed.` });
  let data;
  try { data = json ? JSON.parse(text) : doc.toJS({ maxAliasCount: 100 }); }
  catch { throw definitionError(document, { code: 'syntax', offset: 0 }, { file, remedy: 'Remove excessive aliases or unsupported document constructs.' }); }
  return { ...document, data };
}

export function validateDefinition(document, schema, file, data = document.data) {
  const result = schema.safeParse(data);
  if (!result.success) throw new DefinitionError(result.error.issues.map(issue => definitionDiagnostic(document, issue, { file })));
  return result.data;
}
