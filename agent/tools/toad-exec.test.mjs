import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, readdirSync, utimesSync, realpathSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
// Project paths must be canonical; on macOS the temp folder is behind a symlink.
const tmpdir = () => realpathSync(osTmpdir());
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { bwrapVersion, containerRuntime, MIN_BWRAP } from './toad-sandbox.mjs';

const recorder = resolve(import.meta.dirname, 'toad-exec.mjs');
// Every test runs against each sandbox this machine has. The container tests
// use a small image that is commonly present, to avoid a large download.
const IMAGE = process.env.TOAD_TEST_IMAGE || 'node:22-slim';
const bwrap = bwrapVersion();
const BACKENDS = [
  ...(bwrap && (bwrap[0] - MIN_BWRAP[0] || bwrap[1] - MIN_BWRAP[1] || bwrap[2] - MIN_BWRAP[2]) >= 0 ? ['bwrap'] : []),
  ...(containerRuntime() ? ['container'] : []),
];
let backend;
function setup(t, secrets = '') {
  const root = mkdtempSync(join(tmpdir(), 'toad-exec-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.forge'));
  writeFileSync(join(root, '.forge/test-secrets.env'), secrets);
  const target = join(root, 'target'); mkdirSync(target);
  writeFileSync(join(target, 'hello.txt'), 'hello from project\n');
  // Scenario workspaces live in the per-user cache; keep each test's apart.
  const cache = join(root, 'cache');
  const env = { TOAD_CACHE_DIR: cache, TOAD_RUNTIME_DIR: join(root, 'runtime'), TOAD_CLI_SANDBOX: backend, TOAD_CLI_IMAGE: IMAGE };
  const run = (args, opts = {}) => spawnSync(process.execPath, [recorder, ...args], { cwd: root, encoding: 'utf8', timeout: 120000, ...opts, env: { ...(opts.env ?? process.env), ...env } });
  const prepare = () => {
    const result = run(['prepare', target]);
    assert.equal(result.status, 0, result.stderr);
    return /Scenario ID: (.+)/.exec(result.stdout)[1];
  };
  return { root, target, run, prepare, cache, env };
}

