// Telling admins about a newer mod (src/modupdate.js), from mod/CHANGELOG.md (src/changelog.js).
import { describe, expect, it } from 'vitest';
import { compareVersions, modUpdate, modUpdateMessage } from '../src/modupdate.js';
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

const mod = { version: '1.2.0', jar: 'mcstats-chat-1.2.0.jar', releases: parseChangelog(CHANGELOG) };

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
    expect(u).toMatchObject({ current: '1.0.0', latest: '1.2.0', urgent: true, behind: 2, jar_url: '/downloads/mcstats-chat-1.2.0.jar' });
    expect(u.urgent_why).toEqual(['1.2.0: Fixes the token being written to the log.']);
    expect(modUpdate('1.1.0', mod).releases.map((r) => r.version)).toEqual(['1.2.0']);
  });

  it('makes a small message for the mod', () => {
    const m = modUpdateMessage('0.0.1', 3);
    expect(m).toMatchObject({ type: 'update', current: '0.0.1', latest: MOD.version, jar: `/downloads/${MOD.jar}` });
    expect(m.changes.length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(modUpdateMessage('0.0.1')).length).toBeLessThan(8192); // the mod drops bigger messages
    expect(modUpdateMessage(MOD.version)).toBe(null);
  });
});
