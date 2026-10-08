// Closed vocabularies shared by derive/render/lint. Everything here is generic
// film grammar or a copy of what the production audit enforces; nothing is
// specific to one story. test/lexicon.test.mjs checks the audit-derived lists
// against ~/.kshana/runners/dhee-runner-h3-audit when it is installed.

export const SPEECH_VERBS = [
  'say', 'says', 'speak', 'speaks', 'spoke', 'answer', 'answers', 'ask', 'asks',
  'reply', 'replies', 'tell', 'tells', 'explain', 'explains',
  'mention', 'mentions', 'mentioning', 'respond', 'responds', 'utter',
  'emphasise', 'emphasizes', 'affirms', 'assures', 'declares', 'announces',
  'invites', 'urges', 'promises', 'reminds', 'voiceover',
  'call to action', 'offering no answer', 'offers no answer',
  'add', 'adds', 'question', 'questions', 'deliver', 'delivers',
  'introduces', 'initiates', 'concludes',
];

// Extra speech-shaped words the template itself says to avoid outside a <d> tag.
export const SPEECH_SHAPED_EXTRA = [
  'speaking', 'spoken', 'talks', 'talking', 'utterance', 'replying', 'answering', 'asking', 'telling', 'saying',
  'expected an answer', 'expects an answer',
];

export const SOUNDSCAPE_BANNED = [
  'voice', 'whisper', 'whispers', 'whispered', 'murmur', 'murmurs',
  'murmured', 'shout', 'shouts', 'word', 'words',
];

// Words that make a fragment "about a vocal source". Used to decide whether a
// spec fragment may appear in a shot that has no ledger line (a vocal mention
// with no <d> beside it invites voice-shaped noise from the renderer).
export const VOCAL_TERMS = [
  'whisper', 'whispers', 'whispered', 'whispering', 'murmur', 'narrate', 'narrates',
  'narrated', 'narrating', 'narration', 'speaks', 'speaking', 'recited', 'reads the', 'reads that', 'announces',
  'utters', 'sings', 'chants',
];

// Soundscape substitutions (banned vocal word -> the nearest non-banned word that keeps
// the source: speech stays speech, a hush stays a hush).
export const SOUNDSCAPE_SUBS = [
  [/\bnear[- ]silence\b/gi, 'only a faint room tone'], [/\bsilence\b/gi, 'a faint room tone'],
  [/\bvoices\b/gi, 'speech'], [/\bvoice\b/gi, 'speech'],
  [/\bwhispers\b/gi, 'hushed speech'], [/\bwhispered\b/gi, 'hushed'], [/\bwhisper\b/gi, 'hushed speech'],
  [/\bmurmurs\b/gi, 'hums'], [/\bmurmured\b/gi, 'hummed'], [/\bmurmur\b/gi, 'hum'],
  [/\bshouts\b/gi, 'cries'], [/\bshout\b/gi, 'cry'],
  [/\bwords\b/gi, 'phrases'], [/\bword\b/gi, 'phrase'],
];

export const CAMERA_VOCABULARY = [
  'zoom in', 'zoom out', 'push in', 'pull out', 'pan left', 'pan right',
  'truck left', 'truck right', 'tilt up', 'tilt down', 'pedestal up', 'pedestal down',
  'arc shot', 'tracking shot', 'static shot', 'shake slightly', 'shake strongly',
  'pov', 'roll clockwise', 'roll counterclockwise',
];

// H3 grid: frames = 17k + 5 at 24 fps, max 19.333 s.
export const DURATION_GRID = [
  5.167, 5.875, 6.583, 7.292, 8.0, 8.708, 9.417, 10.125, 10.833, 11.542,
  12.25, 12.958, 13.667, 14.375, 15.083, 15.792, 16.5, 17.208, 17.917, 18.625, 19.333,
];

// Sound-bearing nouns, used to pull sound clauses out of any spec field.
export const SOUND_NOUNS = [
  'hum', 'hiss', 'static', 'tick', 'ticking', 'ticks', 'drone', 'breathing', 'breath', 'click', 'clicks', 'buzz',
  'rumble', 'creak', 'crackle', 'rustle', 'thud', 'clang', 'whir', 'whine', 'beep', 'chime', 'rattle',
  'patter', 'footsteps', 'swell', 'swells', 'rushing', 'ringing', 'throb',
];

// Craft-narration cut points: everything from here on in a spec clause is the
// director explaining the shot, not describing something a camera can see.
export const CRAFT_CUTS = [
  /,?\s*~?\d+:\d+(?:\s*[–-]\s*\d+:\d+)?(?:\s+of the shot)?/gi,
  /\s+[—–]\s+.*$/s,
  /,?\s+so (?:the|that|every|each|his|her|their|it|he|she|they|we|you)\b.*$/is,
  /\s+so\s+(?!far\b|much\b|many\b|long\b)\w+.*$/is,
  /,?\s+which (?:means|makes|lets|gives|reads|suggests|shows)\b.*$/is,
  /,?\s+(?:meaning|making|so as to|in order to)\b.*$/is,
  /,?\s+as if\b.*$/is,
  /,?\s+(?:marking|marks|marked by)\b.*$/is,
  /,?\s+as the (?:objective|subjective)\b.*$/is,
  /,?\s+(?:that|which) (?:later|will|would)\b.*$/is,
];

// Negation / absence vocabulary the renderer must never emit about content.
export const NEGATION_PATTERNS = [
  /\b(?:no|not|never|none|nothing|nobody|nowhere|neither|nor|without|cannot|nonexistent)\b/i,
  /\b\w+n['’]t\b/i,
  /\bno longer\b/i,
  /\brather than\b/i,
  /\binstead of\b/i,
  /\b(?:absent|absence|devoid|lacking|lacks|barely|hardly|rarely|seldom|scarcely|unseen|invisible|missing|vanish(?:es|ed)?|silence|silent|silently|soundless|mute|muted|gone)\b/i,
  /\boutside the frame\b/i,
  /\boff-?screen\b/i,
  /\bjust (?:outside|beyond) the frame\b/i,
];

// Director-note / craft-narration language (the spec's own explanatory register).
export const NARRATION_PATTERNS = [
  /\bthe audience\b/i, /\bthe viewer\b/i, /\bwe (?:see|feel|sense|understand)\b/i,
  /\breads? as\b/i, /\bstate change\b/i, /\bmicro ?action\b/i, /\bwhy this angle\b/i,
  /\bcontrast level\b/i, /\bfunction of\b/i, /\bthe shot (?:is|serves|exists|establishes)\b/i,
  /\bso (?:that )?(?:every|each|the|we|he|she)\b[^.]*\b(?:reads?|feels?|lands?)\b/i,
  /\bthis (?:beat|moment) (?:is|serves)\b/i, /\bquiet but exact\b/i, /\bthe point of\b/i,
  /\bsymboli[sz]\w*/i, /\bmetaphor\w*/i, /\bthe dread\b/i, /\bthe trap\b/i, /\bfeel(?:s|ing|t)?\b/i, /\bgiving way to\b/i, /\bthe shift to\b/i, /\bread out of order\b/i, /\bobjective fact\b/i, /\bsubjective\b/i,
];

export const MUSIC_VOCAB = [
  'music', 'musical', 'score', 'melody', 'harmony', 'chord', 'rhythm', 'rhythmic', 'beat', 'beats', 'bpm', 'tempo',
  'soundtrack', 'song', 'tune', 'cadence',
];
