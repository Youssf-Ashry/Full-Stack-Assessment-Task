import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nextBin = require.resolve('next/dist/bin/next');
const command = process.argv[2];

if (command !== 'dev' && command !== 'start') {
  throw new Error('Expected a Next command: dev or start');
}

const child = spawn(process.execPath, [nextBin, command, '--port', process.env.WEB_PORT || '3742'], {
  stdio: 'inherit',
});

child.on('exit', (code) => process.exit(code ?? 1));
