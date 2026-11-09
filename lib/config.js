/**
 * Centralized environment configuration for chuskybrowser.
 *
 * All process.env access is centralized here for auditability.
 * flag plugin.ts or server.js for env-harvesting (env + network in same file).
 */

import { join, dirname } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import os from 'os';
import { existsSync } from 'fs';

// Load the project's .env (if present) before anything reads process.env. Values already set in the
// shell win, so the platform's environment (e.g. Railway) is never overridden by a file.
const DOTENV_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(DOTENV_PATH) && typeof process.loadEnvFile === 'function') process.loadEnvFile(DOTENV_PATH);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..');

const CONFIG_PATH = join(ROOT_DIR, 'chusky.config.json');

function readChuskyConfig(configPath = CONFIG_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** @deprecated crashReporter config moved to Cloudflare Worker relay. */
function readCrashReporterConfig() {
  return {};
}

/**
 * Parse PROXY_PORTS env var into an array of port numbers.
 * Supports range ("10001-10010") or comma-separated ("10001,10002,10003").
 * Falls back to single PROXY_PORT if PROXY_PORTS is not set.
 */
function parseProxyPorts(portsEnv, singlePort) {
  if (portsEnv) {
    if (portsEnv.includes('-')) {
      const [start, end] = portsEnv.split('-').map(s => parseInt(s.trim(), 10));
      if (!isNaN(start) && !isNaN(end) && end >= start) {
        return Array.from({ length: end - start + 1 }, (_, i) => start + i);
      }
    }
    const parsed = portsEnv.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    if (parsed.length > 0) return parsed;
  }
  if (singlePort) {
    const p = parseInt(singlePort, 10);
    if (!isNaN(p)) return [p];
  }
  return [];
}

function inferProxyStrategy(explicitStrategy) {
  if (explicitStrategy) return explicitStrategy;
  return 'round_robin';
}

function camoufoxCacheDir(env = process.env) {
  const home = os.homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Caches', 'camoufox');
  if (process.platform === 'win32') {
    const base = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return join(base, 'camoufox', 'camoufox', 'Cache');
  }
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'camoufox');
}

function camoufoxExecutablePath(env = process.env) {
  return (
    env.CAMOUFOX_EXECUTABLE ||
    env.CAMOUFOX_EXECUTABLE_PATH ||
    env.CHUSKY_EXECUTABLE_PATH ||
    ''
  ).trim();
}

function normalizeInteractiveMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return ['off', 'desktop', 'novnc', 'auto'].includes(mode) ? mode : 'off';
}

function normalizeProxyProtocol(value) {
  const protocol = String(value || 'http').trim().toLowerCase().replace(/:$/, '');
  if (!['http', 'https', 'socks4', 'socks5'].includes(protocol)) {
    throw new Error('PROXY_PROTOCOL must be http, https, socks4, or socks5');
  }
  return protocol;
}

function directBrowserIdentity(env = process.env) {
  const locale = String(env.CHUSKY_LOCALE || '').trim();
  const timezoneId = String(env.CHUSKY_TIMEZONE || '').trim();
  if (!locale && !timezoneId) return null;
  if (!locale || !timezoneId) {
    throw new Error('CHUSKY_LOCALE and CHUSKY_TIMEZONE must be set together for direct browser identity');
  }
  try {
    Intl.getCanonicalLocales(locale);
  } catch {
    throw new Error('CHUSKY_LOCALE must be a valid BCP 47 locale');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezoneId });
  } catch {
    throw new Error('CHUSKY_TIMEZONE must be a valid IANA timezone');
  }
  return { locale, timezoneId };
}

