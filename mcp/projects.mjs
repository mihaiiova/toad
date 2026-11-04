/**
 * The projects Toad has been set up in, and each project's own defaults.
 *
 * The list lives in <config>/projects.json so one viewer (`toad ui`) can show
 * every project's runs. A project's defaults live in its .toad/toad.yaml and
 * fill in whatever a handoff leaves out.
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { privateDir, toadDirs } from '../agent/tools/toad-dirs.mjs';

const listPath = () => join(toadDirs().config, 'projects.json');

/** A short, stable id for a project path, used in viewer URLs. */
export function projectId(path) {
  return createHash('sha256').update(path).digest('hex').slice(0, 12);
}

function readList() {
  try {
    const data = JSON.parse(readFileSync(listPath(), 'utf8'));
    return Array.isArray(data?.projects) ? data.projects.filter(p => typeof p?.path === 'string' && isAbsolute(p.path)) : [];
  } catch { return []; }
}

function writeList(projects) {
  const dir = privateDir(toadDirs().config);
  const temp = join(dir, `.projects-${randomUUID()}.json`);
  try {
    writeFileSync(temp, JSON.stringify({ projects }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temp, listPath());
  } catch (error) { rmSync(temp, { force: true }); throw error; }
}

/** Add a project to the list; a no-op when it is already there. */
export function registerProject(path) {
  const projects = readList();
  if (projects.some(p => p.path === path)) return false;
  writeList([...projects, { path, added: new Date().toISOString() }]);
  return true;
}

export function forgetProject(path) {
  const projects = readList();
  const kept = projects.filter(p => p.path !== resolve(path));
  if (kept.length === projects.length) return false;
  writeList(kept);
  return true;
}

/** Every listed project, with whether its .toad/runs folder still exists. */
export function listProjects() {
  return readList().map(p => {
    const runs = join(p.path, '.toad', 'runs');
    let present = false;
    try { present = lstatSync(runs).isDirectory(); } catch {}
    return { id: projectId(p.path), name: basename(p.path), path: p.path, runs, present };
  });
}

export const CONFIG_TEMPLATE = `# Toad settings for this project. Commit this file; it holds no secrets.
# Handoffs fill in anything they leave out from here.
#
# web:
#   url: http://localhost:3000       # where the app runs while you build it
# cli:
#   workdir: .                       # relative to the project, or absolute
#   program: node dist/cli.js        # how to invoke the program there
#   image: node:22-bookworm          # the container CLI tests run in
#   setup:                           # run once in the sandbox before any scenario
#     - npm ci --ignore-scripts
# api:
#   url: http://localhost:8080/api   # the API's base URL
#   spec: openapi.yaml               # its OpenAPI description, relative to workdir
#   workdir: .                       # folder copied into the sandbox (spec, fixtures)
#   setup: []                        # commands run once before any scenario
# models:                           # override the models from \`toad setup\` for this project
#   lead: anthropic/claude-sonnet-5-5
#   tester: anthropic/claude-haiku-5-5
# timeout_minutes: 15
#
# Saved suites for \`toad run\` live in suites/<name>.yaml; see suites/example.yaml.
`;

export const SUITE_TEMPLATE = `# A saved Toad suite. \`toad run --suite example\` runs it; commit it, it holds no secrets.
# It is a handoff (kind, target, goal, scenarios, limitations) plus tags and writes.
#
# kind: web                          # web, cli or api
# title: Smoke test of the home page
# target:                            # omitted fields come from toad.yaml; --url and --workdir override
#   url: http://localhost:3000
# goal: Check that the public pages load and link together.
# tags: [smoke]                      # \`toad run --tag smoke\` picks suites and scenarios by tag
# writes: false                      # true: may create, change or delete data; needs --allow-writes
# credentials:                       # references only: .toad/.env, or the CI environment with --env
#   email: { env: TOAD_TEST_EMAIL }
# scenarios:
#   - name: Home page loads
#     steps: Open the home page.
#     expected: The page shows the product name and a sign-in link.
#     tags: [smoke]
# limitations:
#   - Do not submit any form.
# timeout_minutes: 10
`;

const setup = z.array(z.string().min(1)).max(20).optional();
const modelRef = z.string().regex(/^[^/\s]+\/\S+$/, 'a provider/id model reference');
const configSchema = z.object({
  web: z.object({ url: z.string().url() }).strict().optional(),
  cli: z.object({ workdir: z.string().min(1).optional(), program: z.string().min(1).optional(), image: z.string().min(1).optional(), setup }).strict().optional(),
  api: z.object({ url: z.string().url().optional(), spec: z.string().min(1).optional(), workdir: z.string().min(1).optional(), image: z.string().min(1).optional(), setup }).strict().optional(),
  models: z.object({ lead: modelRef.optional(), tester: modelRef.optional() }).strict().optional(),
  timeout_minutes: z.number().int().min(1).max(60).optional(),
}).strict();

/** A file's text, refusing symlinks and anything but a regular file. */
export function readRegular(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path} must be a regular file`);
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

const issues = error => error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');

/** Read .toad/toad.yaml; an absent or all-comment file means no defaults. */
export function readProjectConfig(folder) {
  const path = join(folder, 'toad.yaml');
  if (!existsSync(path)) return {};
  const text = readRegular(path);
  let data;
  try { data = parse(text) ?? {}; }
  catch (error) { throw new Error(`.toad/toad.yaml is not valid YAML: ${error.message.split('\n')[0]}`); }
  const result = configSchema.safeParse(data);
  if (!result.success) throw new Error(`.toad/toad.yaml: ${issues(result.error)}`);
  return result.data;
}

/** The .toad folder of a project path, which must be absolute and canonical. */
export function projectFolder(path) {
  if (!isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error('project_path must be an absolute path without traversal');
  const project = resolve(path);
  if (realpathSync(project) !== project || !statSync(project).isDirectory()) throw new Error('project_path must be an existing canonical directory without symlinks');
  return join(project, '.toad');
}

/** Insist that .toad/.gitignore keeps secrets and runs out of git. */
export function checkIgnore(path) {
  const rules = readRegular(path).split(/\r?\n/).map(line => line.trim());
  if (!rules.includes('.env') || !rules.includes('runs/') || rules.some(line => line.startsWith('!'))) {
    throw new Error('Ensure .toad/.gitignore contains .env and runs/ and no negation rules');
  }
}

export function ensureDirectory(path) {
  try {
    if (!lstatSync(path).isDirectory()) throw new Error(`Not a directory: ${path}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    mkdirSync(path, { mode: 0o700 });
  }
}

