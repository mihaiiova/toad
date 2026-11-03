/**
 * Which models Toad can offer, worked out when setup runs, so Toad never ships
 * a list of models:
 *
 *   - the Pi catalog (pi.dev, the feed Pi itself refreshes, over the catalog
 *     bundled with Pi) says which models Pi can run for a provider;
 *   - models.dev adds what Pi's catalog lacks: release dates, families and
 *     tool support.
 *
 * Suggestions are the newest model of each family, newest first, so a model
 * released after this version of Toad is suggested without a new release.
 * Without models.dev there are no suggestions, only the full Pi catalog.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';

const PI_CATALOG = 'https://pi.dev';
const MODELS_DEV = 'https://models.dev/api.json';
const USER_AGENT = 'toad-setup';
const windows = process.platform === 'win32';

/** `provider/id` split at the first slash (OpenRouter IDs contain more). */
export function splitRef(ref) {
  const at = typeof ref === 'string' ? ref.indexOf('/') : -1;
  return at > 0 && at < ref.length - 1 ? { provider: ref.slice(0, at), id: ref.slice(at + 1) } : null;
}

let envKeys;
/** Pi's own lookup of the variables a provider reads its key from. Not in pi-ai's export map, so found next to its entry point. */
async function findEnvKeys() {
  envKeys ??= import(new URL('./env-api-keys.js', import.meta.resolve('@earendil-works/pi-ai'))).then(m => m.findEnvKeys);
  return envKeys;
}

/**
 * The environment variable holding `provider`'s API key, as Pi reads it, or
 * undefined when the provider signs in some other way (OAuth, cloud credentials).
 */
export async function keyEnv(provider) {
  const find = await findEnvKeys();
  // An environment where every variable is set, so Pi lists every name it would read.
  const every = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? 'set' : undefined), has: () => true });
  const names = find(provider, every) ?? [];
  return names.find(name => name.endsWith('_API_KEY')) ?? names.at(-1);
}

/** Providers Toad can set up with an API key: Pi's built-in providers that read one. */
export async function keyProviders() {
  const out = [];
  for (const provider of getBuiltinProviders()) {
    const env = await keyEnv(provider);
    if (env) out.push({ provider, env });
  }
  return out;
}

async function getJson(url, timeout) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** Pi's catalog entries in any of the shapes pi.dev serves. */
function catalogEntries(value) {
  const entries = Array.isArray(value) ? value : Array.isArray(value?.models) ? value.models : value && typeof value === 'object' ? Object.values(value) : [];
  return entries.filter(m => m && typeof m.id === 'string' && (m.type === undefined || m.type === 'chat'));
}

/**
 * The chat models Pi can run for `provider`: the live pi.dev catalog over the
 * one bundled with Pi. `live` is false when pi.dev could not be reached.
 */
export async function piModels(provider, { fetchJson = getJson } = {}) {
  const byId = new Map();
  try { for (const m of getBuiltinModels(provider)) if ((m.type ?? 'chat') === 'chat') byId.set(m.id, m); } catch {}
  let live = false;
  try {
    const url = new URL(`/api/models/providers/${encodeURIComponent(provider)}`, PI_CATALOG);
    url.searchParams.set('types', 'chat');
    for (const m of catalogEntries(await fetchJson(url.href, 10000))) byId.set(m.id, m);
    live = true;
  } catch {}
  return { models: [...byId.values()], live };
}

/** models.dev's whole catalog, or null when it could not be reached. */
export async function modelsDev({ fetchJson = getJson } = {}) {
  try { return await fetchJson(MODELS_DEV, 20000); } catch { return null; }
}

// Aliases that move under you and pinned snapshots of an older release.
const ALIAS = /latest/i;
const SNAPSHOT = /-(\d{4}-\d{2}-\d{2}|\d{8}|\d{4})$/;

const plain = name => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** What a model costs per million tokens, input and output together; undefined when unknown. */
const CURRENT_DAYS = 120;
const price = m => (m.input !== undefined && m.output !== undefined ? m.input + m.output : undefined);

/**
 * The newest model of each family that Pi can run and that calls tools,
 * newest first. `pi` is piModels().models; `catalog` is models.dev's whole
 * catalog. Each suggestion carries what setup shows: release date, price per
 * million tokens and context size.
 *
 * Gateways such as OpenRouter name models `vendor/model` and carry hundreds,
 * so there only vendors that run an API of their own on models.dev count, one
 * model each.
 *
 * `tier` splits the provider's current families (released within four
 * months of its newest model) at their median price: `lead` takes those
 * above it (stronger, for planning and reporting), `tester` those at or below
 * it (cheaper, for the long tool loops). Older families stay out, so a cheap
 * new generation does not push an old flagship into the lead's list. A
 * provider with one price band suggests the same models for both.
 */
