/**
 * `toad setup`, `toad doctor` and `toad update`: everything after
 * `npm install -g`, so installing Toad is one line and updating is one more.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as p from '@clack/prompts';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT, VERSION, TEMPLATE, agentModels, applyModels, describeModels, installedAgentDir, modelReady, prepareAgent, providerReady, readCredentials, readModels, resolveAgent, saveCredential, saveModels, workflowEnv } from './agent.mjs';
import { browse, details, keyEnv, keyProviders, modelsDev, piModels, splitRef, suggestions, tryModel } from './models.mjs';
import { chooseSandbox } from '../agent/tools/toad-sandbox.mjs';

// Toad installs straight from GitHub until it is published to npm. npm fetches
// the tarball over HTTPS and falls back to an SSH clone for a private repository.
const SOURCE = 'github:mihaiiova/toad';
const CLI = join(PACKAGE_ROOT, 'mcp', 'cli.mjs');
const MIN_NODE = [22, 19];
const windows = process.platform === 'win32';
const ok = text => p.log.success(text);
const info = text => p.log.info(text);
const warn = text => p.log.warn(text);
const bad = text => p.log.error(text);
const tty = !!process.stdout.isTTY && !process.env.NO_COLOR;
const dim = text => (tty ? `\x1b[2m${text}\x1b[22m` : text);
/** A spinner on a terminal; in a log, just the outcome lines. */
function spin() {
  if (process.stdout.isTTY) return p.spinner();
  return { start() {}, message() {}, clear() {}, stop: text => text && ok(text), error: text => text && bad(text) };
}
const home = path => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', shell: windows, ...options });
}
/** `run` without blocking, so a spinner keeps turning; output is collected, not shown. */
function runQuietly(command, args, { timeout } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { shell: windows, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = timeout && setTimeout(() => child.kill(), timeout);
    child.on('error', error => { clearTimeout(timer); resolve({ status: null, output: error.message }); });
    child.on('close', status => { clearTimeout(timer); resolve({ status, output }); });
  });
}
const onPath = command => (process.env.PATH ?? '').split(delimiter).some(dir => ['', '.cmd', '.exe'].some(ext => existsSync(join(dir, command + ext))));

const interactiveRun = options => process.stdin.isTTY && process.stdout.isTTY && !options.yes;
/** A prompt's answer; Ctrl-C or Esc ends setup. */
function answer(value) {
  if (p.isCancel(value)) { p.cancel('Setup stopped. Run `toad setup` again to finish.'); process.exit(130); }
  return value;
}
async function confirm(message, options, fallback = true) {
  if (!interactiveRun(options)) return fallback;
  return answer(await p.confirm({ message, initialValue: fallback }));
}

/** The command a coding agent should start: `toad mcp` when that is us, else node with our path. */
function serverCommand() {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    try { if (realpathSync(join(dir, 'toad')) === realpathSync(CLI)) return ['toad', 'mcp']; } catch {}
  }
  return [process.execPath, CLI, 'mcp'];
}

const CLIENTS = [
  { name: 'Claude Code', command: 'claude',
    registered: () => run('claude', ['mcp', 'get', 'toad']).status === 0,
    add: cmd => run('claude', ['mcp', 'add', '--scope', 'user', 'toad', '--', ...cmd]) },
  { name: 'Codex', command: 'codex',
    registered: () => /^toad\b/m.test(run('codex', ['mcp', 'list']).stdout ?? ''),
    add: cmd => run('codex', ['mcp', 'add', 'toad', '--', ...cmd]) },
  { name: 'Pi', command: 'pi',
    registered: () => !!piConfig()?.mcpServers?.toad,
    // The command line Pi starts, to notice a registration pointing at another copy of Toad.
    current: () => { const entry = piConfig()?.mcpServers?.toad; return entry ? [entry.command, ...(entry.args ?? [])] : null; },
    add: cmd => {
      const { command: _c, args: _a, ...previous } = piConfig()?.mcpServers?.toad ?? {};
      const result = run('pi', ['mcp', 'add', 'toad', '--', ...cmd]);
      const config = piConfig();
      if (result.status === 0 && config?.mcpServers?.toad) {
        // Keep the user's other settings for the entry; tests take minutes, longer than Pi's default timeout.
        config.mcpServers.toad = { requestTimeoutMs: 900000, ...previous, ...config.mcpServers.toad };
        writeFileSync(piConfigPath(), JSON.stringify(config, null, 2) + '\n');
      }
      return result;
    } },
];
const piConfigPath = () => join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'mcp.json');
function piConfig() { try { return JSON.parse(readFileSync(piConfigPath(), 'utf8')); } catch { return null; } }

