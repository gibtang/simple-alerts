import { randomBytes, scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';

const started = Date.now();
const color = process.stderr.isTTY;
const paint = (code, text) => color ? `\u001b[${code}m${text}\u001b[0m` : text;
const info = (message) => process.stderr.write(`${paint(34, message)}\n`);

function readPassword() {
  if (!process.stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        input += chunk;
        if (input.length > 1024) reject(new Error('Password input exceeds 1024 characters.'));
      });
      process.stdin.once('end', () => resolve(input.replace(/\r?\n$/, '')));
      process.stdin.once('error', reject);
    });
  }
  return new Promise((resolve, reject) => {
    const chars = [];
    process.stderr.write('Password (hidden; at least 12 characters): ');
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stderr.write('\n');
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\u0003') { finish(); reject(new Error('Cancelled.')); return; }
        if (char === '\r' || char === '\n') { finish(); resolve(chars.join('')); return; }
        if (char === '\u007f' || char === '\b') chars.pop();
        else if (char >= ' ' && chars.length < 1024) chars.push(char);
      }
    };
    process.stdin.on('data', onData);
  });
}

function complete(success) {
  const ended = Date.now();
  const message = success ? 'Password hash ready' : 'Password hashing failed';
  process.stderr.write(`${paint(success ? 32 : 31, message)}\n`);
  info(`End: ${new Date(ended).toISOString()} | Duration: ${((ended - started) / 1000).toFixed(2)}s | Progress: ${success ? '100%' : 'failed'}`);
  process.stderr.write('\u0007'.repeat(success ? 3 : 1));
  if (process.platform === 'darwin' && process.stderr.isTTY) {
    const voice = spawn('/usr/bin/say', [message], { stdio: 'ignore' });
    voice.on('error', () => {});
    voice.unref();
  }
}

info(`Start: ${new Date(started).toISOString()} | Progress: 0%`);
try {
  const password = await readPassword();
  if ([...password].length < 12 || password.length > 1024) {
    throw new Error('Use a password between 12 and 1024 characters.');
  }
  info('Progress: 50% | Deriving scrypt hash');
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  process.stdout.write(`scrypt:16384:8:1:${salt}:${hash}\n`);
  complete(true);
} catch (error) {
  process.stderr.write(`${paint(31, error instanceof Error ? error.message : 'Password hashing failed.')}\n`);
  complete(false);
  process.exitCode = 1;
}
