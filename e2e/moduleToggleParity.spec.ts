import { test, expect } from '@playwright/test';

const TEST_USERNAME = 'e2e-admin';
const TEST_PASSWORD = 'e2e-test-password-not-real';

/**
 * Real E2E proof of UI/backend parity (Phase 4B). Logs into the actual running app, clicks a
 * real module toggle (Mission Control's Emergency Stop — still the global kill switch; idea-agent
 * lamps are separately wired to POST /api/v1/system/pipeline-agents),
 * and verifies the real backend state - not just a UI class name - actually changed via the same
 * REST endpoint the rest of the app reads from. Restores state afterward so the run is repeatable.
 */
test('logging in and clicking Emergency Stop actually changes the real backend trading state', async ({ page }) => {
  // Structural fix (mirrors globalSetup's DB seed for the Setup Wizard): AppWalkthrough.tsx gates
  // its "Welcome to Autonomous AI Trading" guided-tour modal purely on
  // localStorage.getItem("argus_tour_seen") - not a DB-persisted setting. addInitScript runs
  // before any page script on every navigation in this context, including the app's own React
  // mount, so the modal never renders in the first place instead of being dismissed after the
  // fact.
  await page.addInitScript(() => {
    window.localStorage.setItem('argus_tour_seen', 'true');
  });

  await page.goto('/');

  await page.getByPlaceholder('admin').fill(TEST_USERNAME);
  await page.getByPlaceholder('••••••••').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: /initialize secure session/i }).click();

  // Task 2B (3-phase remediation pass) - defensive fallback, not the primary fix. globalSetup
  // (playwright.config.ts) seeds settings.onboardingComplete = true before this test runs, which
  // should mean the Setup Wizard never appears at all. This dismisses it anyway if it somehow
  // does - e.g. a future globalSetup/webServer ordering change, or a real regression in the
  // onboarding-modal's own gating logic - so this test fails on the real thing it's testing
  // (Emergency Stop parity) instead of timing out opaquely behind an unrelated modal again.
  const skipSetupButton = page.getByRole('button', { name: /skip setup/i });
  if (await skipSetupButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await skipSetupButton.click();
  }

  // A second, separate modal - the "Welcome to Autonomous AI Trading" guided-walkthrough prompt -
  // also force-opens on a fresh login with no persisted dismissal state, independent of the Setup
  // Wizard above. Found by actually running this test after the Setup Wizard fix and seeing THIS
  // still blocked the Emergency Stop click behind a z-[100] overlay. "Remind Me Later" (not the
  // ambiguous "Skip", which could also match "Skip Setup" above) dismisses it for this session.
  const remindMeLaterButton = page.getByRole('button', { name: /remind me later/i });
  if (await remindMeLaterButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await remindMeLaterButton.click();
  }

  // Wait for the authenticated app shell - the command-tab nav button only renders once logged in.
  await page.locator('#tab-command-btn').waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('#tab-command-btn').click();

  // page.request (not the bare `request` fixture) shares the browser context's real session
  // cookie from the login above - every /api/* route in this app requires it.
  const before = await page.request.get('/api/v1/system/trading-state');
  expect(before.ok()).toBe(true);
  expect((await before.json()).tradingState).toBe('TRADING_ENABLED');

  await page.getByRole('button', { name: /emergency stop/i }).first().click();

  // The real proof of UI/backend parity: poll the real backend endpoint, not the DOM, for the
  // state a genuinely wired toggle must have actually changed.
  await expect(async () => {
    const res = await page.request.get('/api/v1/system/trading-state');
    expect((await res.json()).tradingState).toBe('EMERGENCY_STOP');
  }).toPass({ timeout: 10_000 });

  // Restore, so a re-run (or a human using this same disposable instance) starts from a clean state.
  const resumeRes = await page.request.post('/api/v1/system/resume');
  expect(resumeRes.ok()).toBe(true);
});
