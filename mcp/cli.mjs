#!/usr/bin/env node
/**
 * toad: the command-line entry point.
 *
 *   toad mcp                      run the MCP server over stdio
 *   toad ui [--port <port>]       browse every project's runs on localhost
 *   toad projects                 list the projects TOaD has been set up in
 *   toad projects forget <path>   remove one from the list (its files stay)
 */
import { forgetProject, listProjects } from './projects.mjs';

const USAGE = `Usage:
  toad mcp                      run the MCP server over stdio
  toad ui [--port <port>]       browse every project's runs on localhost
  toad projects                 list the projects TOaD has been set up in
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
  else if (command === 'ui') {
    const { startUi } = await import('./ui.mjs');
    const { url } = await startUi({ port: portOf(args) });
    const count = listProjects().filter(p => p.present).length;
    console.log(`TOaD runs: ${url}  (${count} project${count === 1 ? '' : 's'})`);
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
  process.exitCode = 1;
}
