import { DefaultAddons, maybeDownloadAddons } from 'camoufox-js/dist/addons.js';
import { ALLOW_GEOIP, downloadMMDB } from 'camoufox-js/dist/locale.js';
import { CamoufoxFetcher } from 'camoufox-js/dist/pkgman.js';
import { pathToFileURL } from 'node:url';

// Keep the latest stable browser release tested with camoufox-js@0.11.5.
// beta.34 rejects navigator.product; beta.28 fails viewport E2E on Playwright 1.58.
export const BUNDLED_CAMOUFOX_RELEASE = '152.0.4-beta.30';

export class CompatibleCamoufoxFetcher extends CamoufoxFetcher {
  checkAsset(asset) {
    if (!asset.name.startsWith(`camoufox-${BUNDLED_CAMOUFOX_RELEASE}-`)) return null;
    return super.checkAsset(asset);
  }
}

// camoufox-js does not currently expose its fetch command from the public
// entrypoint. Keep its pinned version in package.json while using the same
// downloader implementation as `npx camoufox-js fetch`, without spawning a
// shell or a second Node process during this package's lifecycle hook.
// The progress label is written by camoufox-js, which we don't control. While the
// engine downloads, rename the engine in its output to the product name, then
// restore the stream.
export function relabelEngineOutput(text) {
  return String(text).replace(/Camoufox/g, 'chuskybrowser engine');
}

async function withEngineLabel(fn) {
  const streams = [process.stdout, process.stderr];
  const originals = streams.map((s) => s.write);
  for (const s of streams) {
    const write = s.write;
    s.write = function (chunk, ...rest) {
      if (typeof chunk === 'string') chunk = relabelEngineOutput(chunk);
      return write.call(this, chunk, ...rest);
    };
  }
  try {
    return await fn();
  } finally {
    streams.forEach((s, i) => { s.write = originals[i]; });
  }
}

export async function downloadBundledCamoufox({
  createFetcher = () => new CompatibleCamoufoxFetcher(),
  shouldDownloadGeoIp = ALLOW_GEOIP,
  downloadGeoIp = downloadMMDB,
  downloadAddons = maybeDownloadAddons,
} = {}) {
  const fetcher = createFetcher();
  await withEngineLabel(() => fetcher.install());

  if (shouldDownloadGeoIp) downloadGeoIp();
  await downloadAddons(DefaultAddons);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  downloadBundledCamoufox().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
