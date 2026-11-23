import { describe, expect, it } from 'vitest';
import { call, chatEvent, chatTexts, makeServer, newKey, upload, viewerCookie } from './helpers.js';

describe('a server end to end', () => {
  it('is made, takes the mod upload, and shows it to a viewer', async () => {
    const a = await makeServer('alpha');
    const key = await newKey(a);
    const up = await upload(key, [chatEvent('hello from alpha')]);
    expect(up.status, await up.clone().text()).toBe(200);
    expect((await up.json()).accepted).toBe(1);
    const view = await viewerCookie(a);
    const res = await call('/s/alpha/api/status', { cookie: view });
    expect(res.status, await res.clone().text()).toBe(200);
    const { texts } = await chatTexts(a, view);
    expect(texts).toContain('hello from alpha');
  });
});
