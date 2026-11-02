/**
 * The projects TOaD has been set up in, and each project's own defaults.
 *
 * The list lives in <config>/projects.json so one viewer (`toad ui`) can show
 * every project's runs. A project's defaults live in its .toad/toad.yaml and
 * fill in whatever a handoff leaves out.
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

export const CONFIG_TEMPLATE = `# TOaD settings for this project. Commit this file; it holds no secrets.
# Handoffs fill in anything they leave out from here.
#
# web:
#   url: http://localhost:3000       # where the app runs while you build it
# cli:
#   workdir: .                       # relative to the project, or absolute
#   program: node dist/cli.js        # how to invoke the program there
# timeout_minutes: 15
`;

const configSchema = z.object({
  web: z.object({ url: z.string().url() }).strict().optional(),
  cli: z.object({ workdir: z.string().min(1).optional(), program: z.string().min(1).optional() }).strict().optional(),
  timeout_minutes: z.number().int().min(1).max(60).optional(),
}).strict();

/** Read .toad/toad.yaml; an absent or all-comment file means no defaults. */
export function readProjectConfig(folder) {
  const path = join(folder, 'toad.yaml');
  if (!existsSync(path)) return {};
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let text;
  try {
    if (!fstatSync(fd).isFile()) throw new Error('.toad/toad.yaml must be a regular file');
    text = readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
  let data;
  try { data = parse(text) ?? {}; }
  catch (error) { throw new Error(`.toad/toad.yaml is not valid YAML: ${error.message.split('\n')[0]}`); }
  const result = configSchema.safeParse(data);
  if (!result.success) throw new Error(`.toad/toad.yaml: ${result.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  return result.data;
}

/**
 * Fill a handoff's target from the project's defaults. A relative CLI working
 * folder is resolved against the project.
 */
export function withDefaults(handoff, config, project) {
  const defaults = handoff.kind === 'web' ? config.web ?? {} : config.cli ?? {};
  const target = { ...defaults, ...(handoff.target ?? {}) };
  if (handoff.kind === 'cli' && target.workdir && !isAbsolute(target.workdir)) target.workdir = resolve(project, target.workdir);
  return { ...handoff, target };
}
