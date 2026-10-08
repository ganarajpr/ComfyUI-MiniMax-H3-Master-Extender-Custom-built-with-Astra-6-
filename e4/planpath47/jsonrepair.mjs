// E4.3: a reply that is one JSON object with a local syntax slip (a stray closing bracket, a value written twice, a missing or trailing comma, a missing closer at the end)
// is repaired by code instead of being sent back to the model. Each fix is local, driven by the parser's own error position, and the repaired text must parse; nothing else about the
// content changes. The model is asked again only when no sequence of these fixes parses.
const MAX_FIXES = 40;

function closersNeeded(s) {
  const stack = [];
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if ((c === '}' || c === ']') && stack[stack.length - 1] === c) stack.pop();
  }
  return { open: inStr, closers: stack.reverse().join('') };
}

// index of the first comma that is followed (outside strings) by a closing bracket, else -1
function trailingComma(s) {
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === ',' && /^,\s*[}\]]/.test(s.slice(i, i + 40))) return i;
  }
  return -1;
}

export function repairJson(text) {
  let s = String(text || '').trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  const start = s.indexOf('{');
  if (start < 0) return { ok: false, error: 'no object', fixes: [] };
  s = s.slice(start);
  const fixes = [];
  for (let n = 0; n < MAX_FIXES; n++) {
    try { return { ok: true, value: JSON.parse(s), fixes }; } catch (err) {
      const msg = String(err.message);
      const m = /position (\d+)/.exec(msg);
      if (/^Unexpected token '[}\]]'/.test(msg) && trailingComma(s) >= 0) { const i = trailingComma(s); s = s.slice(0, i) + s.slice(i + 1); fixes.push('drop_trailing_comma'); continue; }
      if (/Unexpected end of JSON input/.test(msg) || (!m && /Unterminated/.test(msg)) || (m && Number(m[1]) >= s.length)) {
        const { open, closers } = closersNeeded(s);
        if (!closers && !open) return { ok: false, error: msg, fixes };
        s = `${s}${open ? '"' : ''}${closers}`; fixes.push('close_open_brackets'); continue;
      }
      if (!m) return { ok: false, error: msg, fixes };
      const p = Number(m[1]);
      const c = s[p];
      if (/Unexpected non-whitespace character after JSON/.test(msg)) { s = s.slice(0, p); fixes.push('drop_trailing_text'); continue; }
      if (/Expected ',' or/.test(msg)) {
        if (c === ':') {
          const rest = s.slice(p).match(/^:\s*(?:"(?:[^"\\]|\\.)*"|[^,}\]\s]+)/);
          if (!rest) return { ok: false, error: msg, fixes };
          s = s.slice(0, p) + s.slice(p + rest[0].length); fixes.push('drop_repeated_value'); continue;
        }
        if (c === '}' || c === ']') { s = s.slice(0, p) + s.slice(p + 1); fixes.push('drop_stray_closer'); continue; }
        if (c === '"' || c === '{' || c === '[' || /[0-9tfn-]/.test(c || '')) { s = `${s.slice(0, p)},${s.slice(p)}`; fixes.push('insert_comma'); continue; }
      }
      if (/Expected double-quoted property name/.test(msg) && (c === '{' || c === '[')) {
        const q = s.slice(0, p).search(/,\s*$/);
        if (q >= 0) { s = `${s.slice(0, q)}}${s.slice(q)}`; fixes.push('close_unclosed_object'); continue; }
      }
      if ((c === '}' || c === ']') && /,\s*$/.test(s.slice(0, p))) { s = s.slice(0, p).replace(/,\s*$/, '') + s.slice(p); fixes.push('drop_trailing_comma'); continue; }
      return { ok: false, error: msg, fixes };
    }
  }
  return { ok: false, error: 'too many fixes', fixes };
}
