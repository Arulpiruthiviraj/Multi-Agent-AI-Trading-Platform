import { chromium } from '@playwright/test';
import dotenv from 'dotenv';

dotenv.config();

const VIEWPORTS = [
  { name: '320-se', width: 320, height: 568 },
  { name: '390-iphone', width: 390, height: 844 },
  { name: '412-galaxy', width: 412, height: 915 },
];

function overflowReport() {
  const docW = document.documentElement.scrollWidth;
  const winW = window.innerWidth;
  const root = document.getElementById('mobile-mission-control');
  const rootOverflow = root ? root.scrollWidth - root.clientWidth : null;
  const text = document.body.innerText;
  return {
    winW,
    docW,
    docOverflow: docW - winW,
    rootOverflow,
    hasSearch: !!document.querySelector('input[placeholder="Search settings..."]'),
    hasResetAll: text.includes('Reset all to .env'),
    navLabels: Array.from(document.querySelectorAll('.mobile-nav-item span')).map((s) => s.textContent),
  };
}

async function dismissOverlays(page) {
  const skip = page.getByRole('button', { name: /skip setup/i });
  if (await skip.isVisible({ timeout: 2500 }).catch(() => false)) await skip.click();
  const later = page.getByRole('button', { name: /remind me later/i });
  if (await later.isVisible({ timeout: 2500 }).catch(() => false)) await later.click();
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: VIEWPORTS[0] });
await context.addInitScript(() => {
  window.localStorage.setItem('argus_tour_seen', 'true');
  window.localStorage.setItem('argus_mobile_layout_override', 'mobile');
});
const page = await context.newPage();
page.setDefaultTimeout(20_000);

await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded' });
await page.getByPlaceholder('admin').fill(process.env.AUTH_USERNAME || 'admin');
await page.getByPlaceholder('••••••••').fill(process.env.AUTH_PASSWORD || '');
await page.getByRole('button', { name: /initialize secure session/i }).click();
await dismissOverlays(page);

await page.waitForSelector('#mobile-mission-control', { timeout: 20_000 });
await page.locator('nav .mobile-nav-item', { hasText: 'Set' }).click();
await page.getByPlaceholder('Search settings...').waitFor({ state: 'visible' });

const reports = {};
for (const vp of VIEWPORTS) {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.waitForTimeout(250);
  reports[vp.name] = await page.evaluate(overflowReport);
}

const oppSwitch = page.getByRole('switch', { name: 'Opportunity loop' });
await oppSwitch.waitFor({ state: 'visible' });
const beforeChecked = await oppSwitch.getAttribute('aria-checked');
await oppSwitch.click();
await page.waitForTimeout(1000);
const afterToggle = await page.evaluate(() => document.body.innerText);
const afterChecked = await oppSwitch.getAttribute('aria-checked');

const resetBtn = page.getByRole('button', { name: /Reset Opportunity scanner to \.env/i });
const resetVisible = await resetBtn.isVisible().catch(() => false);
if (resetVisible) {
  await resetBtn.click();
  await page.waitForTimeout(1000);
}
const afterResetText = await page.evaluate(() => document.body.innerText);
const afterResetChecked = await oppSwitch.getAttribute('aria-checked');

await page.getByRole('button', { name: /portfolio & exits/i }).click();
await page.getByRole('button', { name: /quant & ai engine/i }).click();
await page.getByRole('button', { name: /broker & execution/i }).click();
const expandedText = await page.evaluate(() => document.body.innerText);

await browser.close();

console.log(JSON.stringify({
  loginLanded: true,
  beforeChecked,
  afterChecked,
  resetVisible,
  afterResetChecked,
  toggleShowedDbOverride: afterToggle.includes('DB Override'),
  resetShowedEnv: afterResetText.includes('.env Default') || afterResetChecked === beforeChecked,
  paperLockVisible: /locked in paper mode|paper trading only/i.test(expandedText),
  quorumVisible: expandedText.includes('0.75 conf'),
  reports,
}, null, 2));
