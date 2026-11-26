// mod/CHANGELOG.md as data, for scripts/mod-info.mjs (which bakes it into src/modinfo.gen.js) and its tests.
// No file reading here, so it runs in the Worker's test runtime too.

// Plain text from a line of the changelog's Markdown: no **bold**, `code` or [links](url).
const plain = (s) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim();
const short = (s, max = 200) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
// A bullet: "**Whispers.** `/w` typed on…" → { title: 'Whispers', text: '/w typed on…' }; one without a bold
// lead-in has no title, and its first sentence is what a short list (the mod's in-game notice) shows.
function item(md) {
  const bold = /^\*\*(.+?)\*\*\s*/.exec(md);
  const text = short(plain(bold ? md.slice(bold[0].length) : md), 600);
  return { title: bold ? short(plain(bold[1]).replace(/[.:]$/, ''), 80) : null, text };
}

// Every release in mod/CHANGELOG.md, newest first: { version, date, urgent, urgent_why, summary, changes }.
// changes is [{ section: 'Added' | 'Changed' | 'Fixed' | …, items: [{ title|null, text }] }], from the bullets
// under each ### heading. A release is urgent when the line right after its heading is "**Urgent:** why":
// the dashboard and the mod tell admins about those louder (src/modupdate.js).
export function parseChangelog(md) {
  const out = [];
  let rel = null, section = null, bullet = null;
  const end = () => {
    if (bullet) section.items.push(item(bullet));
    bullet = null;
  };
  for (const line of md.split('\n')) {
    const h2 = /^## (\d+\.\d+\.\d+\S*)\s*(?:\((\d{4}-\d\d-\d\d)\))?/.exec(line);
    if (h2) {
      end();
      rel = { version: h2[1], date: h2[2] ?? null, urgent: false, urgent_why: null, summary: null, changes: [] };
      out.push(rel);
      section = null;
      continue;
    }
    if (!rel) continue;
    const urgent = /^\*\*Urgent:?\*\*:?\s*(.*)$/i.exec(line);
    if (urgent && !section && !rel.summary) {
      rel.urgent = true;
      rel.urgent_why = short(plain(urgent[1]) || 'This release fixes something serious.');
      continue;
    }
    const h3 = /^### (.+)$/.exec(line);
    if (h3) {
      end();
      section = { section: plain(h3[1]), items: [] };
      rel.changes.push(section);
      continue;
    }
    if (!section) {
      if (line.trim() && !rel.summary) rel.summary = short(plain(line.split(/(?<=[.!?])\s/)[0]));
      continue;
    }
    if (/^- /.test(line)) { end(); bullet = line.slice(2); }
    else if (bullet && /^\s+\S/.test(line)) bullet += ` ${line.trim()}`;
    else end();
  }
  end();
  for (const r of out) r.changes = r.changes.filter((c) => c.items.length);
  return out;
}