function loadConfig({ configPath = CONFIG_PATH } = {}) {
  const externalCamoufoxExecutable = camoufoxExecutablePath();
  const configuredSessionTimeoutMs = parseInt(process.env.SESSION_TIMEOUT_MS, 10);
  // 0 disables session expiry (sessions never expire); unset falls back to the default.
  const sessionTimeoutMs = Number.isNaN(configuredSessionTimeoutMs) ? 600000 : configuredSessionTimeoutMs;
  const configuredBrowserIdleTimeoutMs = parseInt(process.env.BROWSER_IDLE_TIMEOUT_MS, 10);
  // 0 disables idle browser shutdown; unset falls back to the default.
  const browserIdleTimeoutMs = Number.isNaN(configuredBrowserIdleTimeoutMs) ? 300000 : configuredBrowserIdleTimeoutMs;
  const fileConfig = readChuskyConfig(configPath);
  const configuredNewPageTimeoutMs = Number(fileConfig.newPageTimeoutMs);
  const newPageTimeoutMs = Number.isFinite(configuredNewPageTimeoutMs) && configuredNewPageTimeoutMs > 0
    ? configuredNewPageTimeoutMs
    : 10000;
  const configuredInteractiveMode = fileConfig.interactive?.mode;
  const interactiveMode = normalizeInteractiveMode(process.env.CHUSKY_INTERACTIVE || configuredInteractiveMode);
  const directIdentity = directBrowserIdentity();
  return {
    port: parseInt(process.env.CHUSKY_PORT || process.env.PORT || '9377', 10),
    bindHost: (process.env.CHUSKY_BIND_HOST || '').trim(),
    nodeEnv: process.env.NODE_ENV || 'development',
    flyMachineId: process.env.FLY_MACHINE_ID || '',
    flyAppName: process.env.FLY_APP_NAME || '',
    flyApiToken: process.env.FLY_API_TOKEN || '',
    adminKey: process.env.CHUSKY_ADMIN_KEY || '',
    apiKey: process.env.CHUSKY_API_KEY || '',
    accessKey: (process.env.CHUSKY_ACCESS_KEY || '').trim(),
    evaluateMaxBodySize: process.env.CHUSKY_EVALUATE_MAX_BODY_SIZE || '1mb',
    cookiesDir: process.env.CHUSKY_COOKIES_DIR || join(os.homedir(), '.chusky', 'cookies'),
    uploadsDir: process.env.CHUSKY_UPLOADS_DIR || join(os.homedir(), '.chusky', 'uploads'),
    profileDir: process.env.CHUSKY_PROFILE_DIR || join(os.homedir(), '.chusky', 'profiles'),
    // 32 random bytes, base64. Required to save or load sessions (see lib/storage-crypto.js).
    storageKey: (process.env.CHUSKY_STORAGE_KEY || '').trim(),
    tracesDir: process.env.CHUSKY_TRACES_DIR || join(os.homedir(), '.chusky', 'traces'),
    tracesMaxBytes: parseInt(process.env.CHUSKY_TRACES_MAX_BYTES || String(50 * 1024 * 1024), 10),
    tracesTtlHours: parseInt(process.env.CHUSKY_TRACES_TTL_HOURS || '24', 10),
    handlerTimeoutMs: parseInt(process.env.HANDLER_TIMEOUT_MS) || 30000,
    newPageTimeoutMs,
    maxConcurrentPerUser: parseInt(process.env.MAX_CONCURRENT_PER_USER) || 3,
    sessionTimeoutMs,
    tabInactivityMs: parseInt(process.env.TAB_INACTIVITY_MS) || 300000,
    maxSessions: parseInt(process.env.MAX_SESSIONS) || 50,
    maxTabsPerSession: parseInt(process.env.MAX_TABS_PER_SESSION) || 10,
    maxTabsGlobal: parseInt(process.env.MAX_TABS_GLOBAL) || 50,
    navigateTimeoutMs: parseInt(process.env.NAVIGATE_TIMEOUT_MS) || 30000,
    buildrefsTimeoutMs: parseInt(process.env.BUILDREFS_TIMEOUT_MS) || 12000,
    browserIdleTimeoutMs,
    nativeMemRestartThresholdMb: parseInt(process.env.NATIVE_MEM_RESTART_THRESHOLD_MB) || 300,
    browserRssRestartThresholdMb: parseInt(process.env.BROWSER_RSS_RESTART_THRESHOLD_MB) || 1500,
    camoufoxExecutablePath: externalCamoufoxExecutable,
    camoufoxCacheDir: camoufoxCacheDir(),
    prometheusEnabled: process.env.PROMETHEUS_ENABLED === '1' || process.env.PROMETHEUS_ENABLED === 'true',
    disableDefaultAddons: process.env.CHUSKY_DISABLE_DEFAULT_ADDONS === '1' || process.env.CHUSKY_DISABLE_DEFAULT_ADDONS === 'true',
    interactiveMode,
    directIdentity,
    proxy: {
      strategy: inferProxyStrategy(process.env.PROXY_STRATEGY || ''),
      protocol: normalizeProxyProtocol(process.env.PROXY_PROTOCOL),
      providerName: process.env.PROXY_PROVIDER || 'decodo',
      host: process.env.PROXY_HOST || '',
      port: process.env.PROXY_PORT || '',
      ports: parseProxyPorts(process.env.PROXY_PORTS, process.env.PROXY_PORT),
      username: process.env.PROXY_USERNAME || '',
      password: process.env.PROXY_PASSWORD || '',
      backconnectHost: process.env.PROXY_BACKCONNECT_HOST || '',
      backconnectPort: parseInt(process.env.PROXY_BACKCONNECT_PORT || '7000', 10),
      country: process.env.PROXY_COUNTRY || '',
      state: process.env.PROXY_STATE || '',
      city: process.env.PROXY_CITY || '',
      zip: process.env.PROXY_ZIP || '',
      sessionDurationMinutes: parseInt(process.env.PROXY_SESSION_DURATION_MINUTES || '10', 10),
    },
    // AgentCard (Vault and card payments). Secrets and service URLs only.
    // The state file sits beside the browser profiles, on the same volume.
    agentcard: {
      clientId: (process.env.AGENTCARD_CLIENT_ID || '').trim(),
      clientSecret: (process.env.AGENTCARD_CLIENT_SECRET || '').trim(),
      webhookSecret: (process.env.AGENTCARD_WEBHOOK_SECRET || '').trim(),
      baseUrl: (process.env.AGENTCARD_BASE_URL || '').trim(),
      stateFile: join(dirname(process.env.CHUSKY_PROFILE_DIR || join(os.homedir(), '.chusky', 'profiles')), 'agentcard', 'state.json'),
    },
    pluginEnv: {
      ENABLE_VNC: process.env.ENABLE_VNC,
    },
    // Env vars forwarded to the server subprocess
    serverEnv: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: process.env.NODE_ENV,
      CHUSKY_BIND_HOST: process.env.CHUSKY_BIND_HOST,
      CHUSKY_ADMIN_KEY: process.env.CHUSKY_ADMIN_KEY,
      CHUSKY_API_KEY: process.env.CHUSKY_API_KEY,
      CHUSKY_ACCESS_KEY: process.env.CHUSKY_ACCESS_KEY,
      CHUSKY_EVALUATE_MAX_BODY_SIZE: process.env.CHUSKY_EVALUATE_MAX_BODY_SIZE,
      CHUSKY_COOKIES_DIR: process.env.CHUSKY_COOKIES_DIR,
      CHUSKY_UPLOADS_DIR: process.env.CHUSKY_UPLOADS_DIR,
      CHUSKY_TRACES_DIR: process.env.CHUSKY_TRACES_DIR,
      CHUSKY_TRACES_MAX_BYTES: process.env.CHUSKY_TRACES_MAX_BYTES,
      CHUSKY_TRACES_TTL_HOURS: process.env.CHUSKY_TRACES_TTL_HOURS,
      CHUSKY_DISABLE_DEFAULT_ADDONS: process.env.CHUSKY_DISABLE_DEFAULT_ADDONS,
      CHUSKY_INTERACTIVE: process.env.CHUSKY_INTERACTIVE,
      CHUSKY_LOCALE: process.env.CHUSKY_LOCALE,
      CHUSKY_TIMEZONE: process.env.CHUSKY_TIMEZONE,
      NAVIGATE_TIMEOUT_MS: process.env.NAVIGATE_TIMEOUT_MS,
      CAMOUFOX_EXECUTABLE: process.env.CAMOUFOX_EXECUTABLE,
      CAMOUFOX_EXECUTABLE_PATH: process.env.CAMOUFOX_EXECUTABLE_PATH,
      CHUSKY_EXECUTABLE_PATH: process.env.CHUSKY_EXECUTABLE_PATH,
      PROXY_STRATEGY: process.env.PROXY_STRATEGY,
      PROXY_PROTOCOL: process.env.PROXY_PROTOCOL,
      PROXY_PROVIDER: process.env.PROXY_PROVIDER,
      PROXY_HOST: process.env.PROXY_HOST,
      PROXY_PORT: process.env.PROXY_PORT,
      PROXY_PORTS: process.env.PROXY_PORTS,
      PROXY_USERNAME: process.env.PROXY_USERNAME,
      PROXY_PASSWORD: process.env.PROXY_PASSWORD,
      PROXY_BACKCONNECT_HOST: process.env.PROXY_BACKCONNECT_HOST,
      PROXY_BACKCONNECT_PORT: process.env.PROXY_BACKCONNECT_PORT,
      PROXY_COUNTRY: process.env.PROXY_COUNTRY,
      PROXY_STATE: process.env.PROXY_STATE,
      PROXY_CITY: process.env.PROXY_CITY,
      PROXY_ZIP: process.env.PROXY_ZIP,
      PROXY_SESSION_DURATION_MINUTES: process.env.PROXY_SESSION_DURATION_MINUTES,
      ENABLE_VNC: process.env.ENABLE_VNC,
      VNC_RESOLUTION: process.env.VNC_RESOLUTION,
      VNC_PASSWORD: process.env.VNC_PASSWORD,
      VIEW_ONLY: process.env.VIEW_ONLY,
      VNC_PORT: process.env.VNC_PORT,
      NOVNC_PORT: process.env.NOVNC_PORT,
      VNC_BIND: process.env.VNC_BIND,
      VNC_RFB_BIND: process.env.VNC_RFB_BIND,
    },
    // Crash reporter (opt-in, reports sent to Cloudflare Worker relay)
    crashReportEnabled:   process.env.CHUSKY_CRASH_REPORT_ENABLED !== 'false',
    crashReportUrl:       process.env.CHUSKY_CRASH_REPORT_URL || '',
    crashReportRepo:      process.env.CHUSKY_CRASH_REPORT_REPO,
    crashReportRateLimit: parseInt(process.env.CHUSKY_CRASH_REPORT_RATE_LIMIT, 10) || 10,
    crashReporterConfig:  readCrashReporterConfig(),
    sentryDsn: process.env.SENTRY_DSN || '',
  };
}

function windowsProcessEnvironment() {
  const env = {};
  for (const key of ['COMSPEC', 'ComSpec', 'SystemRoot', 'SystemDrive', 'WINDIR', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'PSModulePath']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export { loadConfig, readChuskyConfig, directBrowserIdentity, windowsProcessEnvironment, camoufoxCacheDir, camoufoxExecutablePath };
