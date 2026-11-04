import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { browse, callOutcome, details, keyEnv, keyProviders, piModels, splitRef, suggestions } from '../models.mjs';

const pi = ids => ids.map(id => ({ id, name: id, cost: { input: 1, output: 5 }, contextWindow: 400000 }));
const entry = models => ({ models: Object.fromEntries(models.map(m => [m.id, { tool_call: true, ...m }])) });
/** A models.dev catalog with `models` under `provider`. */
const dev = (models, provider = 'openai', extra = {}) => ({ [provider]: entry(models), ...extra });

test('suggests the newest model of each family, newest first', () => {
  const list = suggestions('openai', pi(['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-5']), dev([
    { id: 'gpt-6-sol', family: 'gpt-sol', release_date: '2026-09-22' },
    { id: 'gpt-6.1-sol', family: 'gpt-sol', release_date: '2026-09-29' },
    { id: 'gpt-6.1-terra', family: 'gpt-terra', release_date: '2026-10-26' },
    { id: 'gpt-6-luna', family: 'gpt-luna', release_date: '2026-09-22' },
    { id: 'gpt-5', family: 'gpt', release_date: '2025-08-07' },
  ]));
  assert.deepEqual(list.map(m => m.ref), ['openai/gpt-6.1-terra', 'openai/gpt-6.1-sol', 'openai/gpt-6-luna']);
});

test('a model released after this version shows up without a release', () => {
  const before = dev([{ id: 'gpt-6.1-sol', family: 'gpt-sol', release_date: '2026-09-29' }]);
  assert.equal(suggestions('openai', pi(['gpt-6.1-sol']), before)[0].id, 'gpt-6.1-sol');
  // Tomorrow both catalogs list gpt-6.2-sol; nothing in Toad changes.
  const after = dev([...Object.values(before.openai.models), { id: 'gpt-6.2-sol', family: 'gpt-sol', release_date: '2026-12-01' }]);
  assert.equal(suggestions('openai', pi(['gpt-6.1-sol', 'gpt-6.2-sol']), after)[0].id, 'gpt-6.2-sol');
});

test('skips models Pi cannot run, that do not call tools, aliases, snapshots and experimental ones', () => {
  const list = suggestions('openai', pi(['only-pi', 'no-tools', 'chat-latest', 'model-2026-08-06', 'model-20260806', 'exp', 'modes', 'free:free']), dev([
    { id: 'only-dev', release_date: '2026-10-01' },
    { id: 'no-tools', release_date: '2026-10-01', tool_call: false },
    { id: 'chat-latest', release_date: '2026-10-01' },
    { id: 'model-2026-08-06', release_date: '2026-08-06' },
    { id: 'model-20260806', release_date: '2026-08-06' },
    { id: 'exp', release_date: '2026-10-01', experimental: true },
    // models.dev also uses `experimental` for optional modes of a released model.
    { id: 'modes', release_date: '2026-10-01', experimental: { modes: { fast: {} } } },
    { id: 'free:free', release_date: '2026-10-01' },
  ]));
  assert.deepEqual(list.map(m => m.id), ['modes']);
});

test('gateways suggest one model per vendor that has an API of its own', () => {
  const ids = ['z-ai/glm-5.3', 'particle-ai/particle-1', 'openai/gpt-6.1-terra', 'openai/gpt-6.1-sol', 'anthropic/claude-sonnet-5-5'];
  const list = suggestions('openrouter', pi(ids), dev([
    { id: 'z-ai/glm-5.3', family: 'glm', release_date: '2026-11-02' },
    { id: 'particle-ai/particle-1', release_date: '2026-10-28' },
    { id: 'openai/gpt-6.1-terra', family: 'gpt-terra', release_date: '2026-10-26' },
    { id: 'openai/gpt-6.1-sol', family: 'gpt-sol', release_date: '2026-09-29' },
    { id: 'anthropic/claude-sonnet-5-5', family: 'claude-sonnet', release_date: '2026-09-28' },
  ], 'openrouter', { zai: entry([]), openai: entry([]), anthropic: entry([]) }));
  assert.deepEqual(list.map(m => m.id), ['z-ai/glm-5.3', 'openai/gpt-6.1-terra', 'anthropic/claude-sonnet-5-5']);
});

