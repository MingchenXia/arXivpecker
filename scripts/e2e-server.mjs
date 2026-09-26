// Starts the bridge on a throwaway copy of the starter library plus the built
// reader, for the Playwright tests in e2e/. Playwright stops this process when
// the run ends; the temporary library is removed then.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// A fixed path, cleared at start: Playwright may kill this process before it can clean up.
const library = path.join(os.tmpdir(), 'arxivpecker-e2e-library');
await rm(library, { recursive: true, force: true });
await mkdir(library, { recursive: true });

if (!existsSync(path.join(root, 'dist'))) {
  const build = spawnSync(npm, ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

// e2e/fixtures/bin provides a scripted stand-in for the Codex CLI, so AI flows
// run without a Codex sign-in and produce deterministic results.
const env = {
  ...process.env,
  PROOFROOM_LIBRARY_DIR: library,
  PATH: `${path.join(root, 'e2e', 'fixtures', 'bin')}${path.delimiter}${process.env.PATH}`,
};
const children = [spawn(process.execPath, ['scripts/codex-bridge.mjs'], { cwd: root, env, stdio: 'inherit' })];
// Start the reader only once the bridge answers, so the first page load finds it.
for (let attempt = 0; ; attempt += 1) {
  try {
    if ((await fetch('http://127.0.0.1:4318/vault')).ok) break;
  } catch {
    if (attempt > 100) throw new Error('The bridge did not start.');
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
// Run the vinext CLI directly: through npm, SIGTERM would stop npm but leave the server holding the port.
children.push(
  spawn(process.execPath, [path.join(root, 'node_modules', 'vinext', 'dist', 'cli.js'), 'start'], {
    cwd: root,
    env,
    stdio: 'inherit',
  }),
);

let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  await rm(library, { recursive: true, force: true });
  process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop());
for (const child of children) child.on('exit', (code) => void stop(code ?? 1));
