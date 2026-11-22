// A faster drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build
// returns for the same input: every page's index.html, the index and tag
// pages, build-report.txt and each static file, byte for byte. It is a
// from-scratch re-implementation of the dialect in the vendor README
// (front matter, template dialect, Markdown subset, slug rule, report),
// written to spend as little CPU as possible: one pass over each body
// with no token array, batched HTML escaping, per-case memoised slugs,
// and a template interpreter that walks already-split paths.

/** Code-unit order (never the locale's). */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ------------------------------------------------------------------ text

const EMAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_ALL = /[&<>"']/g;

/** `s` with & < > " and ' escaped. Returns `s` itself when nothing needs it. */
function esc(s) {
  if (!ESC_TEST.test(s)) return s;
  return s.replace(ESC_ALL, (c) => EMAP[c]);
}

/** The slug of `text`, memoised in `cache` (fresh per run call). */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  while (out.endsWith('-')) out = out.slice(0, -1);
  const slug = out === '' ? 'untitled' : out;
  cache.set(text, slug);
  return slug;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // Exactly JavaScript's \s: TAB LF VT FF CR SPACE, NBSP, Ogham space mark,
    // U+2000-U+200A, line/paragraph separators, narrow NBSP, medium math space,
    // ideographic space, zero-width NBSP.
    const ws = c === 32 || (c >= 9 && c <= 13) || c === 0xA0 || c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200A) || c === 0x2028 || c === 0x2029 || c === 0x202F ||
      c === 0x205F || c === 0x3000 || c === 0xFEFF;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ------------------------------------------------------------------ front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(key, raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: `key "${key}": a quoted string is not closed` };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: `key "${key}": a quoted string holds an escape other than \\" or \\\\'` };
        out += n;
        i++;
      } else if (c === '"') return { error: `key "${key}": a quoted string holds a stray quote` };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: `key "${key}": a bare string opens on [` };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  if (key === 'title' || key === 'summary') return stringOf(key, raw);
  if (key === 'date') {
    let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
    if (ok) {
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) { ok = false; break; }
      }
    }
    const y = ok ? Number(raw.slice(0, 4)) : 0;
    const mo = ok ? Number(raw.slice(5, 7)) : 0;
    const d = ok ? Number(raw.slice(8, 10)) : 0;
    if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
      return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    return { value: raw };
  }
  if (key === 'tags') {
    if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',');
    for (let i = 0; i < tags.length; i++) {
      tags[i] = tags[i].trim();
      const t = tags[i];
      if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      for (let j = 0; j < t.length; j++) {
        const c = t[j];
        if (c === '"' || c === '[' || c === ']') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
    }
    return { value: tags };
  }
  if (key === 'draft') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      const ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45;
      if (!ok) return { error: 'key "layout": not a template name' };
    }
    return raw.length > 0 ? { value: raw } : { error: 'key "layout": not a template name' };
  }
  if (key === 'slug') {
    let ok = raw.length > 0 && raw.length <= 64;
    if (ok) {
      // [a-z0-9]+ (-[a-z0-9]+)*
      let i = 0;
      const seg = () => {
        if (i >= raw.length) return false;
        let n = 0;
        while (i < raw.length) {
          const c = raw.charCodeAt(i);
          if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) { i++; n++; } else break;
        }
        return n > 0;
      };
      if (!seg()) ok = false;
      while (ok && i < raw.length) {
        if (raw[i] !== '-') { ok = false; break; }
        i++;
        if (!seg()) ok = false;
      }
    }
    return ok ? { value: raw } : { error: 'key "slug": not a slug' };
  }
  return { error: `unknown key "${key}"` };
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlankLine(line) || line[0] === '#') continue;
    let j = 0;
    while (j < line.length) {
      const c = line.charCodeAt(j);
      if ((c >= 97 && c <= 122) || c === 95) j++;
      else break;
    }
    if (j === 0 || line[j] !== ':') return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, j);
    let raw;
    if (j + 1 === line.length) raw = '';
    else if (line[j + 1] === ' ') {
      raw = line.slice(j + 2);
      let e = raw.length;
      while (e > 0 && (raw[e - 1] === ' ' || raw[e - 1] === '\t')) e--;
      raw = raw.slice(0, e);
    } else return { error: `line ${i + 1} is not "key: value"` };
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ------------------------------------------------------------------ markdown

/** The characters a backslash escapes. */
const ESC = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function trimLine(line) {
  let s = 0;
  let e = line.length;
  while (s < e && (line[s] === ' ' || line[s] === '\t')) s++;
  while (e > s && (line[e - 1] === ' ' || line[e - 1] === '\t')) e--;
  return line.slice(s, e);
}

/** A fence opener's language, or null when the line is not one. */
function fenceOpen(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i === line.length ? lang : null;
}