test('lead suggestions are the pricier current families, tester suggestions the cheaper ones', () => {
  const ids = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-4-1'];
  const costs = { 'claude-haiku-5-5': [0.1, 0.5], 'claude-sonnet-5-5': [2, 10], 'claude-opus-5-5': [4, 20], 'claude-fable-5-1': [10, 50], 'claude-opus-4-1': [15, 75] };
  const models = ids.map(id => ({ id, cost: { input: costs[id][0], output: costs[id][1] } }));
  const catalog = dev([
    { id: 'claude-haiku-5-5', family: 'claude-haiku', release_date: '2026-10-07' },
    { id: 'claude-sonnet-5-5', family: 'claude-sonnet', release_date: '2026-09-28' },
    { id: 'claude-opus-5-5', family: 'claude-opus', release_date: '2026-09-22' },
    { id: 'claude-fable-5-1', family: 'claude-fable', release_date: '2026-09-01' },
    { id: 'claude-opus-4-1', family: 'claude-opus-old', release_date: '2025-08-05' },
  ], 'anthropic');
  assert.deepEqual(suggestions('anthropic', models, catalog, { tier: 'lead' }).map(m => m.id), ['claude-opus-5-5', 'claude-fable-5-1']);
  assert.deepEqual(suggestions('anthropic', models, catalog, { tier: 'tester' }).map(m => m.id), ['claude-haiku-5-5', 'claude-sonnet-5-5']);
});

test('an old flagship does not crowd out the current generation', () => {
  // A cheap new generation with a pricier model from half a year ago.
  const models = [{ id: 'new-big', cost: { input: 2, output: 10 } }, { id: 'new-small', cost: { input: 0.1, output: 0.5 } }, { id: 'old-big', cost: { input: 5, output: 30 } }];
  const catalog = dev([
    { id: 'new-big', family: 'big', release_date: '2026-10-01' },
    { id: 'new-small', family: 'small', release_date: '2026-09-20' },
    { id: 'old-big', family: 'old', release_date: '2026-04-01' },
  ]);
  assert.deepEqual(suggestions('openai', models, catalog, { tier: 'lead' }).map(m => m.id), ['new-big']);
  assert.deepEqual(suggestions('openai', models, catalog, { tier: 'tester' }).map(m => m.id), ['new-small']);
});

test('a provider with one current model suggests it for both roles', () => {
  const catalog = dev([{ id: 'grok-4.7', family: 'grok', release_date: '2026-09-21' }], 'xai');
  for (const tier of ['lead', 'tester']) assert.deepEqual(suggestions('xai', pi(['grok-4.7']), catalog, { tier }).map(m => m.id), ['grok-4.7']);
});

test('no models.dev data means no suggestions, but browsing still lists every Pi model', () => {
  assert.deepEqual(suggestions('deepseek', pi(['deepseek-flash']), undefined), []);
  assert.deepEqual(browse('deepseek', pi(['deepseek-flash', 'deepseek-v4-pro']), undefined, 'pro').map(m => m.ref), ['deepseek/deepseek-v4-pro']);
});

test('menus show release date, price and context', () => {
  assert.equal(details({ id: 'm', released: '2026-10-26', input: 1, output: 5, context: 400000 }), '2026-10-26 · $1 in / $5 out per M tokens · 400K context');
  assert.equal(details({ id: 'm', context: 1000000 }), '1M context');
});

test('splitRef keeps the slashes of OpenRouter IDs', () => {
  assert.deepEqual(splitRef('openrouter/moonshotai/kimi-k3'), { provider: 'openrouter', id: 'moonshotai/kimi-k3' });
  assert.equal(splitRef('deepseek'), null);
  assert.equal(splitRef('deepseek/'), null);
});

test('key variables come from Pi', async () => {
  assert.equal(await keyEnv('deepseek'), 'DEEPSEEK_API_KEY');
  assert.equal(await keyEnv('anthropic'), 'ANTHROPIC_API_KEY');
  assert.equal(await keyEnv('openrouter'), 'OPENROUTER_API_KEY');
  assert.equal(await keyEnv('openai-codex'), undefined, 'sign-in providers are not offered');
  const providers = (await keyProviders()).map(p => p.provider);
  for (const p of ['anthropic', 'openai', 'google', 'deepseek', 'openrouter']) assert.ok(providers.includes(p), p);
});

