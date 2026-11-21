-- Death lines stored as a bare translation key ("death.attack.generic.item": the server had no English
-- wording for them) get the wording new ones now get on arrival (src/chat.js wordDeath):
-- "<victim> was killed [by <killer>] [using [<weapon>]]".
UPDATE chat SET
  text = name || ' was killed'
    || COALESCE(' by ' || (SELECT killer FROM deaths WHERE deaths.id = chat.id), '')
    || COALESCE(' using [' || (SELECT weapon FROM deaths WHERE deaths.id = chat.id) || ']', ''),
  rich = json_array(
    json_object('t', name, 'p', name),
    json_object('t', ' was killed'
      || COALESCE(' by ' || (SELECT killer FROM deaths WHERE deaths.id = chat.id), '')
      || COALESCE(' using [' || (SELECT weapon FROM deaths WHERE deaths.id = chat.id) || ']', '')))
WHERE kind = 'death' AND name IS NOT NULL AND text GLOB 'death.*' AND instr(text, ' ') = 0;
