// The Egg SMP add-on: everything about eggs on a server's dashboard.
//
// On Egg SMP every player has an egg (from the egg datapack) that gives them abilities. With this add-on
// switched on for a server (src/addons.js, Admin → Server), its dashboard shows:
//   - the egg's name beside a player's team, and under their 3D model
//   - the egg in the model's off hand, with its particles
//   - an egg card beside Combat on the player's page: passive, primary, secondary, level and energy,
//     and the item's tooltip word for word as the game shows it
//   - an Egg column on Admin → Settings, to say which egg each player has
// Which egg a player has comes from the server mod (it reports the egg's number, level and energy with
// their gear), else from the roster's "egg".
//
// Files here:
//   addon.js     this: registers the hooks below with the dashboard (public/app.js, "add-ons")
//   addon.css    the egg card's styles
//   eggdata.js   what each egg does, loaded when a player page shows an egg
//   eggtips.js   each egg's in-game tooltip, made by scripts/egg-tooltips.py from the datapack
//
// No other server's page loads any of this.
(() => {
  const HERE = '/addons/eggsmp/';
  // the dashboard's own helpers, handed over by setup()
  let el, icon, recall, remember, ago, rosterOf, BASE;

  // The eggs (from the egg datapack): name, color, and the game item each one is drawn as.
  const EGGS = {
    life: ['Life Egg', '#FF4F8B', 'sniffer_egg'],
    hunger: ['Harvest Egg', '#D6E35A', 'turtle_egg'],
    sky: ['Skyblocker Egg', '#7DD3FC', 'vex_spawn_egg'],
    gravity: ['Gravity Egg', '#9BC9FF', 'breeze_spawn_egg'],
    gambler: ['Gambler Egg', '#FFE56A', 'piglin_spawn_egg'],
    fire: ['Fire Egg', '#FF7A2E', 'blaze_spawn_egg'],
    blood: ['Blood Egg', '#C41818', 'magma_cube_spawn_egg'],
    echo: ['Echo Egg', '#2DD4BF', 'warden_spawn_egg'],
    aqua: ['Aqua Egg', '#3DDCFF', 'tropical_fish_spawn_egg'],
    meteor: ['Meteor Egg', '#FF8C2A', 'strider_spawn_egg'],
    wizard: ['Wizard Egg', '#B14BFF', 'enderman_spawn_egg'],
    train: ['Train Egg', '#E03A3A', 'spider_spawn_egg'],
    redstone: ['Redstone Egg', '#FF3B3B', 'mooshroom_spawn_egg'],
    binding: ['Binding Egg', '#C5CCD6', 'stray_spawn_egg'],
    murica: ["'Murica Egg", '#C8102E', 'parrot_spawn_egg'],
    dung: ['Dung Egg', '#A0693A', 'tadpole_spawn_egg'],
    fat: ['Fat Egg', '#FF9EB5', 'pig_spawn_egg'],
    woods: ['Woods Egg', '#3C8F3A', 'creaking_spawn_egg'],
    smite: ['Smite Egg', '#2BB7A0', 'guardian_spawn_egg'],
    stash: ['Stash Egg', '#3DDC97', 'villager_spawn_egg'],
    sulfur: ['Sulfur Egg', '#E8D44D', 'sulfur_cube_spawn_egg'],
    subzero: ['Sub-Zero Egg', '#8FD8FF', 'stray_spawn_egg'],
    combo: ['Combo Egg', '#7DD3FF', 'allay_spawn_egg'],
    electric: ['Electric Egg', '#4FD8FF', 'glow_squid_spawn_egg'],
    deadshot: ['Deadshot Egg', '#E04848', 'pillager_spawn_egg'],
    purpur: ['Purpur Egg', '#C9A0DC', 'shulker_spawn_egg'],
    doggo: ['Doggo Egg', '#D9A066', 'wolf_spawn_egg'],
  };
  // The egg mod's number for each egg (its egg.type score), which the server mod reports with a player's gear.
  const EGG_BY_ID = {
    1: 'life', 2: 'hunger', 3: 'sky', 4: 'gravity', 5: 'gambler', 7: 'fire', 8: 'blood', 9: 'echo', 10: 'aqua', 11: 'meteor',
    12: 'wizard', 13: 'train', 14: 'redstone', 15: 'binding', 16: 'murica', 17: 'dung', 18: 'fat', 19: 'woods', 20: 'smite',
    21: 'stash', 22: 'sulfur', 23: 'subzero', 24: 'combo', 25: 'electric', 26: 'deadshot', 27: 'purpur', 28: 'doggo',
  };
  // A player's egg: the one the server last reported them having, else the one the roster gives them.
  const playerEggId = (name, gear) => EGG_BY_ID[gear?.egg?.type] || rosterOf(name)?.egg || null;
  // An egg the datapack doesn't have (yet): its name from the id, drawn as a plain egg.
  const eggInfo = (id) => {
    if (!id) return null;
    const [name, color, model] = EGGS[id] || [`${id[0].toUpperCase()}${id.slice(1)} Egg`, null, 'egg'];
    return { id, name, color, model };
  };

  // Their egg as they carry it (the off hand first: that's where it works), else the season's assignment.
  function heldEgg(gear, assigned) {
    const carried = [gear?.offhand, gear?.mainhand, ...(gear?.items || [])].find((it) => it?.egg && it.model);
    if (carried) return { id: carried.model };
    const info = eggInfo(assigned);
    return info ? { id: info.model } : null;
  }

  // The particles around a player holding their egg (core/Aura.java and core/EggType.java in the egg mod):
  // the main color, the accent color, and the egg's own accent particle. public/player3d.js draws them.
  const AURA = {
    life: [1.0, 0.31, 0.55, 0.79, 0.09, 0.29, 'end_rod'],
    hunger: [0.84, 0.89, 0.35, 0.88, 0.48, 0.0, 'happy_villager'],
    sky: [0.49, 0.83, 0.99, 0.01, 0.52, 0.78, 'enchant'],
    gravity: [0.61, 0.79, 1.0, 0.15, 0.39, 0.92, 'small_gust'],
    gambler: [0.96, 0.77, 0.27, 0.24, 0.86, 0.52, 'happy_villager'],
    fire: [1.0, 0.48, 0.12, 1.0, 0.18, 0.05, 'flame'],
    blood: [0.77, 0.09, 0.09, 1.0, 0.16, 0.16, 'crimson_spore'],
    echo: [0.18, 0.83, 0.75, 0.06, 0.46, 0.43, 'sculk_soul'],
    aqua: [0.24, 0.86, 1.0, 0.08, 0.40, 0.90, 'nautilus'],
    meteor: [1.0, 0.94, 0.62, 1.0, 0.86, 0.42, 'end_rod'],
    train: [0.88, 0.23, 0.23, 0.60, 0.64, 0.69, 'smoke'],
    binding: [0.77, 0.80, 0.84, 0.89, 0.70, 0.25, 'crit'],
    murica: [0.78, 0.06, 0.18, 0.24, 0.43, 1.0, 'firework'],
    dung: [0.63, 0.41, 0.23, 0.55, 0.64, 0.17, 'composter'],
    wizard: [0.69, 0.29, 1.0, 0.42, 0.12, 0.69, 'portal'],
    redstone: [1.0, 0.23, 0.23, 0.55, 0.0, 0.0, 'electric_spark'],
    fat: [1.0, 0.62, 0.71, 0.79, 0.42, 0.54, 'heart'],
    woods: [0.24, 0.56, 0.23, 0.61, 0.80, 0.40, 'happy_villager'],
    smite: [0.17, 0.72, 0.63, 0.49, 0.30, 1.0, 'nautilus'],
    stash: [0.24, 0.86, 0.59, 0.77, 0.64, 0.35, 'happy_villager'],
    sulfur: [0.91, 0.83, 0.30, 0.23, 0.23, 0.23, 'ash'],
    subzero: [0.56, 0.85, 1.0, 0.91, 0.98, 1.0, 'snowflake'],
    combo: [0.49, 0.83, 1.0, 0.91, 0.97, 1.0, 'crit'],
    electric: [0.31, 0.85, 1.0, 1.0, 0.94, 0.48, 'electric_spark'],
    deadshot: [0.88, 0.28, 0.28, 0.91, 0.78, 0.45, 'crit'],
    purpur: [0.79, 0.63, 0.86, 0.66, 0.43, 0.66, 'end_rod'],
  };
  const AURA_CRACKED = [0.45, 0.45, 0.48, 0.28, 0.28, 0.3, 'smoke'];

  /* ---------- the egg card: what a player's egg does, and (from the server mod) its level and energy ---------- */

  let eggInfoLoad = null;
  const loadEggInfo = () => (eggInfoLoad ??= import(`${HERE}eggdata.js`).then((m) => m.EGG_INFO).catch(() => { eggInfoLoad = null; return {}; }));

  // The egg's item tooltip word for word as the game shows it (eggtips.js here, made from the egg
  // datapack by scripts/egg-tooltips.py), folded away under the summary until it's asked for. It opens
  // at the level and energy the player's egg has, and either level can be looked at.
  let eggTipsLoad = null;
  const loadEggTips = () => (eggTipsLoad ??= import(`${HERE}eggtips.js`).catch(() => { eggTipsLoad = null; return null; }));

  function eggGameTip(egg, live) {
    let tier = live && live.tier >= 2 ? 2 : 1;
    const energy = live ? Math.max(0, Math.min(5, live.energy ?? 0)) : 5;
    let open = recall('eggFull') === '1';
    const box = el('div', { class: 'egg-game' });
    const toggle = el('button', { type: 'button', class: 'egg-game-toggle' });
    const run = ([text, color, style]) => el('span', { style: `color:${color};${style & 1 ? 'font-weight:700;' : ''}${style & 2 ? 'font-style:italic' : ''}`, text });
    const draw = async () => {
      toggle.setAttribute('aria-expanded', String(open));
      toggle.replaceChildren(icon([open ? 'M3.5 10 8 5.5 12.5 10' : 'M3.5 6 8 10.5 12.5 6'], 12), open ? 'Hide the in-game description' : 'Show the full in-game description');
      box.hidden = !open;
      if (!open) return;
      if (!box.firstChild) box.replaceChildren(el('div', { class: 'muted egg-game-note', text: 'Loading…' }));
      const tips = await loadEggTips();
      const lines = tips?.EGG_TIPS[egg.id]?.[tier];
      if (!lines) {
        box.replaceChildren(el('div', { class: 'muted egg-game-note', text: tips ? 'This egg’s in-game description isn’t in the egg datapack.' : 'Couldn’t load the in-game description.' }));
        return;
      }
      const shown = lines.map((line, i) => (i === 0 && energy < 1 ? [...line, [' (Cracked)', '#AAAAAA', 0]]
        : i === 1 && line.length ? [line[0], ...tips.EGG_TIP_ENERGY[energy]] : line));
      const levels = el('div', { class: 'seg egg-game-level', role: 'group', 'aria-label': 'Level shown' }, ...[1, 2].map((n) => {
        const b = el('button', { type: 'button', text: n === 1 ? 'Level I' : 'Level II', 'aria-pressed': String(n === tier) });
        b.addEventListener('click', () => { tier = n; draw(); });
        return b;
      }));
      box.replaceChildren(
        el('div', { class: 'egg-game-head' }, levels,
          el('span', { class: 'muted', text: live ? `theirs is Level ${live.tier >= 2 ? 'II' : 'I'}` : 'as the item shows it in game' })),
        el('div', { class: 'item-tip egg-game-tip', tabindex: '0' },
          ...shown.map((line, i) => el('div', { class: `it-line${i ? '' : ' it-name'}` }, ...(line.length ? line.map(run) : ['\u00a0'])))));
    };
    toggle.addEventListener('click', () => {
      open = !open;
      remember('eggFull', open ? '1' : '0');
      draw();
    });
    draw();
    return el('div', { class: 'egg-game-wrap' }, toggle, box);
  }

  // The card beside Combat on a player's page: the box is handed over at once (so the page is laid out
  // with it) and filled in when the egg's description has loaded.
  function playerCard(name, gear) {
    const live = gear?.egg && EGG_BY_ID[gear.egg.type] ? gear.egg : null;
    const egg = eggInfo((live && EGG_BY_ID[live.type]) || rosterOf(name)?.egg);
    if (!egg) return null;
    const box = el('div', { class: 'egg-body' });
    fillCard(box, egg, live, gear).catch((e) => console.error('egg card:', e));
    return box;
  }

  async function fillCard(box, egg, live, gear) {
    const info = (await loadEggInfo())[egg.id];

    const head = el('div', { class: 'egg-head' },
      el('img', { class: 'egg-icon', src: `${BASE}/api/mc/textures/item/${egg.model}.png`, alt: '', width: 44, height: 44 }),
      el('div', { class: 'egg-title' },
        el('h2', { class: 'p-egg', style: egg.color ? `--egg:${egg.color}` : '' }, info?.symbol ? `${info.symbol} ` : '', egg.name),
        el('div', { class: 'card-sub', text: info?.theme || 'Egg SMP egg' })));

    const facts = el('div', { class: 'egg-facts' });
    if (live) {
      const tier = live.tier >= 2 ? 2 : 1;
      const energy = Math.max(0, Math.min(5, live.energy ?? 0));
      facts.append(
        el('div', { class: 'egg-fact' }, el('span', { class: 'egg-fact-label', text: 'Level' }), el('strong', { text: tier === 2 ? 'II' : 'I' })),
        el('div', { class: 'egg-fact', title: `${energy} of 5 energy. Dying costs 1; at 0 the egg is Cracked.` },
          el('span', { class: 'egg-fact-label', text: 'Energy' }),
          el('span', { class: 'egg-pips', role: 'img', 'aria-label': `${energy} of 5` },
            ...Array.from({ length: 5 }, (_, i) => el('i', { class: i < energy ? 'on' : '' }))),
          ...(energy === 0 ? [el('span', { class: 'egg-cracked', text: 'Cracked' })] : [])));
    }
    head.append(facts);

    const body = [head];
    if (!info) {
      body.push(el('div', { class: 'muted egg-none', text: 'This egg isn’t in the egg datapack yet, so its abilities aren’t listed.' }));
    } else {
      const locked = live && live.tier < 2;
      const row = (label, a, { second = false } = {}) => {
        if (a === undefined) return null;
        const off = second && locked && !a?.always;
        return el('div', { class: `egg-row${off ? ' locked' : ''}` },
          el('div', { class: 'egg-row-label' }, label, second && a && !a.always ? el('span', { class: 'egg-tag', text: off ? 'Locked · Level II' : 'Level II' }) : null),
          a
            ? el('div', { class: 'egg-row-text' }, ...(a.name ? [el('strong', { text: a.name }), ' '] : []), a.text,
              a.cost ? el('span', { class: 'egg-cost', text: a.cost }) : null)
            : el('div', { class: 'egg-row-text muted', text: 'None' }));
      };
      body.push(el('div', { class: 'egg-rows' },
        row('Passive', { text: info.passive }),
        row('Primary', info.primary),
        row('Secondary', info.secondary, { second: true })));
    }
    body.push(eggGameTip(egg, live));
    if (live && gear.ts) body.push(el('div', { class: 'egg-asof muted', text: `Level and energy as of ${ago(gear.ts)}` }));
    else if (!live) body.push(el('div', { class: 'egg-asof muted', text: 'Level and energy show once they’ve played with the server mod (1.4.0 or newer).' }));
    box.replaceChildren(...body);
  }

  (window.MCS_ADDONS ||= []).push({
    id: 'eggsmp',
    setup(api) { ({ el, icon, recall, remember, ago, rosterOf, BASE } = api); },
    // after the team on a player's page: "· Life Egg" in the egg's color
    playerTags(name, gear) {
      const egg = eggInfo(playerEggId(name, gear));
      return egg ? [el('span', { class: 'p-egg', style: egg.color ? `--egg:${egg.color}` : '', text: `· ${egg.name}` })] : [];
    },
    // a line under the 3D model
    modelLines(name, gear) {
      const egg = eggInfo(playerEggId(name, gear));
      return egg ? [el('div', { class: 'p-model-egg' }, el('span', { class: 'p-egg', style: egg.color ? `--egg:${egg.color}` : '', text: egg.name }))] : [];
    },
    // the model holds the egg in the off hand, inside its particles (dim smoke when it has no energy left)
    modelSpec(name, gear) {
      const id = playerEggId(name, gear);
      return { offhand: heldEgg(gear, id), aura: (id && (gear?.egg?.energy === 0 ? AURA_CRACKED : AURA[id])) || null };
    },
    playerCard,
    // Admin → Settings: which egg each player has (the roster's "egg")
    rosterColumn() {
      const ids = Object.keys(EGGS).sort((a, b) => EGGS[a][0].localeCompare(EGGS[b][0]));
      return { key: 'egg', title: 'Egg', plural: 'eggs', none: 'No egg', options: ids.map((id) => [id, EGGS[id][0]]), label: (id) => eggInfo(id).name };
    },
    // the sample data gives its made-up players eggs too
    sampleData: () => ({ eggIds: EGG_BY_ID }),
  });
})();