function playwrightSpec(agent) {
  try {
    const args = JSON.parse(readFileSync(join(agent, '.pi', 'mcp.json'), 'utf8')).mcpServers.playwright.args;
    return args.find(a => a.startsWith('@playwright/mcp@'));
  } catch { return null; }
}

function browserInstalled() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
      : windows ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'ms-playwright')
        : join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'ms-playwright')].filter(Boolean);
  return roots.some(root => { try { return readdirSync(root).some(name => name.startsWith('chrom')); } catch { return false; } });
}

function nodeOk() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

// Providers most people have a key for, listed first; every other provider Pi supports follows. Not a model list.
const COMMON = ['anthropic', 'openai', 'google', 'openrouter', 'deepseek', 'xai', 'mistral'];

const ROLES = {
  lead: { title: 'Lead', about: 'plans each test and writes the report' },
  tester: { title: 'Tester', about: 'runs the scenarios, where most of the cost is' },
};

/** Ask for a provider, searchable; those with a key already available first. */
async function chooseProvider(role, providers, current) {
  const saved = readCredentials();
  const has = q => (saved[q.env] ? 'key saved' : process.env[q.env] ? 'key in your environment' : undefined);
  const rank = q => (has(q) ? 0 : COMMON.includes(q.provider) ? 1 + COMMON.indexOf(q.provider) / 100 : 2);
  const sorted = [...providers].sort((a, b) => rank(a) - rank(b) || a.provider.localeCompare(b.provider));
  return answer(await p.autocomplete({
    message: `${ROLES[role].title} provider ${dim('(type to search all)')}`,
    options: sorted.map(q => ({ value: q.provider, label: has(q) ? `${q.provider}  ${dim(has(q))}` : q.provider })),
    initialValue: current, maxItems: 8,
  }));
}

/** Menu options for models, their details lined up in a dimmed column. */
function withDetails(models) {
  const width = Math.max(0, ...models.map(m => m.id.length));
  return models.map(m => ({ value: m.ref, label: `${m.id.padEnd(width)}  ${dim(details(m))}` }));
}

