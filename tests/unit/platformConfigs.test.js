import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (p) => readFileSync(join(root, p), 'utf8');

describe('platform configs', () => {
  test('.mcp.json (Claude Code) and the Cursor copy start chuskybrowser-mcp with the port and access key', () => {
    for (const p of ['.mcp.json', 'platforms/cursor/mcp.json']) {
      const cfg = JSON.parse(read(p));
      const server = cfg.mcpServers.chuskybrowser;
      expect(server.command).toBe('npx');
      expect(server.args).toEqual(['-y', 'chuskybrowser-mcp']);
      expect(server.env.CHUSKY_PORT).toBe('9377');
      expect(server.env.CHUSKY_ACCESS_KEY).toBe('${CHUSKY_ACCESS_KEY}');
    }
  });

  test('Codex, Hermes and Grok snippets name the same server and command', () => {
    for (const p of ['platforms/codex/config.toml', 'platforms/hermes/config.yaml', 'platforms/grok/config.toml']) {
      const text = read(p);
      expect(text).toContain('chuskybrowser');
      expect(text).toContain('chuskybrowser-mcp');
      expect(text).toContain('CHUSKY_PORT');
    }
  });
});
