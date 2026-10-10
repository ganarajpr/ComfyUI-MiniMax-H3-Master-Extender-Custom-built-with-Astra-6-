// Static, location-agnostic staging vocabulary. A landmark is derived by matching `re` against a LOCATION's own
// text (never a shot's). kind: point | area | linear. walkable: a character can stand ON it. level: floor level
// the feature sits at (-1 below the base floor, 0 base, +1 above). linear features carry the two sides they separate.
export const LANDMARK_VOCAB = [
  { id: 'steps', re: /\b(?:steps|stairs|staircase|stairway)\b/i, kind: 'point', walkable: true, level: 1, gloss: 'steps rising from the base floor' },
  { id: 'ladder', re: /\bladder\b/i, kind: 'point', walkable: true, level: 1, gloss: 'fixed ladder leading up and down' },
  { id: 'parapet', re: /\b(?:parapet|balustrade|railing)\b/i, kind: 'linear', walkable: false, level: 0, sides: ['floor', 'drop'], gloss: 'low wall at the edge; floor side is the walkable side, drop side is the open air beyond' },
  { id: 'daybed', re: /\b(?:daybed|sofa|couch)\b/i, kind: 'area', walkable: true, level: 0, gloss: 'furniture to sit or lie on' },
  { id: 'glass_wall', re: /\bglass\b/i, kind: 'linear', walkable: false, level: 0, sides: ['room', 'outside'], gloss: 'glass wall separating the room from outside' },
  { id: 'streetlight', re: /\b(?:streetlight|street light|street lamp|lamppost)\b/i, kind: 'point', walkable: false, level: 1, gloss: 'street lamp up at road level' },
  { id: 'tunnel_depth', re: /\b(?:tunnel|underpass)\b/i, kind: 'point', walkable: false, level: 0, gloss: 'the far, dark interior end of the tunnel' },
  { id: 'pot_line', re: /\b(?:pots?|burners?)\b/i, kind: 'linear', walkable: false, level: 0, sides: ['cook', 'aisle'], gloss: 'row of pots on burners; cook side is where the cooks work, aisle side is the open side' },
  { id: 'canvas_wall', re: /\b(?:canvas|tent)\b/i, kind: 'linear', walkable: false, level: 0, sides: ['tent', 'outside'], gloss: 'canvas tent wall separating tent interior from outside' },
  { id: 'instruments', re: /\b(?:instruments|consoles?|work surfaces?)\b/i, kind: 'area', walkable: false, level: 0, gloss: 'instruments and work surfaces around the room' },
  { id: 'doorway', re: /\b(?:doorway|door|entrance)\b/i, kind: 'point', walkable: true, level: 0, gloss: 'door / entrance' },
  { id: 'window', re: /\bwindows?\b/i, kind: 'linear', walkable: false, level: 0, sides: ['room', 'outside'], gloss: 'window separating the room from outside' },
  { id: 'table', re: /\b(?:table|counter|desk)\b/i, kind: 'area', walkable: false, level: 0, gloss: 'table / counter' },
];

// Props that have a pointing direction, by generic class (id or appearsAs).
export const DIRECTIONAL_PROP_RE = /\b(?:torch|flashlight|gun|pistol|revolver|rifle|camera|phone|smartphone|lantern|spotlight)\b/i;