const SEARCH = Symbol('search');
const BACK = Symbol('back');
/** Ask for one of `provider`'s models for `role`: the suggestions for it, or a search of every model Pi can run. BACK goes back to providers. */
async function chooseFrom(provider, role) {
  const s = spin();
  s.start(`Looking up ${provider}'s current models`);
  const [pi, dev] = await Promise.all([piModels(provider), modelsDev()]);
  s.clear();
  if (!pi.live) warn('Could not reach pi.dev; listing the models bundled with this Pi version');
  if (!dev) warn('Could not reach models.dev, so there are no suggestions; search instead');
  if (!pi.models.length) { bad(`Pi lists no models for ${provider}`); return BACK; }
  const suggested = dev ? suggestions(provider, pi.models, dev, { tier: role }) : [];
  if (suggested.length) {
    const picked = answer(await p.select({
      message: `${ROLES[role].title} model ${dim(`(suggested for the ${role === 'lead' ? 'lead' : 'testers'}, newest first)`)}`,
      options: [...withDetails(suggested),
        { value: SEARCH, label: `Search all ${pi.models.length} models…` }, { value: BACK, label: 'Another provider' }],
    }));
    if (picked !== SEARCH) return picked;
  }
  return answer(await p.autocomplete({
    message: `${ROLES[role].title} model ${dim(`(type to search ${provider}'s models)`)}`,
    options: [...withDetails(browse(provider, pi.models, dev?.[provider])), { value: BACK, label: 'Another provider' }],
    maxItems: 10,
  }));
}

/** Ask for the model for `role`, starting from the provider of `current`. */
async function chooseRole(role, current, providers) {
  for (let provider = splitRef(current)?.provider;;) {
    provider = await chooseProvider(role, providers, provider);
    const chosen = await chooseFrom(provider, role);
    if (chosen !== BACK) return chosen;
  }
}

/** Whether Pi's catalog has `ref`, so a typo fails at setup rather than mid-test. */
async function knownModel(ref) {
  const parts = splitRef(ref);
  if (!parts) return false;
  const { models } = await piModels(parts.provider);
  return models.some(m => m.id === parts.id);
}

/**
 * Make sure there is a working key for `provider`: the saved one, one from the
 * environment, or a new one, proven with one short call to each of `refs`.
 * Returns whether the provider has credentials.
 */
async function ensureKey(agent, provider, refs, options) {
  const interactive = interactiveRun(options);
  const env = await keyEnv(provider);
  if (!env) { bad(`Toad sets up providers that use an API key, and ${provider} does not`); return false; }
  const saved = readCredentials()[env];
  let key = saved;
  if (process.env[env] && process.env[env] !== saved && await confirm(`Save the ${env} from your environment for Toad?`, options)) key = process.env[env];
  if (key && key === saved && interactive && !await confirm(`Use the ${env} you saved before?`, options)) key = undefined;
  check: for (;;) {
    if (!key && interactive) {
      key = answer(await p.password({ message: `${provider} API key ${dim(`(${env}; Enter to skip)`)}`, mask: '•' })).trim() || undefined;
    }
    // Without a key, Pi may still be signed in to the provider (a /login in the agent).
    if (!key && !providerReady(agent, provider)) {
      bad(`No ${provider} key, so tests cannot run. Run \`toad setup\` again, or set ${env} where your coding agent starts Toad.`);
      return false;
    }
    for (const ref of refs) {
      const s = spin();
      s.start(`Checking ${ref}`);
      const outcome = await tryModel(ref, workflowEnv(agent, key ? { ...process.env, [env]: key } : process.env));
      if (outcome.ok) { s.stop(`${ref} answered`); continue; }
      // Providers may quote the key back; never print it.
      const why = (key ? outcome.error.split(key).join('****') : outcome.error).split('\n')[0].slice(0, 200);
      if (!outcome.rejected) { s.clear(); warn(`Could not check ${ref}: ${why}\nKeeping the key and the choice. Run \`toad setup\` again later to check it.`); continue; }
      // A refused key is never saved; one saved earlier stays until a working one replaces it.
      s.error(`${provider} refused the ${key && key === saved ? 'saved ' : ''}key: ${why}`);
      key = undefined;
      if (interactive && await confirm('Enter a different key?', options)) continue check;
      bad(`No working ${provider} key, so tests cannot run until \`toad setup\` saves one`);
      return false;
    }
    break;
  }
  if (key && key !== saved) { saveCredential(env, key); ok(`${env} saved; only Toad reads it`); }
  return true;
}

/** The two models as setup shows them. */
function modelTable(models) {
  const width = Math.max(models.lead.length, models.tester.length);
  return Object.entries(ROLES).map(([role, r]) => `${r.title.padEnd(7)} ${models[role].padEnd(width)}  ${dim(r.about)}`).join('\n');
}

/**
 * The model step: show the lead and tester models, let the user change
 * either, make sure each provider has a working key, then point the agent at
 * them. Returns false when tests cannot run.
 */
async function chooseModels(agent, options) {
  const inAgent = agentModels(agent);
  const current = readModels() ?? { lead: inAgent.lead.model, tester: inAgent.testers[0]?.model ?? inAgent.lead.model };
  const models = { lead: options.leadModel ?? options.model ?? current.lead, tester: options.testerModel ?? options.model ?? current.tester };
  for (const flag of [options.leadModel, options.testerModel, options.model].filter(Boolean)) {
    if (!await knownModel(flag)) { bad(`Pi does not know the model ${flag}. Use provider/id, as \`pi --list-models\` prints it.`); return false; }
  }
  const flagged = options.model || options.leadModel || options.testerModel;
  if (!flagged && interactiveRun(options)) {
    p.note(modelTable(models), 'Models');
    const change = answer(await p.select({
      message: 'Keep these models?',
      options: [{ value: 'keep', label: 'Keep them' }, { value: 'lead', label: 'Change the lead model' },
        { value: 'tester', label: 'Change the tester model' }, { value: 'both', label: 'Change both' }],
    }));
    if (change !== 'keep') {
      const providers = await keyProviders();
      if (change !== 'tester') models.lead = await chooseRole('lead', models.lead, providers);
      if (change !== 'lead') models.tester = await chooseRole('tester', change === 'both' ? models.lead : models.tester, providers);
    }
  }

  let ready = true;
  const byProvider = new Map();
  for (const ref of new Set([models.lead, models.tester])) {
    const { provider } = splitRef(ref) ?? {};
    if (!provider) { bad(`${ref} is not a provider/id model`); return false; }
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), ref]);
  }
  for (const [provider, refs] of byProvider) ready = await ensureKey(agent, provider, refs, options) && ready;

  try {
    applyModels(agent, models);
    saveModels(models);
  } catch (error) { bad(error.message); return false; }
  ready = ready && modelReady(agent).every(q => q.ready);
  (ready ? ok : warn)(`Models: ${describeModels(models)}${agent === TEMPLATE ? dim(' (written to this checkout\'s agent/)') : ''}`);
  return ready;
}

