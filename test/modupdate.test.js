// Telling admins about a newer mod (src/modupdate.js), from mod/CHANGELOG.md (src/changelog.js).
import { describe, expect, it } from 'vitest';
import { compareGame, compareVersions, editionFromAgent, gameLabel, inRange, modJar, modUpdate, modUpdateMessage } from '../src/modupdate.js';
import { MOD } from '../src/modinfo.gen.js';
import { parseChangelog } from '../src/changelog.js';

const CHANGELOG = `# Changelog

## 1.2.0 (2026-01-03)

**Urgent:** Fixes the \`token\` being written to the log.

### Fixed

- **Token in the log.** The token was logged
  at every start.

## 1.1.0 (2026-01-02)

Something new.

### Added

- Deaths are sent.
- **Teams.** Colors.

## 1.0.0 (2026-01-01)

### Added

- First release.
`;

const mod = {
  version: '1.2.0', jar: 'mcstats-chat-1.2.0+mc26.2.jar', minecraft_built: '26.2', releases: parseChangelog(CHANGELOG),
  downloads: [
    { file: 'mcstats-chat-1.2.0+mc26.2.jar', version: '1.2.0', minecraft: '~26.2', label: '26.2.x' },
    { file: 'mcstats-chat-1.2.0+mc1.21.11.jar', version: '1.2.0', minecraft: '1.21.11', label: '1.21.11' },
    { file: 'mcstats-chat-1.2.0+mc1.21.10.jar', version: '1.2.0', minecraft: '>=1.21.9 <=1.21.10', label: '1.21.9–1.21.10' },
    { file: 'mcstats-chat-1.1.0.jar', version: '1.1.0', minecraft: '~26.2', label: '26.2.x' },
    { file: 'mcstats-paper-1.2.0+mc26.2.jar', edition: 'paper', version: '1.2.0', minecraft: '26.2', label: '26.2' },
    { file: 'mcstats-paper-1.2.0+mc1.21.11.jar', edition: 'paper', version: '1.2.0', minecraft: '1.21.11', label: '1.21.11' },
  ],
  paper: { jar: 'mcstats-paper-1.2.0+mc26.2.jar' },
};

describe('changelog', () => {
  it('reads each release, its sections and whether it is urgent', () => {
    const [r12, r11] = mod.releases;
    expect(mod.releases.map((r) => r.version)).toEqual(['1.2.0', '1.1.0', '1.0.0']);
    expect(r12).toMatchObject({ date: '2026-01-03', urgent: true, urgent_why: 'Fixes the token being written to the log.' });
    expect(r12.changes).toEqual([{ section: 'Fixed', items: [{ title: 'Token in the log', text: 'The token was logged at every start.' }] }]);
    expect(r11).toMatchObject({ urgent: false, summary: 'Something new.' });
    expect(r11.changes[0].items).toEqual([{ title: null, text: 'Deaths are sent.' }, { title: 'Teams', text: 'Colors.' }]);
  });

  it('has an entry for the version being shipped', () => {
    expect(MOD.releases[0].version).toBe(MOD.version);
  });
});

describe('mod update', () => {
  it('compares versions', () => {
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
    expect(compareVersions('dev', '2.0.0')).toBe(null);
  });

  it('is nothing for the newest version, a newer one or one it can’t tell', () => {
    for (const v of ['1.2.0', '1.3.0', 'dev', null]) expect(modUpdate(v, mod)).toBe(null);
  });

  it('lists the releases since, and is urgent if any of them is', () => {
    const u = modUpdate('1.0.0', mod);
    expect(u).toMatchObject({ current: '1.0.0', latest: '1.2.0', urgent: true, behind: 2, jar_url: '/downloads/mcstats-chat-1.2.0+mc26.2.jar' });
    // a server that said it runs 1.21.10 is pointed at the jar built for it
    expect(modUpdate('1.0.0', mod, '1.21.10').jar).toBe('mcstats-chat-1.2.0+mc1.21.10.jar');
    expect(u.urgent_why).toEqual(['1.2.0: Fixes the token being written to the log.']);
    expect(modUpdate('1.1.0', mod).releases.map((r) => r.version)).toEqual(['1.2.0']);
  });

  it('makes a small message for the mod', () => {
    const m = modUpdateMessage('0.0.1', 3);
    expect(m).toMatchObject({ type: 'update', current: '0.0.1', latest: MOD.version, jar: `/downloads/${MOD.jar}` });
    // the jar the site serves is a file it has
    expect(MOD.downloads.map((d) => d.file)).toContain(MOD.jar);
    expect(m.changes.length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(modUpdateMessage('0.0.1')).length).toBeLessThan(8192); // the mod drops bigger messages
    expect(modUpdateMessage(MOD.version)).toBe(null);
  });
});

