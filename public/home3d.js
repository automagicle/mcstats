// The landing page's 3D: a player with armor and held items (the profile example).
//
// The players are the dashboard's own model (public/player3d.js) in the game's real textures: default
// skins, armor, trims and items, served at /api/mc/ even outside a server (src/mcassets.js, serveHomeAsset).
// What each one wears and carries is written out in public/home.js. Loaded on demand by it.
import { buildModel, mountPlayer as mountModel } from '/player3d.js';

// Builds a model and throws it away: its skin and textures are then in player3d.js's image cache, so the
// real one is built without waiting on the network. spec is player3d's: { name, skin, armor, mainhand, offhand }.
export function warm(spec) {
  const made = [];
  return buildModel(spec, (x) => (made.push(x), x))
    .then(() => made.forEach((x) => x.dispose?.()), () => {});
}

// mountPlayer(container) -> { show(spec, turn), turnIn(from), setMainhand(item), dispose() }: the player page's own model,
// swapped for another player's on show(). setMainhand puts another item in their hand, as picking one
// from the list under the model does on a player's page.
export function mountPlayer(container) {
  let current = null, token = 0;
  let held = null; // what their hand should hold: an item picked while the model was still being built is kept
  return {
    // turn: when given, they appear turned that far away (radians) and come round to face the front
    async show(spec, turn = 0) {
      const mine = ++token;
      held = spec.mainhand;
      const next = await mountModel(container, spec);
      if (mine !== token) { next.dispose(); return; }
      current?.dispose(); // the new one is already drawn on top, so there's no gap
      current = next;
      if (held !== spec.mainhand) next.setMainhand(held);
      if (turn) next.turnIn(turn);
    },
    turnIn(from) { current?.turnIn(from); },
    setMainhand(item) {
      held = item;
      return current?.setMainhand(item);
    },
    dispose() { token++; current?.dispose(); current = null; },
  };
}