export async function setup(options = {}) {
  p.intro(`Toad ${VERSION} setup`);

  if (!nodeOk()) { bad(`Node.js ${MIN_NODE.join('.')} or later is required (found ${process.versions.node})`); p.outro('Setup stopped.'); process.exitCode = 1; return; }
  ok(`Node.js ${process.versions.node}`);

  let agent = resolveAgent();
  if (agent && agent !== installedAgentDir()) ok(`Testing agent: using ${home(agent)}`);
  else {
    const s = spin();
    s.start('Preparing the testing agent');
    try { agent = prepareAgent({ log: text => s.message(text), force: options.force }); s.stop(`Testing agent ready ${dim(home(agent))}`); }
    catch (error) { s.error(error.message); p.outro('Setup stopped.'); process.exitCode = 1; return; }
  }

  const spec = playwrightSpec(agent);
  if (options.skipBrowser) warn('Browser for web tests: skipped (--skip-browser)');
  else if (!spec) bad('Could not find the Playwright version in the agent');
  else {
    const s = spin();
    // The installer is quick when the right browser is there; a newer Playwright may need a newer one.
    s.start(browserInstalled() ? 'Checking the browser for web tests' : 'Downloading Chromium for web tests (about 150 MB)');
    // Playwright's installer prints advice meant for its own projects; show its output only on failure.
    const result = await runQuietly('npx', ['-y', spec, 'install-browser', 'chrome-for-testing'], { timeout: 20 * 60 * 1000 });
    if (result.status === 0) s.stop('Browser for web tests: installed');
    else {
      s.error('The browser download failed; web tests will not work until it succeeds. Run `toad setup` again.');
      p.log.message(dim(result.output.trim().split('\n').slice(-10).join('\n')));
      process.exitCode = 1;
    }
  }

  if (!await chooseModels(agent, options)) process.exitCode = 1;

  try {
    const sandbox = chooseSandbox();
    if (sandbox.sandbox === 'container') {
      const where = `CLI tests: ${sandbox.runtime} containers`;
      const present = run(sandbox.runtime, ['image', 'inspect', sandbox.image], { stdio: 'ignore' }).status === 0;
      if (present) ok(`${where} ${dim(`(${sandbox.image})`)}`);
      else if (options.skipImage || !await confirm(`Download the CLI test image ${sandbox.image} now (about 1 GB)? Otherwise it downloads on the first CLI test.`, options)) {
        ok(`${where} ${dim(`(${sandbox.image} downloads on the first CLI test)`)}`);
      } else {
        const s = spin();
        s.start(`Downloading ${sandbox.image}`);
        const pull = await runQuietly(sandbox.runtime, ['pull', sandbox.image]);
        if (pull.status === 0) s.stop(`${where} ${dim(`(${sandbox.image})`)}`);
        else { s.clear(); warn(`${where}; the image download failed and is retried on the first CLI test`); }
      }
    } else ok('CLI tests: Bubblewrap');
  } catch (error) { warn(`CLI tests unavailable: ${error.message}. Web tests still work.`); }

  await registerClients(options);

  if (process.exitCode) p.outro('Setup finished with problems: fix the ones marked above, then run `toad setup` again.');
  else p.outro(`Done. Ask your coding agent to "set up Toad in this project and test …". See every run with ${dim('toad ui')}.`);
}

