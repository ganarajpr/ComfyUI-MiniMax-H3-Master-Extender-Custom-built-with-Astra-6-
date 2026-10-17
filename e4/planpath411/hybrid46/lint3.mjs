#!/usr/bin/env node
// Negation / narration / music / label lint (hybrid3: camera and marker rules moved to cuts.mjs, which follows the production cut rules) over shot_prose envelopes.
//
//   node hybrid3/lint3.mjs <dir> [--verbose]
//
// Works on templater envelopes and on LLM candidate envelopes alike (both carry
// the model's JSON in `content`). Dialogue inside <d>...</d> is exempt: the
// ledger's words are not ours to police.
//
// Rules (each hit is one finding):
//   negation    no/not/never/none/nothing/without/n't/rather than/absent/...
//   narration   director-note language: "the audience", "reads as", "state change"...
//   music       music / beat / rhythm / tempo / score vocabulary anywhere
//   label       `Label: value` sentences ("Points of contact: ...", "His posture: ...")
//   sentinel    nonDiegeticMusic must be exactly N/A

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFSCREEN_MARKER_CONTEXT } from './negation.mjs';
import { NEGATION_PATTERNS, NARRATION_PATTERNS, MUSIC_VOCAB, CAMERA_VOCABULARY } from '../../templater/lexicon.mjs';

const stripDialogue = (t) => String(t || '').replace(/<d>[\s\S]*?<\/d>/g, ' ');
const stripTokens = (t) => String(t || '').replace(/\[Shot \d+\]/g, ' ').replace(/\bsays:\s*/g, ' ');
const LABEL_RE = /(?:^|[.!?]\s+)(?:<Subject \d+>\s*)?[A-Z][\w ,'’-]{0,36}:\s/g;
const musicRe = new RegExp(`\\b(?:${MUSIC_VOCAB.join('|')})\\b`, 'gi');
const globalize = (re) => new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);

const CAMERA_RES = CAMERA_VOCABULARY.map((term) => [term, new RegExp(`\\b${term.replace(' ', '[- ]')}\\b`, 'i')]);

export function cameraTerms(text) {
  return CAMERA_RES.filter(([, re]) => re.test(text)).map(([t]) => t);
}

const sentenceAround = (text, i) => { const a = text.slice(0, i).search(/[.!?]\s+(?=[^.!?]*$)/); const rest = text.slice(i).search(/[.!?]\s/); return text.slice(a < 0 ? 0 : a + 1, rest < 0 ? text.length : i + rest); };

export function lintShot(shot) {
  const findings = [];
  const fields = {
    detailedDescription: stripTokens(stripDialogue(shot.detailedDescription)),
    overallSoundscape: stripDialogue(shot.overallSoundscape),
    summary: stripDialogue(shot.summary),
  };
  for (const [field, text] of Object.entries(fields)) {
    for (const re of NEGATION_PATTERNS) {
      for (const m of text.matchAll(globalize(re))) {
        if (/^off-?screen$/i.test(m[0]) && OFFSCREEN_MARKER_CONTEXT.test(sentenceAround(text, m.index))) continue;
        findings.push({ rule: 'negation', field, match: m[0] });
      }
    }
    for (const re of NARRATION_PATTERNS) {
      for (const m of text.matchAll(globalize(re))) findings.push({ rule: 'narration', field, match: m[0] });
    }
    for (const m of text.matchAll(musicRe)) findings.push({ rule: 'music', field, match: m[0] });
    for (const m of text.matchAll(LABEL_RE)) findings.push({ rule: 'label', field, match: m[0].trim() });
  }
  if (String(shot.nonDiegeticMusic).trim() !== 'N/A') findings.push({ rule: 'sentinel', field: 'nonDiegeticMusic', match: String(shot.nonDiegeticMusic) });
  return findings;
}

export function parseEnvelopeShot(rec) {
  let t = String(rec.content || '').trim();
  if (t.startsWith('```')) t = t.replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/, '').trim();
  const i = t.indexOf('{');
  if (i > 0) t = t.slice(i);
  const j = JSON.parse(t);
  const arr = j.shots || [j];
  return arr.find((x) => x.id === rec.shotId) || arr[0];
}

export function lintDir(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f.includes('__')).sort();
  const perShot = [];
  for (const f of files) {
    const rec = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    let shot;
    try { shot = parseEnvelopeShot(rec); } catch { perShot.push({ file: f, parseError: true, findings: [] }); continue; }
    if (!shot) { perShot.push({ file: f, parseError: true, findings: [] }); continue; }
    perShot.push({ file: f, shotId: rec.shotId, findings: lintShot(shot) });
  }
  return perShot;
}

export function summarize(perShot) {
  const byRule = {};
  let total = 0;
  for (const s of perShot) for (const f of s.findings) { byRule[f.rule] = (byRule[f.rule] || 0) + 1; total += 1; }
  return { shots: perShot.length, shotsWithFindings: perShot.filter((s) => s.findings.length).length, total, byRule };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node hybrid3/lint3.mjs <dir> [--verbose]'); process.exit(2); }
  const verbose = process.argv.includes('--verbose');
  const perShot = lintDir(dir);
  const sum = summarize(perShot);
  for (const s of perShot) {
    if (verbose || s.findings.length) {
      console.log(`${s.file}: ${s.parseError ? 'PARSE ERROR' : s.findings.length + ' finding(s)'}`);
      if (verbose) for (const f of s.findings) console.log(`   ${f.rule.padEnd(9)} ${f.field.padEnd(20)} "${f.match}"`);
    }
  }
  console.log(`\n${dir}\n  shots=${sum.shots} withFindings=${sum.shotsWithFindings} totalFindings=${sum.total}`);
  console.log('  by rule:', JSON.stringify(sum.byRule));
  process.exit(sum.total ? 1 : 0);
}
