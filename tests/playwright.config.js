// Playwright configuration for the Discpress UI tests.
// The page under test is dist/discpress.html unless DISCPRESS_HTML points elsewhere
// (for example a page freshly assembled from app/ by `npm run test:dev`).
import { defineConfig, devices } from '@playwright/test';

const PORT = +(process.env.PORT || 4173);

// Only Chromium is installed in the cloud environment; phones and tablets are
// emulated with Chromium (viewport, touch, user agent), not real WebKit.
const iPhone = { ...devices['iPhone 13'], browserName: 'chromium', defaultBrowserType: 'chromium' };
const pixel = { ...devices['Pixel 7'] };

export default defineConfig({
  testDir: 'ui',
  outputDir: '.cache/test-results',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  // conversions are CPU heavy: keep parallelism modest so timings stay stable
  workers: +(process.env.WORKERS || 2),
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { outputFolder: '.cache/report', open: 'never' }]],
  globalSetup: './support/global-setup.js',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `node support/server.js ${PORT}`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /(layout|mobile)\.spec/ },
    { name: 'file-url', use: { ...devices['Desktop Chrome'], fileUrl: true }, testMatch: /(smoke|recovery)\.spec/ },
    { name: 'iphone', use: iPhone, testMatch: /(smoke|mobile|hosted)\.spec/ },
    { name: 'android', use: pixel, testMatch: /(smoke|mobile|hosted)\.spec/ },
    { name: 'layout', use: { ...devices['Desktop Chrome'] }, testMatch: /layout\.spec/ },
    // Real WebKit (Safari's engine) and Firefox, when installed: EXTRA_BROWSERS=1 (tests/README.md)
    ...(process.env.EXTRA_BROWSERS ? [
      { name: 'webkit', use: { ...devices['Desktop Safari'] }, testIgnore: /(layout|mobile)\.spec/ },
      { name: 'iphone-webkit', use: { ...devices['iPhone 13'] }, testMatch: /(smoke|mobile|hosted)\.spec/ },
      { name: 'firefox', use: { ...devices['Desktop Firefox'] }, testIgnore: /(layout|mobile)\.spec/ },
    ] : []),
  ],
});