/** Offer to register Toad with the coding agents on PATH, as one checklist. */
async function registerClients(options) {
  const command = serverCommand();
  const found = CLIENTS.filter(client => onPath(client.command));
  if (options.noRegister) { warn('Coding agents: skipped (--no-register)'); return; }
  if (!found.length) { warn(`Coding agents: none found. Register Toad with your MCP client as: ${command.join(' ')}`); return; }
  const done = [], stale = [], fresh = [];
  for (const client of found) {
    if (!client.registered()) { fresh.push(client); continue; }
    const current = client.current?.();
    if (!current || current.join(' ') === command.join(' ')) done.push(client); else stale.push({ client, current });
  }
  let chosen = [...fresh, ...stale.map(x => x.client)];
  if (chosen.length && interactiveRun(options)) {
    chosen = answer(await p.multiselect({
      message: 'Register Toad with these coding agents?',
      options: [...fresh.map(client => ({ value: client, label: client.name })),
        ...stale.map(({ client, current }) => ({ value: client, label: client.name, hint: `now starts \`${current.join(' ')}\`; switch to this copy` }))],
      initialValues: chosen, required: false,
    }));
  }
  const registered = [...done.map(c => c.name)];
  for (const client of chosen) {
    const result = client.add(command);
    if (result.status === 0) registered.push(client.name);
    else bad(`${client.name}: ${(result.stderr || result.stdout || '').trim().split('\n').at(-1) || 'registration failed'}`);
  }
  if (registered.length) ok(`Coding agents: ${registered.join(', ')}`);
  const skipped = found.filter(c => !registered.includes(c.name) && !chosen.includes(c)).map(c => c.name);
  if (skipped.length) info(`Not registered: ${skipped.join(', ')}`);
  if (chosen.length) info('Restart your coding agents to pick Toad up.');
}

export async function doctor() {
  p.intro(`Toad ${VERSION}`);
  let healthy = true;
  const check = (pass, good, problem) => { if (pass) ok(good); else { bad(problem); healthy = false; } };
  check(nodeOk(), `Node.js ${process.versions.node}`, `Node.js ${MIN_NODE.join('.')}+ required (found ${process.versions.node})`);
  const agent = resolveAgent();
  check(!!agent, `Agent: ${agent}`, 'Agent not set up: run `toad setup`');
  if (agent) {
    const { lead, testers } = agentModels(agent);
    ok(`Lead model: ${lead.model}`);
    for (const model of new Set(testers.map(t => t.model))) ok(`Tester model: ${model}`);
    for (const { provider, ready } of modelReady(agent)) check(ready, `${provider}: key found`, `${provider}: no key; run \`toad setup\``);
  }
  check(browserInstalled(), 'Browser: installed', 'Browser not installed: run `toad setup`');
  try {
    const sandbox = chooseSandbox();
    ok(`CLI tests: ${sandbox.sandbox === 'container' ? `${sandbox.runtime} (${sandbox.image})` : 'Bubblewrap'}`);
  } catch (error) { warn(`CLI tests unavailable: ${error.message}`); }
  for (const client of CLIENTS.filter(c => onPath(c.command))) {
    if (client.registered()) ok(`${client.name}: registered`); else warn(`${client.name}: not registered (toad setup offers it)`);
  }
  p.outro(healthy ? 'Toad is ready.' : 'Fix the problems above; `toad setup` fixes most of them.');
  if (!healthy) process.exitCode = 1;
}

/** Install the latest version from GitHub, or with `from`, the version in a local checkout. */
export async function update({ from } = {}) {
  if (existsSync(join(PACKAGE_ROOT, '.git'))) {
    console.log(`This is a git checkout (${PACKAGE_ROOT}). Update it with: git pull && npm install`);
    return;
  }
  if (from) {
    console.log(`Updating from ${from}…`);
    const { installLocal } = await import(pathToFileURL(join(from, 'scripts', 'install-local.mjs')).href);
    try { installLocal(from); } catch (error) { console.error(error.message); process.exitCode = 1; return; }
  } else {
    console.log(`Updating from ${SOURCE}…`);
    const install = run('npm', ['install', '--global', SOURCE], { stdio: 'inherit', encoding: undefined });
    if (install.status !== 0) { console.error('npm could not install the update.'); process.exitCode = 1; return; }
  }
  // The files on disk are the new version now; let it prepare its own agent.
  const next = spawnSync(process.execPath, [CLI, 'setup', '--yes', '--no-register', '--skip-image'], { stdio: 'inherit' });
  if (next.status !== 0) { process.exitCode = next.status ?? 1; return; }
  console.log('Restart your coding agents to use the new version.');
}


