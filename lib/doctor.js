/**
 * `chuskybrowser doctor` -- checks a first-time setup and says how to fix each problem.
 *
 * Reads settings through lib/config.js (the only file that reads process.env) and
 * never starts the server. Exit code is 0 when nothing failed (warnings are allowed).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { loadConfig, camoufoxCacheDir, camoufoxExecutablePath } from './config.js';

export function checkNodeVersion(version = process.versions.node) {
  const major = parseInt(String(version).split('.')[0], 10);
  return {
    name: 'Node.js 22 or newer',
    level: major >= 22 ? 'ok' : 'fail',
    detail: `running ${version}`,
    fix: 'Install Node.js 22 or newer from https://nodejs.org',
  };
}

export function checkEngine({ env = process.env, exists = existsSync } = {}) {
  const external = camoufoxExecutablePath(env);
  if (external) {
    const found = exists(external);
    return {
      name: 'Browser engine',
      level: found ? 'ok' : 'fail',
      detail: found ? `external executable at ${external}` : `file not found: ${external}`,
      fix: 'Fix the path in CAMOUFOX_EXECUTABLE, or unset it to use the downloaded engine',
    };
  }
  // A complete download has version.json; an empty or partial cache folder does not.
  const dir = camoufoxCacheDir(env);
  const found = exists(join(dir, 'version.json'));
  return {
    name: 'Browser engine',
    level: found ? 'ok' : 'fail',
    detail: found ? `downloaded to ${dir}` : `not complete in ${dir}`,
    fix: 'Run npx chuskybrowser fetch-engine (about 300 MB, first time only)',
  };
}

export function checkAccessKey(config) {
  const set = Boolean(config.accessKey);
  return {
    name: 'Access key',
    level: set ? 'ok' : 'warn',
    detail: set ? 'CHUSKY_ACCESS_KEY is set' : 'CHUSKY_ACCESS_KEY is not set',
    fix: 'Fine for local use. Set CHUSKY_ACCESS_KEY in .env before exposing the server to anyone else',
  };
}

export function checkPort(port, { host = '127.0.0.1' } = {}) {
  return new Promise((resolve) => {
    const server = net.createServer();
    const name = `Port ${port}`;
    server.once('error', (err) => {
      resolve({
        name,
        level: 'fail',
        detail: err.code === 'EADDRINUSE' ? 'already in use (is chuskybrowser already running?)' : err.message,
        fix: 'Set CHUSKY_PORT to a free port in .env',
      });
    });
    server.once('listening', () => {
      server.close(() => resolve({ name, level: 'ok', detail: 'free' }));
    });
    server.listen(port, host);
  });
}

const LABEL = { ok: 'PASS', warn: 'WARN', fail: 'FAIL' };

export async function runDoctor({ config, write = console.log, checks } = {}) {
  let cfg = config;
  if (!cfg) {
    try {
      cfg = loadConfig();
    } catch (err) {
      write(`FAIL  Settings: could not load (${err.message})`);
      return 1;
    }
  }
  const results = checks || [
    checkNodeVersion(),
    checkEngine(),
    checkAccessKey(cfg),
    await checkPort(cfg.port),
  ];

  write('chuskybrowser doctor\n');
  for (const r of results) {
    write(`${LABEL[r.level]}  ${r.name}: ${r.detail}`);
    if (r.level !== 'ok') write(`      -> ${r.fix}`);
  }

  const failed = results.filter((r) => r.level === 'fail').length;
  const warned = results.filter((r) => r.level === 'warn').length;
  write('');
  if (failed === 0) {
    write(`Ready${warned ? ` (${warned} warning${warned > 1 ? 's' : ''})` : ''}. Start the server with: npx chuskybrowser`);
    write(`Then check it: curl http://localhost:${cfg.port}/health`);
    return 0;
  }
  write(`${failed} problem${failed > 1 ? 's' : ''} to fix before starting the server.`);
  return 1;
}
