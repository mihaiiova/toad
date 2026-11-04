#!/usr/bin/env node
/** toad: the command-line entry point. See USAGE. */
import { forgetProject, listProjects } from './projects.mjs';

const USAGE = `Usage:
  toad setup [options]          prepare the agent, browser, models and keys, and coding agents
      --yes                       accept every default without asking
      --lead-model <provider/id>  the model that plans tests and writes reports
      --tester-model <provider/id>
                                  the model that runs each scenario
      --model <provider/id>       one model for both; models are named as
                                  \`pi --list-models\` prints them, and each key comes
                                  from its provider's variable, e.g. ANTHROPIC_API_KEY
      --no-register               do not register Toad with coding agents
      --skip-browser              do not download the browser
      --skip-image                do not download the CLI test image
      --force                     prepare the agent again from scratch
  toad doctor                   check that everything Toad needs is in place
  toad update [--from <dir>]    install the latest from GitHub (or a local checkout's) and prepare it
  toad run [options]            run the project's saved suites, e.g. in CI (toad run --help)
  toad mcp                      run the MCP server over stdio (coding agents start this)
  toad ui [--port <port>]       browse every project's runs on localhost
  toad projects                 list the projects Toad has been set up in
  toad projects forget <path>   remove one from the list (its files stay)`;

function portOf(args) {
  const i = args.indexOf('--port');
  const raw = i !== -1 ? args[i + 1] : args.find(a => a.startsWith('--port='))?.slice('--port='.length);
  if (raw === undefined) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${raw}`);
  return port;
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'mcp') await import('./server.mjs');
  else if (command === 'run') {
    const { RUN_USAGE, UsageError, parseRunArgs, toadRun } = await import('./toad-run.mjs');
    if (args.includes('--help') || args.includes('-h')) console.log(RUN_USAGE);
    else {
      let options;
      try { options = parseRunArgs(args); }
      catch (error) { if (!(error instanceof UsageError)) throw error; console.error(`toad run: ${error.message}\n\n${RUN_USAGE}`); process.exit(3); }
      // Ctrl-C or a CI cancellation stops the runs in progress, which then report as errors.
      const stop = new AbortController();
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { console.error('toad run: stopping…'); stop.abort(); });
      process.exitCode = await toadRun(options, { signal: stop.signal });
    }
  }
  else if (command === 'setup') {
    const known = ['--yes', '--no-register', '--skip-browser', '--skip-image', '--force'];
    const models = {};
    const rest = [];
    for (let i = 0; i < args.length; i++) {
      const [flag, inline] = args[i].split(/=(.*)/s);
      const key = { '--model': 'model', '--lead-model': 'leadModel', '--tester-model': 'testerModel' }[flag];
      if (!key) { rest.push(args[i]); continue; }
      models[key] = inline ?? args[++i];
      if (!models[key]) throw new Error(`${flag} needs provider/id`);
    }
    const unknown = rest.filter(a => !known.includes(a));
    if (unknown.length) throw new Error(`Unknown option: ${unknown[0]}`);
    const { setup } = await import('./setup.mjs');
    await setup({ yes: rest.includes('--yes'), noRegister: rest.includes('--no-register'), skipBrowser: rest.includes('--skip-browser'), skipImage: rest.includes('--skip-image'), force: rest.includes('--force'), ...models });
  } else if (command === 'doctor') { const { doctor } = await import('./setup.mjs'); await doctor(); }
  else if (command === 'update') {
    const i = args.indexOf('--from');
    if (i !== -1 && !args[i + 1]) throw new Error('--from needs a folder');
    const { resolve } = await import('node:path');
    const { update } = await import('./setup.mjs');
    await update({ from: i !== -1 ? resolve(args[i + 1]) : undefined });
  }
  else if (command === '--version' || command === '-v') { const { VERSION } = await import('./agent.mjs'); console.log(VERSION); }
  else if (command === 'ui') {
    const { startUi } = await import('./ui.mjs');
    const { url } = await startUi({ port: portOf(args) });
    const count = listProjects().filter(p => p.present).length;
    console.log(`Toad runs: ${url}  (${count} project${count === 1 ? '' : 's'})`);
  } else if (command === 'projects' && args[0] === 'forget' && args[1]) {
    console.log(forgetProject(args[1]) ? `Forgot ${args[1]}` : `Not in the list: ${args[1]}`);
  } else if (command === 'projects' && !args.length) {
    const projects = listProjects();
    if (!projects.length) console.log('No projects yet.');
    for (const p of projects) console.log(`${p.path}${p.present ? '' : '  (missing .toad/runs)'}`);
  } else if (command === '-h' || command === '--help' || command === 'help') console.log(USAGE);
  else { console.error(USAGE); process.exitCode = 1; }
} catch (error) {
  console.error(`toad: ${error.message}`);
  // toad run's codes are for CI: 3 means it could not start.
  process.exitCode = command === 'run' ? 3 : 1;
}
