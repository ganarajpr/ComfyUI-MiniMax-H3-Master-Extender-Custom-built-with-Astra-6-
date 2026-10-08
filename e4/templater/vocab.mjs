// Acting-master -> closed list of physical-vocabulary entries. Every entry is a
// clause lifted from the character's own profile; nothing here is invented.
// The only authored knowledge is the generic anatomy keyword table below.

import { cleanFragments, tidy, wordCount, overlap } from './clean.mjs';

export const REGIONS = {
  hands: /\b(hands?|thumbs?|fingers?|fists?|palms?|wrists?|grips?|knuckles?|arms?|taps?|double-taps?)\b/i,
  eyes: /\b(eyes?|gaze|blinks?|pupils?|catchlights?|lids?|glances?|stares?|looks?)\b/i,
  jaw: /\b(jaw|throat|swallow\w*|neck|lips?|mouth|teeth|brow|face|cheeks?)\b/i,
  breath: /\b(breath\w*|ribs?|chest|lungs?|exhale\w*|inhale\w*|sighs?)\b/i,
  posture: /\b(shoulders?|posture|spine|gravity|stance|weight|foot|feet|steps?|torso|back|head|nods?|body)\b/i,
};
export const REGION_LABEL = {
  hands: ['His hands', 'His fingers'], eyes: ['His eyes', 'His gaze'], jaw: ['His throat and jaw', 'His face'],
  breath: ['His breath', 'His chest'], posture: ['His posture', 'His stance', 'His carriage'],
};

export function regionOf(text) {
  for (const [r, re] of Object.entries(REGIONS)) if (re.test(text)) return r;
  return null;
}

const splitList = (s) => String(s || '').split(/,\s+(?=[a-zA-Z])/).map((x) => x.trim()).filter(Boolean);

// A behaviour the profile ties to a condition (playback, "when the voice ...")
// is a crack, not a baseline: it may only render in a shot whose stateChange is real.
const CLOTHING_RE = /\b(?:jacket|coat|shirt|sweater|hat|boots?|shoes?|dress|scarf|gloves?|zipp\w+|collar)\b/i;
export const CONDITION_RE = /\b(?:playback|plays? back|when|whenever|once|under the voice|takes? over|crack\w*|breaks?|breaking)\b/i;

// The clause that states the condition: from the cue word to the next punctuation.
function condKey(text) {
  const i = String(text).search(CONDITION_RE);
  return String(text).slice(Math.max(0, i)).split(/[:,;.]/)[0];
}

function pushEntry(list, kind, text, extra = {}) {
  const t = tidy(String(text).replace(/\.$/, ''));
  if (wordCount(t) < 2 || wordCount(t) > 14 || /\b(?:before|until|after|while|as if|than)\b/i.test(t)) return;
  const region = regionOf(t);
  if (!region) return;
  if ((kind === 'baseline' || kind === 'eyes' || kind === 'profile') && CONDITION_RE.test(t)) { kind = 'crack'; extra = { condText: condKey(t), ...extra }; }
  if ((kind === 'profile' || kind === 'crack') && /^the\b/i.test(t)) return;
  if (CLOTHING_RE.test(t)) return;
  if (/\breads?\b/i.test(t)) return;
  if (list.some((e) => e.text.toLowerCase() === t.toLowerCase() || overlap(e.text, t) >= 0.7)) return;
  list.push({ id: `v${list.length + 1}`, kind, region, text: t, ...extra });
}

export function buildVocabulary(master, name = '') {
  const nameRe = name ? new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') : null;
  const entries = [];
  const clean = (s) => cleanFragments(s, { allowVocal: false, minWords: 2 });
  for (const s of splitList(master.physicalBaseline)) {
    for (const f of clean(s)) {
      const parts = f.split(/\s+with\s+/);
      for (const part of parts.length === 2 && parts.every((x) => wordCount(x) >= 2) ? parts : [f]) pushEntry(entries, CONDITION_RE.test(s) ? 'crack' : 'baseline', part, CONDITION_RE.test(s) ? { condText: condKey(s) } : {});
    }
  }
  for (const s of splitList(master.eyeLife)) for (const f of clean(s)) pushEntry(entries, CONDITION_RE.test(s) ? 'crack' : 'eyes', f, CONDITION_RE.test(s) ? { condText: condKey(s) } : {});
  // Body clauses from the free-text profile: split on punctuation, keep the
  // ones that name a body region and read as a standalone action.
  const sentences = String(master.masterProfile || '').split(/(?<=[.!?])\s+/);
  for (const sent of sentences) {
    const afterColon = sent.includes(':') ? sent.split(':').slice(1).join(':') : sent;
    let cond = sent.includes(':') && CONDITION_RE.test(sent.split(':')[0]);
    for (const c of afterColon.split(/,\s+|\s+—\s+|;\s+/)) {
      if (CONDITION_RE.test(c)) cond = true;
      const t = c.replace(/^(?:and|but|when|while|as|so)\s+/i, '').replace(/^(?:he|she|they)\s+/i, '').trim();
      const head = t.split(' ')[0] || '';
      if (/^(?:he|she|they)$/i.test(head) || (nameRe && nameRe.test(head))) continue;
      if (/^[A-Z]/.test(t) && !/^(?:His|Her|Their)\b/.test(t)) continue;
      if (/\b(?:when|while|whenever|if|because)\b/i.test(t)) continue;
      for (const f of clean(t)) pushEntry(entries, cond ? 'crack' : 'profile', f.replace(/^(?:a|an)\s+(?=\w+\s+(?:shoulder|blink))/i, ''), cond ? { condText: condKey(sent) } : {});
    }
  }
  const ticTexts = [];
  for (const t of master.signatureTics || []) {
    const fr = clean(t.tic)[0];
    if (fr) ticTexts.push({ fr, trigger: t.trigger || '' });
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].kind !== 'tic' && ticTexts.some((t) => overlap(entries[i].text, t.fr) >= 0.5 || overlap(t.fr, entries[i].text) >= 0.5)) entries.splice(i, 1);
  }
  entries.forEach((e, i) => { e.id = `v${i + 1}`; });
  for (const { fr, trigger } of ticTexts) {
    // a compound tic ("freezes mid-step ... and eyes going fixed upward") is two usable tells
    const parts = fr.split(/\s+and\s+/).filter((x) => wordCount(x) >= 2);
    for (const part of parts.length > 1 ? parts : [fr]) {
      const region = regionOf(part) || 'posture';
      entries.push({ id: `v${entries.length + 1}`, kind: 'tic', region, text: part, trigger });
    }
  }
  const mask = String(master.mask || '');
  const maskList = mask.includes(':') ? mask.split(':').slice(1).join(':') : mask;
  for (const s of splitList(maskList)) for (const f of clean(s)) pushEntry(entries, 'mask', f);
  return entries;
}

export function pronounsOf(master) {
  const t = JSON.stringify(master || {}).toLowerCase();
  const m = (t.match(/\b(he|his|him|himself)\b/g) || []).length;
  const f = (t.match(/\b(she|her|hers|herself)\b/g) || []).length;
  if (m > f) return { subj: 'he', obj: 'him', poss: 'his', Subj: 'He', Poss: 'His' };
  if (f > m) return { subj: 'she', obj: 'her', poss: 'her', Subj: 'She', Poss: 'Her' };
  return { subj: 'they', obj: 'them', poss: 'their', Subj: 'They', Poss: 'Their' };
}