describe('Minecraft versions', () => {
  it('compares them part by part', () => {
    expect(compareGame('1.21.11', '1.21.9')).toBe(1);
    expect(compareGame('26.1', '1.21.11')).toBe(1);
    expect(compareGame('26.2', '26.2.0')).toBe(0);
  });

  it('reads Fabric ranges', () => {
    expect(inRange('26.2.1', '~26.2')).toBe(true);
    expect(inRange('26.3', '~26.2')).toBe(false);
    expect(inRange('1.21.10', '>=1.21.9 <=1.21.10')).toBe(true);
    expect(inRange('1.21.11', '>=1.21.9 <=1.21.10')).toBe(false);
    expect(inRange('26.1.2', '>=26.1 <26.2')).toBe(true);
    expect(inRange('1.21.11', '1.21.11')).toBe(true);
    expect(inRange(null, '1.21.11')).toBe(false);
  });

  it('labels them as people say them', () => {
    expect(gameLabel('~26.2')).toBe('26.2.x');
    expect(gameLabel('>=26.1 <26.2')).toBe('26.1.x');
    expect(gameLabel('>=1.21.6 <=1.21.8')).toBe('1.21.6–1.21.8');
    expect(gameLabel('1.21.5')).toBe('1.21.5');
  });

  it('picks the jar for a server', () => {
    expect(modJar('1.21.11', null, mod).file).toBe('mcstats-chat-1.2.0+mc1.21.11.jar');
    expect(modJar(null, null, mod).file).toBe('mcstats-chat-1.2.0+mc26.2.jar'); // unknown: the default build
    expect(modJar('1.20.1', null, mod).file).toBe('mcstats-chat-1.2.0+mc26.2.jar'); // nothing built for it
    expect(modJar('26.2', '1.1.0', mod)).toMatchObject({ file: 'mcstats-chat-1.1.0.jar', url: '/downloads/mcstats-chat-1.1.0.jar' });
  });

  it('picks the Paper plugin for a Paper server, and never a Fabric jar for one', () => {
    expect(modJar('1.21.11', null, mod, 'paper').file).toBe('mcstats-paper-1.2.0+mc1.21.11.jar');
    expect(modJar('26.2', null, mod, 'paper').file).toBe('mcstats-paper-1.2.0+mc26.2.jar');
    expect(modJar(null, null, mod, 'paper').file).toBe('mcstats-paper-1.2.0+mc26.2.jar'); // unknown: the default build
    // no Paper build of 1.1.0: the plugin the site calls default, not a Fabric jar
    expect(modJar('26.2', '1.1.0', mod, 'paper')).toMatchObject({ file: 'mcstats-paper-1.2.0+mc26.2.jar', edition: 'paper' });
    // a Fabric server still never gets a Paper jar
    expect(modJar('1.21.11', null, mod, 'fabric').file).toBe('mcstats-chat-1.2.0+mc1.21.11.jar');
    expect(modUpdate('1.0.0', mod, '1.21.11', 'paper')).toMatchObject({ edition: 'paper', jar_url: '/downloads/mcstats-paper-1.2.0+mc1.21.11.jar' });
    expect(modUpdate('1.0.0', mod, '1.21.11')).toMatchObject({ edition: 'fabric', jar_url: '/downloads/mcstats-chat-1.2.0+mc1.21.11.jar' });
  });

  it('tells the Paper plugin from the Fabric mod by its User-Agent', () => {
    expect(editionFromAgent('mcstats-chat/2.4.0 (Minecraft 26.2) Paper')).toBe('paper');
    expect(editionFromAgent('mcstats-chat/2.4.0 (Minecraft 26.2)')).toBe('fabric');
    expect(editionFromAgent('mcstats-chat/1.2.0')).toBe('fabric');
    expect(editionFromAgent(null)).toBe('fabric');
  });
});
