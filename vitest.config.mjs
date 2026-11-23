// Tests run inside the Workers runtime (Miniflare), against the real Worker and its Durable Objects:
// npm test. Each test file gets its own storage.
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

export default defineConfig(async () => {
  const directory = await readD1Migrations('./directory-migrations');
  const legacy = await readD1Migrations('./migrations');
  return {
    plugins: [cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          SESSION_SECRET: 'test-session-secret-0123456789abcdefghijklmnop',
          CHAT_INGEST_TOKEN: 'legacy-shared-token-0123456789abcdefghijklmnop',
          OPS_TOKEN: 'test-ops-token-0123456789abcdefghijklmnopqrstu',
          SUPER_ADMIN_EMAIL: 'operator@example.org',
          ADMIN_EMAIL: 'oldadmin@example.org',
          EMAIL_DEV_LOG: '1',
          TEST_DIRECTORY_MIGRATIONS: directory,
          TEST_LEGACY_MIGRATIONS: legacy,
        },
      },
    })],
    test: { setupFiles: ['./test/setup.js'] },
  };
});
