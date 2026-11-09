import { describe, expect, test } from '@jest/globals';
import { OS_NAME } from 'camoufox-js/dist/pkgman.js';
import { BUNDLED_CAMOUFOX_RELEASE, CompatibleCamoufoxFetcher } from '../../lib/camoufox-download.js';

describe('bundled Camoufox release selection', () => {
  test('accepts the pinned binary and rejects newer incompatible releases', () => {
    const fetcher = new CompatibleCamoufoxFetcher();
    const asset = (release) => ({
      name: `camoufox-${release}-${OS_NAME}.${fetcher.arch}.zip`,
      browser_download_url: `https://example.invalid/${release}`,
    });

    expect(fetcher.checkAsset(asset(BUNDLED_CAMOUFOX_RELEASE))?.[0].fullString)
      .toBe(BUNDLED_CAMOUFOX_RELEASE);
    expect(fetcher.checkAsset(asset('156.0.1-beta.34'))).toBeNull();
  });
});

describe('engine progress label', () => {
  test('renames the engine in download output to the product name', async () => {
    const { relabelEngineOutput, downloadBundledCamoufox } = await import('../../lib/camoufox-download.js');
    expect(relabelEngineOutput('Downloading Camoufox... 24%')).toBe('Downloading chuskybrowser engine... 24%');

    const seen = [];
    const fakeFetcher = {
      install: async () => { process.stderr.write('Downloading Camoufox... 50%'); seen.push('done'); },
    };
    const before = process.stderr.write;
    await downloadBundledCamoufox({
      createFetcher: () => fakeFetcher,
      shouldDownloadGeoIp: false,
      downloadAddons: async () => {},
    });
    expect(process.stderr.write).toBe(before);
    expect(seen).toEqual(['done']);
  });
});
