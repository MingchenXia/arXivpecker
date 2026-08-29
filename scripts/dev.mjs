import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [
  spawn(npm, ['run', 'codex-bridge'], { stdio: 'inherit' }),
  spawn(npm, ['run', 'dev:web'], { stdio: 'inherit' }),
];
let stopping = false;

function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill(signal);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(signal));
for (const child of children) {
  child.on('error', (error) => { console.error(error.message); stop(); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    if (stopping) return;
    stop();
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
