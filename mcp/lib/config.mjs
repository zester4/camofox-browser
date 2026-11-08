import os from 'node:os';
import { join } from 'node:path';

/**
 * Load only the environment settings the standalone MCP adapter requires.
 * This module intentionally does not import the core server configuration so
 * chuskybrowser-mcp can run without the core package installed.
 */
export function loadMcpConfig() {
  return {
    port: parseInt(process.env.CHUSKY_PORT || process.env.PORT || '9377', 10),
    apiKey: process.env.CHUSKY_API_KEY || '',
    accessKey: (process.env.CHUSKY_ACCESS_KEY || '').trim(),
    cookiesDir: process.env.CHUSKY_COOKIES_DIR || join(os.homedir(), '.chusky', 'cookies'),
  };
}