export function suggestions(provider, pi, catalog, { limit = 3, tier } = {}) {
  const known = catalog?.[provider]?.models ?? {};
  const labs = new Set(Object.keys(catalog ?? {}).map(plain));
  const newest = new Map();
  for (const model of pi) {
    const meta = known[model.id];
    if (!meta?.release_date || meta.tool_call !== true || meta.experimental === true) continue;
    if (ALIAS.test(model.id) || SNAPSHOT.test(model.id) || model.id.includes(':')) continue;
    if (meta.modalities?.output && !meta.modalities.output.includes('text')) continue;
    const vendor = model.id.includes('/') ? model.id.split('/')[0] : null;
    if (vendor && !labs.has(plain(vendor))) continue;
    const family = vendor ? `vendor:${plain(vendor)}` : meta.family || model.id;
    const entry = describe(provider, model, meta);
    const held = newest.get(family);
    if (!held || newer(entry, held)) newest.set(family, entry);
  }
  let list = [...newest.values()].sort((a, b) => (newer(a, b) ? -1 : 1));
  if (tier) {
    const current = list.filter(m => Date.parse(list[0].released) - Date.parse(m.released) <= CURRENT_DAYS * 86400000);
    list = current.length >= 2 ? current : list.slice(0, 6);
    const prices = list.map(price).filter(p => p !== undefined).sort((a, b) => a - b);
    const median = prices[Math.floor((prices.length - 1) / 2)];
    const band = prices.length < 2 ? [] : list.filter(m => price(m) !== undefined && (tier === 'lead' ? price(m) > median : price(m) <= median));
    if (band.length) list = band;
  }
  return list.slice(0, limit);
}

/** Later release first; on the same day, the shorter ID (the base name, not a variant). */
function newer(a, b) {
  if (a.released !== b.released) return a.released > b.released;
  return a.id.length < b.id.length || (a.id.length === b.id.length && a.id < b.id);
}

function describe(provider, model, meta = {}) {
  const cost = model.cost ?? meta.cost ?? {};
  return {
    ref: `${provider}/${model.id}`, id: model.id, name: model.name ?? meta.name ?? model.id,
    released: meta.release_date ?? '',
    input: typeof cost.input === 'number' ? cost.input : undefined,
    output: typeof cost.output === 'number' ? cost.output : undefined,
    context: model.contextWindow ?? meta.limit?.context,
  };
}

/** Every model Pi can run for the provider, matching `search`, for browsing. */
export function browse(provider, pi, dev, search = '') {
  const needle = search.trim().toLowerCase();
  return pi.filter(m => !needle || m.id.toLowerCase().includes(needle) || (m.name ?? '').toLowerCase().includes(needle))
    .map(m => describe(provider, m, dev?.models?.[m.id]))
    .sort((a, b) => (b.released || '').localeCompare(a.released || '') || a.id.localeCompare(b.id));
}

/** What a menu shows next to a model's ID: release date, price, context. */
export function details(m) {
  const tokens = n => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}K`);
  const price = m.input !== undefined && m.output !== undefined ? `$${m.input} in / $${m.output} out per M tokens` : '';
  return [m.released, price, m.context && `${tokens(m.context)} context`].filter(Boolean).join(' · ');
}

/** Errors that mean the key itself was refused, as opposed to an outage. */
const REJECTED = /\b(401|403)\b|authenticat|unauthori[sz]ed|invalid.{0,20}(api.?)?key|no api key/i;

/**
 * What a one-shot `pi --mode json` call printed: the model's reply, or why it
 * failed. Pi exits 0 even when the provider refused, so the events decide.
 */
export function callOutcome(stdout, stderr = '') {
  let end;
  for (const line of String(stdout).split('\n')) {
    if (!line.startsWith('{')) continue;
    try { const event = JSON.parse(line); if (event.type === 'agent_end') end = event; } catch {}
  }
  const reply = end?.messages?.filter(m => m.role === 'assistant').at(-1);
  if (reply?.stopReason === 'error' || reply?.errorMessage) {
    const error = reply.errorMessage || 'the model returned an error';
    return { ok: false, error, rejected: REJECTED.test(error) };
  }
  if (reply) return { ok: true };
  const said = String(stderr).split('\n').map(l => l.trim()).find(l => l && !l.startsWith('Warning') && !l.startsWith('/'));
  return { ok: false, error: said || 'Pi gave no answer', rejected: REJECTED.test(said ?? '') };
}

/**
 * Ask `ref` for a one-word reply through the packaged Pi, with `env` holding
 * the key. Proves the key, the model ID and access to it together, for a few
 * dozen tokens. Runs outside the agent so no project settings or packages load.
 */
export function tryModel(ref, env, timeout = 60000) {
  const cwd = mkdtempSync(join(tmpdir(), 'toad-model-'));
  return new Promise(resolve => {
    const child = spawn('pi', ['-p', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates',
      '--no-themes', '--no-context-files', '--no-mcp', '--mode', 'json', '--thinking', 'off',
      '--system-prompt', 'Answer in one word.', '--model', ref, 'Say OK'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: windows });
    let stdout = '', stderr = '', late = false;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { late = true; child.kill(); }, timeout);
    const done = outcome => { clearTimeout(timer); rmSync(cwd, { recursive: true, force: true }); resolve(outcome); };
    child.on('error', error => done({ ok: false, error: error.message }));
    child.on('close', () => done(late ? { ok: false, error: `no answer within ${timeout / 1000} seconds` } : callOutcome(stdout, stderr)));
  });
}
