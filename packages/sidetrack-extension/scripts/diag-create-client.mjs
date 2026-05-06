import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const [context] = browser.contexts();
const sw = context.serviceWorkers().find((w) => w.url().includes('background.js'));
// Reproduce createAnnotationClient inline to see exactly which path fails
const result = await sw.evaluate(async () => {
  const SETTINGS_KEY = 'sidetrack.settings';
  const get = (k) => new Promise((r) => chrome.storage.local.get({ [k]: undefined }, (v) => r(v[k])));
  const settings = await get(SETTINGS_KEY);
  const isRecord = (v) => typeof v === 'object' && v !== null;
  const trace = {
    settingsType: typeof settings,
    isRecord_settings: isRecord(settings),
    settingsKeys: settings ? Object.keys(settings) : null,
    isRecord_companion: isRecord(settings?.companion),
    companionKeys: settings?.companion ? Object.keys(settings.companion) : null,
    portType: typeof settings?.companion?.port,
    portValue: settings?.companion?.port,
    bridgeKeyType: typeof settings?.companion?.bridgeKey,
    bridgeKeyTrim: typeof settings?.companion?.bridgeKey === 'string' ? settings.companion.bridgeKey.trim().length : 0,
  };
  return trace;
});
console.log(JSON.stringify(result, null, 2));
await browser.close();
