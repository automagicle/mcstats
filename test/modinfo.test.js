// src/modinfo.gen.js says what mod/ says (run `node scripts/mod-info.mjs` after changing the mod's versions).
import { describe, expect, it } from 'vitest';
import { MOD } from '../src/modinfo.gen.js';

describe('mod info', () => {
  it('names the versions the mod is built with', () => {
    expect(MOD.jar).toBe(`mcstats-chat-${MOD.version}.jar`);
    expect(MOD.environment).toBe('server');
    expect(MOD.fabric_api.bundled).toBe(true);
    expect(MOD.config_template).toMatch(/^url=$/m);
    expect(MOD.config_template).toMatch(/^token=$/m);
  });
});
