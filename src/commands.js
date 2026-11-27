// The mod's /mcstats commands, and which of them a server's admins have switched off (Admin → Mod and commands).
//
// Two settings, kept in the server's Tenant object:
//   COMMANDS_OFF   the ids switched off, separated by commas ('' when every command is on)
//   COMMANDS_FOLD  '0' when the In-game commands box on the Activity page starts open; anything else, closed
//
// The mod is told which are off when its web chat connection opens (the hello's commands_off) and again
// whenever the list changes ({ type: 'commands', off }): src/link.js. It takes those commands away in game
// (they stop working, and leave tab completion, /mcstats help and the menus). That needs mod 2.4.0; an older
// mod ignores the list and keeps every command.
//
// The ids are the mod's (McstatsCommands.java) and the page's (public/app.js MC_COMMANDS); keep the three in step.
// /mcstats help isn't here: it can't be switched off.
import { compareVersions } from './modupdate.js';

export const COMMAND_IDS = ['view', 'profile', 'stats', 'top', 'link', 'connect', 'disconnect', 'particle', 'reset'];
export const COMMANDS_MOD = '2.4.0'; // the first mod that takes switched-off commands away

// A list of ids (an array, or the setting's comma-separated text) as the setting keeps it; null if it isn't one.
export function cleanCommandsOff(v) {
  const list = Array.isArray(v) ? v : String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.some((id) => typeof id !== 'string' || !COMMAND_IDS.includes(id))) return null;
  return COMMAND_IDS.filter((id) => list.includes(id)).join(',');
}

export const commandsOff = (settings) => (cleanCommandsOff(settings?.COMMANDS_OFF) || '').split(',').filter(Boolean);

// What the pages are told: { off: [ids], fold }.
export const commandsOf = (settings) => ({ off: commandsOff(settings), fold: settings?.COMMANDS_FOLD !== '0' });

// Whether the server's mod is new enough to take commands away: null when its version isn't known yet.
export const commandsSupported = (version) => (version ? compareVersions(version, COMMANDS_MOD) >= 0 : null);
