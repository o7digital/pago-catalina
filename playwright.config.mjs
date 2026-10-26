import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test/browser',
  use: { baseURL: 'http://localhost:3000' },
  webServer: { command: 'node server/start.mjs', url: 'http://localhost:3000/api/health', env: { DATABASE_PATH: ':memory:', ADMIN_SETUP_TOKEN: 'browser-test-token', PUBLIC_ORIGIN: 'http://localhost:3000' }, reuseExistingServer: false }
});
