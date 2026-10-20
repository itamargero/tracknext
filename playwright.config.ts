import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:3187', headless: true, trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run start --prefix examples/next-app',
    url: 'http://127.0.0.1:3187',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