export function createIfMissing(path, text, mode = 0o600) {
  try { writeFileSync(path, text, { flag: 'wx', mode }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const tags = z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'letters, digits, ., _ or -')).max(20).optional();
export const suiteSchema = z.object({
  kind: z.enum(['web', 'cli', 'api']),
  title: z.string().min(1).max(120).optional(),
  target: z.object({
    url: z.string().url().optional(), workdir: z.string().min(1).optional(), program: z.string().min(1).optional(),
    spec: z.string().min(1).optional(), image: z.string().min(1).optional(), setup,
  }).strict().optional(),
  goal: z.string().min(1),
  tags,
  writes: z.boolean().optional(),
  credentials: z.record(z.string(), z.object({ env: envName }).strict()).optional(),
  allow_installs: z.boolean().optional(),
  scenarios: z.array(z.object({ name: z.string().min(1), steps: z.string().min(1), expected: z.string().min(1), tags }).strict()).min(1),
  limitations: z.array(z.string()).optional(),
  timeout_minutes: z.number().int().min(1).max(60).optional(),
}).strict().superRefine((suite, ctx) => {
  const names = suite.scenarios.map(s => s.name.trim().toLowerCase());
  names.forEach((name, i) => { if (names.indexOf(name) !== i) ctx.addIssue({ code: 'custom', path: ['scenarios', i, 'name'], message: 'scenario names must be distinct' }); });
});

/**
 * The project's saved suites, from .toad/suites/<name>.yaml, by name. A
 * suite that does not parse is an error naming the file, never skipped.
 */
export function readSuites(folder) {
  const dir = join(folder, 'suites');
  let files;
  try { files = readdirSync(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const suites = [];
  for (const entry of files.sort((a, b) => a.name.localeCompare(b.name))) {
    const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\.ya?ml$/.exec(entry.name);
    if (!match) continue;
    const path = join(dir, entry.name);
    let data;
    try { data = parse(readRegular(path)); }
    catch (error) { throw new Error(`.toad/suites/${entry.name} is not valid YAML: ${error.message.split('\n')[0]}`); }
    // A file of comments only, such as the example, is not a suite.
    if (data == null) continue;
    const result = suiteSchema.safeParse(data);
    if (!result.success) throw new Error(`.toad/suites/${entry.name}: ${issues(result.error)}`);
    if (suites.some(s => s.name === match[1])) throw new Error(`Two files define the suite ${match[1]}`);
    suites.push({ name: match[1], path, ...result.data });
  }
  return suites;
}

/** A suite as the handoff a run takes; tags and writes stay with the suite. */
export function suiteHandoff(suite, scenarios = suite.scenarios) {
  const limitations = [...(suite.limitations ?? []),
    ...(suite.writes ? [] : ['This suite is declared read-only: do not create, change or delete data in the target.'])];
  return {
    version: 1, kind: suite.kind, title: suite.title ?? suite.name,
    ...(suite.target ? { target: suite.target } : {}),
    request: { goal: suite.goal, scenarios: scenarios.map(({ name, steps, expected }) => ({ name, steps, expected })) },
    ...(suite.credentials ? { credentials: suite.credentials } : {}),
    ...(limitations.length ? { limitations } : {}),
    ...(suite.allow_installs !== undefined ? { allow_installs: suite.allow_installs } : {}),
  };
}

/**
 * Fill a handoff's target from the project's defaults. A relative working
 * folder is resolved against the project; an API test's defaults to it.
 */
export function withDefaults(handoff, config, project) {
  const defaults = config[handoff.kind] ?? {};
  const target = { ...defaults, ...(handoff.target ?? {}) };
  if (handoff.kind === 'api') target.workdir ??= '.';
  if (handoff.kind !== 'web' && target.workdir && !isAbsolute(target.workdir)) target.workdir = resolve(project, target.workdir);
  return { ...handoff, target };
}