/** Whether the line closes a fence: ``` then spaces or tabs only. */
function fenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let i = 3; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line[h] === '#') h++;
  if (h === 0 || h > 6) return null;
  if (line[h] !== ' ' && line[h] !== '\t') return null;
  let s = h;
  while (s < line.length && (line[s] === ' ' || line[s] === '\t')) s++;
  let e = line.length;
  while (e > s && (line[e - 1] === ' ' || line[e - 1] === '\t')) e--;
  if (e === s) return null;
  return { depth: h, text: line.slice(s, e) };
}

/** Whether the line is a thematic break: --- or *** then spaces or tabs. */
function isHR(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

/** A bullet item's text, or null when the line is not one. */
function bulletOf(line) {
  if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') return line.slice(2);
  return null;
}

/** An ordered item's number and text, or null when the line is not one. */
function orderedOf(line) {
  let j = 0;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c >= 48 && c <= 57) j++;
    else break;
  }
  if (j < 1 || j > 9) return null;
  if (line[j] !== '.' || line[j + 1] !== ' ') return null;
  return { num: Number(line.slice(0, j)), rest: line.slice(j + 2) };
}

/** Whether the line continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let j = 0;
  while (line[j] === ' ') j++;
  return j >= 2 && j < line.length && !/\s/.test(line[j]);
}

/** Whether `line` ends a paragraph: blank, fence, heading or break. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c = line[0];
  if (c === ' ' || c === '\t') return isBlankLine(line);
  if (c === '`') return fenceOpen(line) !== null;
  if (c === '#') return headingOf(line) !== null;
  if (c === '-' || c === '*') return isHR(line);
  return false;
}

/** The next inline-special character (\ ` * [) at or after `from`, or -1. */
const SPECIAL = /[\\`*\[]/g;
function nextSpecial(s, from) {
  SPECIAL.lastIndex = from;
  const m = SPECIAL.exec(s);
  return m === null ? -1 : m.index;
}

/** The first index from `from` where `s` holds `what` outside an escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESC.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESC.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  let out = '';
  let i = 0;
  let start = 0;
  while (true) {
    const j = nextSpecial(s, i);
    if (j === -1) break;
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < s.length && ESC.has(s[j + 1])) {
        if (j > start) out += esc(s.slice(start, j));
        out += esc(s[j + 1]);
        i = j + 2;
        start = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > start) out += esc(s.slice(start, j));
        out += `<code>${esc(s.slice(j + 1, k))}</code>`;
        i = k + 1;
        start = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > start) out += esc(s.slice(start, j));
          out += `<strong>${inline(s.slice(j + 2, k), env)}</strong>`;
          i = k + 2;
          start = i;
        } else {
          i = j + 2;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (j > start) out += esc(s.slice(start, j));
        out += `<em>${inline(s.slice(j + 1, k), env)}</em>`;
        i = k + 1;
        start = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', j + 1);
    const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !/\s/.test(target)) {
      if (j > start) out += esc(s.slice(start, j));
      out += `<a href="${esc(env.link(target))}">${inline(s.slice(j + 1, k), env)}</a>`;
      i = m + 1;
      start = i;
      continue;
    }
    i = j + 1;
  }
  if (s.length > start) out += esc(s.slice(start));
  return out;
}

/**
 * `src` rendered in one pass: its HTML, its table of contents (every level 2
 * and 3 heading) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env, slugCache) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line.length === 0) {
      i++;
      continue;
    }
    const c0 = line[0];
    if (c0 === ' ' || c0 === '\t') {
      if (isBlankLine(line)) {
        i++;
        continue;
      }
    } else if (c0 === '`') {
      const lang = fenceOpen(line);
      if (lang !== null) {
        let b = `<pre><code${lang === '' ? '' : ` class="language-${esc(lang)}"`}>`;
        i++;
        while (i < n && !fenceClose(lines[i])) b += `${esc(lines[i++])}\n`;
        i++;
        blocks.push(`${b}</code></pre>`);
        continue;
      }
    } else if (c0 === '#') {
      const hd = headingOf(line);
      if (hd !== null) {
        const id = uniqueSlug(slugify(hd.text, slugCache), ids);
        const html = inline(hd.text, env);
        blocks.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>`);
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === '-' || c0 === '*') {
      if (isHR(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
      const bl = bulletOf(line);
      if (bl !== null) {
        const items = [];
        while (i < n) {
          const cur = lines[i];
          const m = bulletOf(cur);
          if (m !== null) {
            items.push([trimLine(m)]);
            i++;
            continue;
          }
          if (isContinued(cur)) {
            items[items.length - 1].push(trimLine(cur));
            i++;
            continue;
          }
          break;
        }
        let b = '<ul>\n';
        for (const parts of items) b += `<li>${inline(parts.join('\n'), env)}</li>\n`;
        blocks.push(`${b}</ul>`);
        continue;
      }
    } else if (c0 === '>') {
      const kept = [];
      while (i < n && lines[i][0] === '>') {
        let l = lines[i++].slice(1);
        if (l[0] === ' ') l = l.slice(1);
        l = trimLine(l);
        if (l !== '') kept.push(l);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    } else if (c0 >= '0' && c0 <= '9') {
      const ol = orderedOf(line);
      if (ol !== null) {
        const items = [];
        while (i < n) {
          const cur = lines[i];
          const m = orderedOf(cur);
          if (m !== null) {
            items.push([trimLine(m.rest)]);
            i++;
            continue;
          }
          if (isContinued(cur)) {
            items[items.length - 1].push(trimLine(cur));
            i++;
            continue;
          }
          break;
        }
        let b = `${ol.num !== 1 ? `<ol start="${ol.num}">` : '<ol>'}\n`;
        for (const parts of items) b += `<li>${inline(parts.join('\n'), env)}</li>\n`;
        blocks.push(`${b}</ol>`);
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (const b of blocks) html += `${b}\n`;
  return { html, toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------------ templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

function isNameStart(c) {
  return c !== undefined && ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_');
}
function isNameChar(c) {
  return c !== undefined && ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_');
}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  const parts = text.split('.');
  for (const p of parts) {
    if (p.length === 0 || !isNameStart(p[0])) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
    for (let i = 1; i < p.length; i++) {
      if (!isNameChar(p[i])) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
    }
  }
  return parts;
}

function isSpacesOnly(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ' ' && s[i] !== '\t') return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isSpacesOnly(src.slice(lineStart, open)) && isSpacesOnly(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** A `for x in path` tag, or null. */
function forOf(name, tag) {
  if (!tag.startsWith('for ')) return null;
  let j = 4;
  if (!isNameStart(tag[j])) return null;
  while (j < tag.length && isNameChar(tag[j])) j++;
  const varName = tag.slice(4, j);
  if (tag.slice(j, j + 4) !== ' in ') return null;
  const p = tag.slice(j + 4);
  if (p === '' || /\s/.test(p)) return null;
  return { varName, path: pathOf(name, p) };
}

/** An `if [not] path` tag, or null. */
function ifOf(name, tag) {
  if (!tag.startsWith('if ')) return null;
  let rest = tag.slice(3);
  let not = false;
  if (rest.startsWith('not ')) {
    not = true;
    rest = rest.slice(4);
  }
  if (rest === '' || /\s/.test(rest)) return null;
  return { not, path: pathOf(name, rest) };
}

/** An `include "name"` tag's name, or null. */
function includeOf(tag) {
  if (!tag.startsWith('include "') || !tag.endsWith('"') || tag.length < 12) return null;
  const inner = tag.slice(9, -1);
  if (inner.length === 0) return null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return null;
  }
  return inner;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = forOf(name, tag)) !== null) {
        const node = { kind: 'for', name: m.varName, path: m.path, body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = ifOf(name, tag)) !== null) {
        const node = { kind: 'if', not: m.not, path: m.path, then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = includeOf(tag)) !== null) body.push({ kind: 'include', name: m });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: first name from the nearest scope holding it. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: string itself, a number in JavaScript's digits, true/false, an array joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope` ({ vars, parent }); `ctx` holds the parsed templates and the escape. */
function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (const n of nodes) {
    if (n.kind === 'text') out += n.text;
    else if (n.kind === 'var') out += esc(textOf(lookup(scope, n.path)));
    else if (n.kind === 'raw') out += textOf(lookup(scope, n.path));
    else if (n.kind === 'if') {
      const branch = truthy(lookup(scope, n.path)) !== n.not ? n.then : n.else;
      if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
    } else if (n.kind === 'for') {
      const xs = lookup(scope, n.path);
      if (Array.isArray(xs)) {
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          out += renderNodes(n.body, { vars, parent: scope }, ctx, depth);
        }
      }
    } else if (n.kind === 'include') {
      const t = ctx.templates.get(n.name);
      if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, ctx, depth + 1);
    }
  }
  return out;
}

// ------------------------------------------------------------------ the build

/** Whether `target` carries a scheme (https:, mailto: ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(cmp)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const broken = new Set();
  const output = {};

  // 1. Sources, in code-unit order of their paths; .md is a source, the rest static.
  const files = [...input.files].sort((x, y) => cmp(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter, in source order; refused sources and drafts are reported and dropped.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. Permalinks: each slug unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), takenIn(dir));
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, each body's links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.reading = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }

  // 5. Collections: posts newest first, then by slug; each post's neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name, slugCache)) ?? { name, slug: slugify(name, slugCache), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // 7. Layouts: every page through its layout, the index and tag pages through theirs.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.reading,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const card = (s) => cards.get(s) ?? cardOf(s);
  const pageOf = (s) => ({
    ...card(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    return nodes === undefined ? null : renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0);
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every line reported above and each broken link, sorted, then the counts.
  const lines = [...report, ...broken].sort(cmp);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
