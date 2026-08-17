// start.mjs — single-command runner: backend (:4000) + frontend (:3000) concurrently.
// Lives in the workspace root. Requires Node 18+ (npx-free, zero deps).

import { spawn } from 'node:child_process';
import process from 'node:process';

const procs = [
  { name: 'backend',  cwd: 'server', cmd: 'npm', args: ['start'],                         color: 36 },
  { name: 'frontend', cwd: 'web',    cmd: 'npm', args: ['run', 'dev'],                    color: 35 },
];

const children = procs.map(({ name, cwd, cmd, args, color }) => {
  const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const tag = `\x1b[1;${color}m[${name}]\x1b[0m`;
  const pipe = (stream) => stream.on('data', (b) => {
    for (const line of b.toString().split(/\r?\n/)) {
      if (line) console.log(`${tag} ${line}`);
    }
  });
  pipe(child.stdout); pipe(child.stderr);
  child.on('exit', (code) => {
    console.log(`${tag} exited with code ${code}`);
    children.forEach((c) => { if (c !== child && !c.killed) c.kill('SIGTERM'); });
    process.exit(code ?? 0);
  });
  return child;
});

const shutdown = (sig) => {
  console.log(`\n[runner] got ${sig}, shutting down…`);
  children.forEach((c) => c.kill('SIGTERM'));
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log('\x1b[1m[aegis]\x1b[0m backend → http://localhost:4000   frontend → http://localhost:3000');
console.log('\x1b[2m[aegis]\x1b[0m Ctrl-C to stop both.\n');
