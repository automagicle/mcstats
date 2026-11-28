// src/modinfo.gen.js says what mod/ says (run `node scripts/mod-info.mjs` after changing the mod's versions).
import { describe, expect, it } from 'vitest';
import { MOD } from '../src/modinfo.gen.js';

describe('mod info', () => {
  it('names the versions the mod is built with', () => {
    expect(MOD.jar).toBe(`mcstats-chat-${MOD.version}+mc${MOD.minecraft_built}.jar`);
    expect(MOD.minecraft).not.toMatch(/\$\{/); // the real range, not fabric.mod.json's template
    expect(MOD.environment).toBe('server');
    expect(MOD.fabric_api.bundled).toBe(true);
    expect(MOD.config_template).toMatch(/^url=$/m);
    expect(MOD.config_template).toMatch(/^token=$/m);
  });

  it('lists a jar it serves for the default Minecraft version, and every jar names its range', () => {
    expect(MOD.downloads.map((d) => d.file)).toContain(MOD.jar);
    for (const d of MOD.downloads) {
      expect(d.file).toMatch(d.edition === 'paper' ? /^mcstats-paper-[\w.+-]+\.jar$/ : /^mcstats-chat-[\w.+-]+\.jar$/);
      expect(['fabric', 'paper']).toContain(d.edition);
      expect(d.minecraft).toBeTruthy();
      expect(d.label).toBeTruthy();
    }
  });

  it('offers the Paper plugin for every Minecraft version it is built for, each jar for exactly one', () => {
    expect(MOD.paper.jar).toBe(`mcstats-paper-${MOD.version}+mc${MOD.minecraft_built}.jar`);
    expect(MOD.paper.config_file).toBe('plugins/mcstats/mcstats-chat.properties');
    const paper = MOD.downloads.filter((d) => d.edition === 'paper' && d.version === MOD.version);
    expect(paper.map((d) => d.minecraft).sort()).toEqual([...MOD.paper.minecraft].sort());
    for (const d of paper) {
      expect(d.file).toBe(`mcstats-paper-${MOD.version}+mc${d.minecraft}.jar`);
      expect(d.label).toBe(d.minecraft);
    }
  });
});