test('the live catalog adds to the bundled one, and its absence falls back to it', async () => {
  const live = await piModels('deepseek', { fetchJson: async () => ({ models: [{ id: 'deepseek-v9', type: 'chat' }, { id: 'img', type: 'image' }] }) });
  assert.equal(live.live, true);
  assert.ok(live.models.some(m => m.id === 'deepseek-v9'));
  assert.ok(!live.models.some(m => m.id === 'img'));
  assert.ok(live.models.some(m => m.id === 'deepseek-flash'), 'bundled models stay');
  const offline = await piModels('deepseek', { fetchJson: async () => { throw new Error('offline'); } });
  assert.equal(offline.live, false);
  assert.ok(offline.models.some(m => m.id === 'deepseek-flash'));
});

test('a one-shot call succeeds only when the model answered', () => {
  const end = message => JSON.stringify({ type: 'agent_end', messages: [{ role: 'user' }, { role: 'assistant', ...message }] });
  assert.deepEqual(callOutcome(`{"type":"session"}\n${end({ stopReason: 'stop', content: [{ type: 'text', text: 'OK' }] })}\n`), { ok: true });
  assert.deepEqual(callOutcome(end({ stopReason: 'error', errorMessage: '401: invalid key' })), { ok: false, error: '401: invalid key', rejected: true });
  assert.equal(callOutcome(end({ stopReason: 'error', errorMessage: '503 Service Unavailable' })).rejected, false, 'an outage is not a refused key');
  assert.deepEqual(callOutcome('', 'Warning: noise\nNo API key found for openai.\n  /path/to/docs/models.md\n'), { ok: false, error: 'No API key found for openai.', rejected: true });
});

// The checkout's agent: assign the models, and check every file that carries one follows.
const checkoutAgent = resolve(import.meta.dirname, '../../agent');
test('applyModels points the lead and the testers at the chosen models in the native files', async t => {
  const config = mkdtempSync(join(tmpdir(), 'toad-config-'));
  const dir = join(mkdtempSync(join(tmpdir(), 'toad-agent-')), 'agent');
  t.after(() => { rmSync(config, { recursive: true, force: true }); rmSync(dirname(dir), { recursive: true, force: true }); });
  cpSync(checkoutAgent, dir, { recursive: true, filter: p => !p.includes('.faur') && !p.includes(join('.pi', 'git')) && !p.includes(join('.pi', 'npm')) });
  process.env.TOAD_CONFIG_DIR = config;
  const { agentModels, applyModels, readModels, saveModels } = await import('../agent.mjs');
  const yamlBefore = readFileSync(join(dir, '.pi/system.yaml'), 'utf8');

  const models = { lead: 'anthropic/claude-sonnet-5-5', tester: 'openrouter/moonshotai/kimi-k3' };
  assert.equal(applyModels(dir, models), true);
  const after = agentModels(dir);
  assert.equal(after.lead.model, models.lead);
  assert.ok(after.testers.length >= 2 && after.testers.every(a => a.model === models.tester));
  for (const name of after.testers.map(a => a.name)) assert.match(readFileSync(join(dir, '.pi/agents', `${name}.md`), 'utf8'), /^model: openrouter\/moonshotai\/kimi-k3$/m);
  const settings = JSON.parse(readFileSync(join(dir, '.pi/settings.json'), 'utf8'));
  assert.deepEqual([settings.defaultProvider, settings.defaultModel], ['anthropic', 'claude-sonnet-5-5']);
  // Only the model values change: comments and formatting are the developer's.
  const changed = (a, b) => a.split('\n').filter((line, i) => line !== b.split('\n')[i]);
  const yamlAfter = readFileSync(join(dir, '.pi/system.yaml'), 'utf8');
  assert.equal(yamlAfter.split('\n').length, yamlBefore.split('\n').length);
  assert.ok(changed(yamlAfter, yamlBefore).every(line => /^\s*model: (anthropic\/claude-sonnet-5-5|openrouter\/moonshotai\/kimi-k3)$/.test(line)));
  assert.equal(applyModels(dir, models), false, 'nothing to change the second time');
  assert.throws(() => applyModels(dir, { lead: 'no-provider', tester: models.tester }), /provider\/id/);

  assert.equal(readModels(), null);
  saveModels(models);
  assert.deepEqual(readModels(), models);
  delete process.env.TOAD_CONFIG_DIR;
});
