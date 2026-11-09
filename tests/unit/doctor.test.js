import net from 'node:net';
import { checkNodeVersion, checkEngine, checkAccessKey, checkPort, runDoctor } from '../../lib/doctor.js';

describe('doctor checks', () => {
  test('Node 22 passes, older fails', () => {
    expect(checkNodeVersion('22.1.0').level).toBe('ok');
    expect(checkNodeVersion('20.10.0').level).toBe('fail');
  });

  test('engine: downloaded cache passes, missing cache fails with a fix', () => {
    const env = { HOME: '/tmp/x' };
    expect(checkEngine({ env, exists: () => true }).level).toBe('ok');
    expect(checkEngine({ env, exists: (p) => !p.endsWith('version.json') }).level).toBe('fail');
    const missing = checkEngine({ env, exists: () => false });
    expect(missing.level).toBe('fail');
    expect(missing.fix).toMatch(/chuskybrowser fetch-engine/);
  });

  test('engine: a bad CAMOUFOX_EXECUTABLE path fails and names the path', () => {
    const env = { CAMOUFOX_EXECUTABLE: '/nix/store/bad/camoufox-bin' };
    const r = checkEngine({ env, exists: () => false });
    expect(r.level).toBe('fail');
    expect(r.detail).toContain('/nix/store/bad/camoufox-bin');
  });

  test('access key missing is a warning, not a failure', () => {
    expect(checkAccessKey({ accessKey: '' }).level).toBe('warn');
    expect(checkAccessKey({ accessKey: 'k' }).level).toBe('ok');
  });

  test('port: a free port passes, a port in use fails', async () => {
    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    const busy = blocker.address().port;
    expect((await checkPort(busy)).level).toBe('fail');
    await new Promise((r) => blocker.close(r));
    expect((await checkPort(busy)).level).toBe('ok');
  });

  test('runDoctor returns 1 when something fails and 0 when all pass', async () => {
    const lines = [];
    const config = { port: 9377, accessKey: 'k' };
    const bad = [{ name: 'Engine', level: 'fail', detail: 'missing', fix: 'npm install' }];
    expect(await runDoctor({ config, checks: bad, write: (l) => lines.push(l) })).toBe(1);
    expect(lines.join('\n')).toContain('npm install');
    const good = [{ name: 'Engine', level: 'ok', detail: 'ok' }];
    expect(await runDoctor({ config, checks: good, write: () => {} })).toBe(0);
  });
});
