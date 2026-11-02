/**
 * `toad setup`, `toad doctor` and `toad update`: everything after
 * `npm install -g`, so installing TOaD is one line and updating is one more.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT, VERSION, installedAgentDir, modelReady, prepareAgent, readCredentials, resolveAgent, saveCredential } from './agent.mjs';
import { chooseSandbox } from '../agent/tools/toad-sandbox.mjs';

const NAME = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).name;
const CLI = join(PACKAGE_ROOT, 'mcp', 'cli.mjs');
const KEY = 'DEEPSEEK_API_KEY';
const MIN_NODE = [22, 19];
const windows = process.platform === 'win32';
const ok = text => console.log(`  ✓ ${text}`);
const warn = text => console.log(`  ! ${text}`);
const bad = text => console.log(`  ✗ ${text}`);
const step = text => console.log(`\n${text}`);

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', shell: windows, ...options });
}
const onPath = command => (process.env.PATH ?? '').split(delimiter).some(dir => ['', '.cmd', '.exe'].some(ext => existsSync(join(dir, command + ext))));

function ask(question, { hidden = false } = {}) {
  return new Promise(done => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = text => { if (text.includes(question)) process.stdout.write(text); };
    rl.question(question, answer => { rl.close(); if (hidden) process.stdout.write('\n'); done(answer.trim()); });
  });
}
async function confirm(question, options, fallback = true) {
  if (options.yes || !process.stdin.isTTY) return fallback;
  const answer = (await ask(`  ${question} [${fallback ? 'Y/n' : 'y/N'}] `)).toLowerCase();
  return answer ? answer.startsWith('y') : fallback;
}

/** 'valid', 'invalid', or 'unknown' when DeepSeek could not be reached. */
async function checkKey(key) {
  try {
    const res = await fetch('https://api.deepseek.com/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
    return res.ok ? 'valid' : res.status === 401 || res.status === 403 ? 'invalid' : 'unknown';
  } catch { return 'unknown'; }
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
    // The command line Pi starts, to notice a registration pointing at another copy of TOaD.
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

export async function setup(options = {}) {
  console.log(`TOaD ${VERSION} setup`);

  step('Node.js');
  if (!nodeOk()) { bad(`Node.js ${MIN_NODE.join('.')} or later is required (found ${process.versions.node})`); process.exitCode = 1; return; }
  ok(`Node.js ${process.versions.node}`);

  step('Testing agent');
  let agent = resolveAgent();
  if (agent && agent !== installedAgentDir()) ok(`Using the agent in ${agent}`);
  else {
    try { agent = prepareAgent({ log: text => console.log(`  … ${text}`), force: options.force }); ok(`Agent ready at ${agent}`); }
    catch (error) { bad(error.message); process.exitCode = 1; return; }
  }

  step('Browser for web tests');
  const spec = playwrightSpec(agent);
  if (options.skipBrowser) warn('Skipped (--skip-browser)');
  else if (!spec) bad('Could not find the Playwright version in the agent');
  else {
    console.log(`  … Installing Chromium with ${spec} (about 150 MB the first time)`);
    // Playwright's installer prints advice meant for its own projects; show its output only on failure.
    const result = run('npx', ['-y', spec, 'install-browser', 'chrome-for-testing'], { timeout: 20 * 60 * 1000 });
    if (result.status === 0) ok('Chromium installed');
    else {
      console.log((result.stdout + result.stderr).trim().split('\n').slice(-10).map(line => `    ${line}`).join('\n'));
      bad('The browser download failed; web tests will not work until it succeeds. Run `toad setup` again.'); process.exitCode = 1;
    }
  }

  step('Model key (DeepSeek)');
  const saved = readCredentials()[KEY];
  let key = saved;
  if (process.env[KEY] && process.env[KEY] !== saved) {
    if (await confirm(`Save the ${KEY} from your environment for TOaD?`, options)) key = process.env[KEY];
  }
  if (key && key === saved && !options.yes && process.stdin.isTTY && !await confirm('A key is already saved. Keep it?', options)) key = undefined;
  const loggedIn = !key && modelReady(agent);
  while (!key && !loggedIn && process.stdin.isTTY && !options.yes) {
    key = await ask('  DeepSeek API key (https://platform.deepseek.com/api_keys): ', { hidden: true });
    if (!key) break;
    const status = await checkKey(key);
    if (status === 'invalid') { bad('DeepSeek rejected that key; try again'); key = undefined; }
    else if (status === 'unknown') warn('Could not reach DeepSeek to check the key; saving it anyway');
  }
  if (key && key !== saved) { saveCredential(KEY, key); ok('Key saved (only TOaD reads it)'); }
  else if (key) ok('Key saved earlier');
  else if (loggedIn) ok('The agent is already logged in to DeepSeek');
  else { bad(`No key: tests cannot run. Run \`toad setup\` again, or set ${KEY} where your coding agent starts TOaD.`); process.exitCode = 1; }

  step('CLI tests');
  try {
    const sandbox = chooseSandbox();
    if (sandbox.sandbox === 'container') {
      ok(`Commands run in ${sandbox.runtime} containers (${sandbox.image})`);
      const present = run(sandbox.runtime, ['image', 'inspect', sandbox.image], { stdio: 'ignore' }).status === 0;
      if (present) ok(`${sandbox.image} is available`);
      else if (options.skipImage) warn(`${sandbox.image} will download on the first CLI test`);
      else if (await confirm(`Download ${sandbox.image} now (about 1 GB)? Otherwise it downloads on the first CLI test.`, options)) {
        const pull = run(sandbox.runtime, ['pull', sandbox.image], { stdio: 'inherit', encoding: undefined });
        if (pull.status === 0) ok(`${sandbox.image} downloaded`); else warn('The download failed; it will be retried on the first CLI test');
      }
    } else ok('Commands run in Bubblewrap');
  } catch (error) { warn(`${error.message}. Web tests still work.`); }

  step('Coding agents');
  const command = serverCommand();
  const found = CLIENTS.filter(client => onPath(client.command));
  if (options.noRegister) warn('Skipped (--no-register)');
  else if (!found.length) warn(`None found. Register TOaD with your MCP client as: ${command.join(' ')}`);
  for (const client of found) {
    if (options.noRegister) break;
    if (client.registered()) {
      const current = client.current?.();
      if (!current || current.join(' ') === command.join(' ')) { ok(`${client.name}: already registered`); continue; }
      if (!await confirm(`${client.name} starts TOaD as \`${current.join(' ')}\`. Switch it to \`${command.join(' ')}\`?`, options)) { warn(`${client.name}: left as \`${current.join(' ')}\``); continue; }
    } else if (!await confirm(`Register TOaD with ${client.name}?`, options)) { warn(`${client.name}: skipped`); continue; }
    const result = client.add(command);
    if (result.status === 0) ok(`${client.name}: registered`);
    else bad(`${client.name}: ${(result.stderr || result.stdout || '').trim().split('\n').at(-1) || 'registration failed'}`);
  }
  if (found.length && !options.noRegister) console.log('  Restart your coding agents to pick TOaD up.');

  console.log(`\nDone. Ask your coding agent to "set up TOaD in this project and test …".\nSee every run with: toad ui`);
}

export async function doctor() {
  console.log(`TOaD ${VERSION}`);
  let healthy = true;
  const check = (pass, good, problem) => { if (pass) ok(good); else { bad(problem); healthy = false; } };
  check(nodeOk(), `Node.js ${process.versions.node}`, `Node.js ${MIN_NODE.join('.')}+ required (found ${process.versions.node})`);
  const agent = resolveAgent();
  check(!!agent, `Agent: ${agent}`, 'Agent not set up: run `toad setup`');
  check(!!agent && modelReady(agent), 'Model: DeepSeek key found', 'No DeepSeek key: run `toad setup`');
  check(browserInstalled(), 'Browser: installed', 'Browser not installed: run `toad setup`');
  try {
    const sandbox = chooseSandbox();
    ok(`CLI tests: ${sandbox.sandbox === 'container' ? `${sandbox.runtime} (${sandbox.image})` : 'Bubblewrap'}`);
  } catch (error) { warn(`CLI tests unavailable: ${error.message}`); }
  for (const client of CLIENTS.filter(c => onPath(c.command))) {
    if (client.registered()) ok(`${client.name}: registered`); else warn(`${client.name}: not registered (toad setup offers it)`);
  }
  const latest = run('npm', ['view', NAME, 'version'], { timeout: 10000 });
  if (latest.status === 0 && latest.stdout.trim() && latest.stdout.trim() !== VERSION) warn(`TOaD ${latest.stdout.trim()} is available: run \`toad update\``);
  if (!healthy) process.exitCode = 1;
}

/** Install the latest release, or with `from`, the version in a local checkout. */
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
    console.log(`Updating ${NAME}…`);
    const install = run('npm', ['install', '--global', `${NAME}@latest`], { stdio: 'inherit', encoding: undefined });
    if (install.status !== 0) { console.error('npm could not install the update.'); process.exitCode = 1; return; }
  }
  // The files on disk are the new version now; let it prepare its own agent.
  const next = spawnSync(process.execPath, [CLI, 'setup', '--yes', '--no-register', '--skip-image'], { stdio: 'inherit' });
  if (next.status !== 0) { process.exitCode = next.status ?? 1; return; }
  console.log('Restart your coding agents to use the new version.');
}