if (!BACKENDS.length) test('CLI sandbox tests', { skip: 'no container runtime or Bubblewrap on this machine' }, () => {});
for (const name of BACKENDS) describe(`with ${name}`, () => {
  beforeEach(() => { backend = name; });
  test('PASS and FAIL commands share persistent isolated workspace and receipts', t => {
    const { root, target, run, prepare } = setup(t);
    const id = prepare();
    const pass = run(['run', 'data/receipts/r1', 'scenario-01', id, 'cat hello.txt; echo changed > saved']);
    assert.equal(pass.status, 0, pass.stderr); assert.match(pass.stdout, /exit 0/); assert.match(pass.stdout, /hello from project/);
    const failure = run(['run', 'data/receipts/r1', 'scenario-02', id, 'cat saved; exit 3']);
    assert.equal(failure.status, 0); assert.match(failure.stdout, /exit 3/); assert.match(failure.stdout, /changed/);
    assert.equal(existsSync(join(target, 'saved')), false);
    assert.equal(readFileSync(join(root, 'cache/scenarios', id, 'project/saved'), 'utf8'), 'changed\n');
    assert.match(readFileSync(join(root, 'data/receipts/r1/scenario-02.txt'), 'utf8'), /result: exit 3/);
  });

  test('scenarios start from the setup workspace of the same source, links included', t => {
    const { root, target, run, prepare } = setup(t);
    const base = prepare();
    const install = run(['run', 'data/receipts/setup', '01-setup', base, 'mkdir -p node_modules/.bin tools && printf "#!/bin/sh\\necho tool ok\\n" > tools/tool && chmod +x tools/tool && ln -s ../../tools/tool node_modules/.bin/tool && echo cached > "$HOME/cache"']);
    assert.match(install.stdout, /exit 0/, install.stdout + install.stderr);
    const withBase = { env: { ...process.env, TOAD_BASE_SCENARIO: base } };
    const prepared = run(['prepare', target], withBase);
    assert.equal(prepared.status, 0, prepared.stderr);
    const id = /Scenario ID: (.+)/.exec(prepared.stdout)[1];
    assert.notEqual(id, base);
    const used = run(['run', 'data/receipts/s1', '01-tool', id, 'PATH="$PWD/node_modules/.bin:$PATH" tool && cat "$HOME/cache"']);
    assert.match(used.stdout, /exit 0/, used.stdout); assert.match(used.stdout, /tool ok/); assert.match(used.stdout, /cached/);
    // Changes in one scenario never reach the setup workspace or the project.
    run(['run', 'data/receipts/s1', '02-change', id, 'rm tools/tool']);
    assert.equal(existsSync(join(root, 'cache/scenarios', base, 'project/tools/tool')), true);
    assert.equal(existsSync(join(target, 'tools')), false);
    // Another source ignores it and is copied as usual.
    const other = join(root, 'other'); mkdirSync(other); writeFileSync(join(other, 'x.txt'), 'x');
    const plain = run(['prepare', other], withBase);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(existsSync(join(root, 'cache/scenarios', /Scenario ID: (.+)/.exec(plain.stdout)[1], 'project/tools')), false);
  });

  test('copy excludes secrets, receipts and symlinks without following them', t => {
    const { root, target, prepare } = setup(t);
    writeFileSync(join(target, '.env'), 'PASSWORD=private\n');
    writeFileSync(join(target, '.env.local'), 'secret');
    writeFileSync(join(target, '.env.example'), '# name only');
    mkdirSync(join(target, '.toad')); writeFileSync(join(target, '.toad', 'credentials'), 'private');
    mkdirSync(join(target, '.ssh')); writeFileSync(join(target, '.ssh', 'id_rsa'), 'private');
    writeFileSync(join(target, 'server.key'), 'private');
    mkdirSync(join(target, 'receipts')); writeFileSync(join(target, 'receipts', 'secret'), 'private');
    symlinkSync(join(root, '.forge'), join(target, 'external'));
    const project = join(root, 'cache/scenarios', prepare(), 'project');
    for (const name of ['.env', '.env.local', '.toad', '.ssh', 'server.key', 'receipts', 'external']) assert.equal(existsSync(join(project, name)), false, name);
    assert.equal(existsSync(join(project, '.env.example')), true);
  });

  test('project CLI credentials are selected, redacted even when short, and never fall back to shared secrets', t => {
    const { root, run, prepare } = setup(t, 'SHARED=shared-private\n');
    const id = prepare();
    const file = join(root, 'selected.json');
    writeFileSync(file, JSON.stringify({ TOKEN: 'xy', SELECTED: 'selected-private' }), { mode: 0o600 });
    const env = { ...process.env, TOAD_CLI_SECRETS_FILE: file };
    const result = run(['run', 'data/receipts/r2', 'project', id, 'printf "%s %s %s" "$TOKEN" "$SELECTED" "${SHARED-unset}"'], { env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[secret:TOKEN\]/);
    assert.match(result.stdout, /\[secret:SELECTED\]/);
    assert.match(result.stdout, /unset/);
    const receipt = readFileSync(join(root, 'data/receipts/r2/project.txt'), 'utf8');
    for (const text of [result.stdout, receipt]) for (const value of ['xy', 'selected-private', 'shared-private']) assert.ok(!text.includes(value), value);
    writeFileSync(file, '{}');
    const empty = run(['run', 'data/receipts/r2', 'empty', id, 'printf "%s" "${SHARED-unset}"'], { env });
    assert.match(empty.stdout, /unset/);
  });

  test('project credential files fail closed on missing, malformed, symlinked or reserved values', t => {
    const { root, run, prepare } = setup(t, 'SHARED=shared-private\n');
    const id = prepare();
    const file = join(root, 'selected.json');
    const env = { ...process.env, TOAD_CLI_SECRETS_FILE: file };
    const exec = () => run(['run', 'data/receipts/r2', 'invalid', id, 'echo should-not-run'], { env });
    assert.equal(exec().status, 2);
    writeFileSync(file, 'not-json'); assert.equal(exec().status, 2);
    writeFileSync(file, '{"NODE_OPTIONS":"bad"}'); assert.match(exec().stderr, /reserved/);
    rmSync(file); symlinkSync(join(root, '.forge/test-secrets.env'), file); assert.equal(exec().status, 2);
    assert.equal(existsSync(join(root, 'data/receipts/r2/invalid.txt')), false);
  });

  test('secrets are redacted and command input and timeout are supported', t => {
    const { root, run, prepare } = setup(t, 'API_TOKEN=s3cret-value-123\n'); const id = prepare();
    const secret = run(['run', 'data/receipts/r2', 'secret', id, 'echo $API_TOKEN']);
    assert.match(secret.stdout, /\[secret:API_TOKEN\]/); assert.doesNotMatch(secret.stdout, /s3cret-value-123/);
    assert.doesNotMatch(readFileSync(join(root, 'data/receipts/r2/secret.txt'), 'utf8'), /s3cret-value-123/);
    writeFileSync(join(root, 'input.txt'), 'yes\n');
    assert.match(run(['run', 'data/receipts/r2', 'input', id, 'read a; echo $a', join(root, 'input.txt')]).stdout, /yes/);
    assert.match(run(['run', 'data/receipts/r2', 'timeout', id, 'sleep 30'], { env: { ...process.env, TOAD_COMMAND_TIMEOUT_S: '1' } }).stdout, /timed out after 1s/);
  });

  test('scenarios use different workspaces', t => {
    const { root, run, prepare } = setup(t); const a = prepare(), b = prepare(); assert.notEqual(a, b);
    run(['run', 'data/receipts/r3', 'write', a, 'echo first > one']);
    const read = run(['run', 'data/receipts/r3', 'read', b, 'test ! -e one']);
    assert.match(read.stdout, /exit 0/); assert.ok(readdirSync(join(root, 'cache/scenarios')).includes(a));
  });

  test('concurrent preparation creates distinct isolated workspaces', async t => {
    const { root, target, env } = setup(t);
    const prepare = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [recorder, 'prepare', target], { cwd: root, env: { ...process.env, ...env } });
      let out = '', err = '';
      child.stdout.on('data', data => { out += data; });
      child.stderr.on('data', data => { err += data; });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(/Scenario ID: (.+)/.exec(out)[1]) : reject(new Error(err)));
    });
    const ids = await Promise.all([prepare(), prepare(), prepare()]);
    assert.equal(new Set(ids).size, 3);
    for (const id of ids) assert.equal(readFileSync(join(root, 'cache/scenarios', id, 'project/hello.txt'), 'utf8'), 'hello from project\n');
  });

  test('ERROR invalid ID and preflight failure never execute a host command', t => {
    const { root, target, run } = setup(t);
    const marker = join(root, 'host-marker');
    const bad = run(['run', 'data/receipts/r4', 'bad', '../escape', `touch ${marker}`]);
    assert.equal(bad.status, 2); assert.match(bad.stderr, /infrastructure error/); assert.equal(existsSync(marker), false);
    const bin = join(root, 'fakebin'); mkdirSync(bin); writeFileSync(join(bin, backend === 'bwrap' ? 'bwrap' : 'docker'), '#!/bin/sh\necho unavailable >&2\nexit 1\n', { mode: 0o755 });
    const failed = run(['prepare', target], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TOAD_CONTAINER_RUNTIME: 'docker' } });
    assert.equal(failed.status, 2); assert.match(failed.stderr, /infrastructure error/); assert.equal(existsSync(marker), false);
  });

  test('scenario workspaces live in the cache, never in the agent folder', t => {
    const { root, prepare } = setup(t);
    const id = prepare();
    assert.ok(existsSync(join(root, 'cache/scenarios', id, 'project/hello.txt')));
    assert.equal(existsSync(join(root, '.forge/scenarios')), false);
  });

  test('receipts go to the folder the wrapper names, and nowhere else', t => {
    const { root, run, prepare } = setup(t);
    const id = prepare();
    const project = join(root, 'project-run', 'receipts');
    mkdirSync(project, { recursive: true });
    const env = { ...process.env, TOAD_RECEIPTS_DIR: project };
    const inside = run(['run', join(project, 'scenario'), 'ok', id, 'echo hi'], { env });
    assert.equal(inside.status, 0, inside.stderr);
    assert.match(inside.stdout, new RegExp(`receipt: ${join(project, 'scenario', 'ok.txt')}`));
    assert.match(readFileSync(join(project, 'scenario', 'ok.txt'), 'utf8'), /result: exit 0/);
    const legacy = run(['run', 'data/receipts/r5', 'legacy', id, 'echo hi'], { env });
    assert.equal(legacy.status, 2); assert.match(legacy.stderr, /must be inside/);
    assert.equal(existsSync(join(root, 'data/receipts/r5')), false);
  });

  test('preparing prunes workspaces left unused past the cache lifetime', t => {
    const { root, run, prepare } = setup(t);
    const old = prepare(), recent = prepare();
    const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(join(root, 'cache/scenarios', old), past, past);
    utimesSync(join(root, 'cache/scenarios', recent), past, past);
    run(['run', 'data/receipts/r6', 'touch', recent, 'true']); // using a workspace keeps it
    prepare();
    assert.equal(existsSync(join(root, 'cache/scenarios', old)), false);
    assert.equal(existsSync(join(root, 'cache/scenarios', recent)), true);
  });

  test('the receipt names the sandbox, and container secrets never outlive the command', t => {
    const { root, run, prepare } = setup(t);
    const id = prepare();
    const file = join(root, 'selected.json');
    writeFileSync(file, JSON.stringify({ TOKEN: 'container-secret' }), { mode: 0o600 });
    const result = run(['run', 'data/receipts/r7', 'which', id, 'test -n "$TOKEN" && ! touch /usr/x 2>/dev/null && echo ok'], { env: { ...process.env, TOAD_CLI_SECRETS_FILE: file } });
    assert.match(result.stdout, /exit 0/, result.stdout + result.stderr);
    const receipt = readFileSync(join(root, 'data/receipts/r7/which.txt'), 'utf8');
    assert.match(receipt, backend === 'container' ? new RegExp(`sandbox: (docker|podman) ${IMAGE}`) : /sandbox: bubblewrap/);
    assert.equal(existsSync(join(root, 'runtime', 'secrets')) ? readdirSync(join(root, 'runtime', 'secrets')).length : 0, 0);
  });
});
