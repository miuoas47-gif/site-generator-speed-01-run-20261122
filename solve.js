// A fast drop-in for makefun-site 1.0.0.
//
// run(input) answers with the same output tree makefun-site 1.0.0's build
// returns for the same input, byte for byte: every page, the index and tag
// pages, build-report.txt and each static file. The dialect is makefun-site's
// own (front matter, template tags, Markdown subset, slug rule, report), so
// this module re-implements that dialect directly, tuned for speed: the
// Markdown lexer and renderer run in one fused pass, inline markup is scanned
// with indexOf instead of per-character regexes, templates are parsed once,
// includes are expanded away at parse time, and the parts of a layout that
// only depend on the case (site, tags, recent) are rendered once per case
// instead of once per page.
//
// No dependencies, no I/O, no clock, no randomness: the answer is a function
// of the input alone, exactly like the reference.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;
const WORD_RE = /\S+/g;
const MARK_RE = /\p{M}/gu;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Code-unit order (never the locale's). */
function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `text` with & < > " and ' escaped. */
function escText(text) {
  return text.replace(ESCAPE_RE, (c) => ESCAPES[c]);
}

/** The directory of a "/"-separated path, "" at the root. */
function dirOf(path) {
  const k = path.lastIndexOf('/');
  return k === -1 ? '' : path.slice(0, k);
}

/** Whether `s` holds only spaces and tabs (or is empty). */
function isBlank(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `s` with spaces and tabs trimmed from both ends. */
function trimST(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}

/** `s` with spaces and tabs trimmed from the end. */
function trimEndST(s) {
  let b = s.length;
  while (b > 0 && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(0, b);
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of other characters one "-", none at either end, at most 64 characters (a
 * "-" left at the cut dropped), "untitled" when nothing is left. Results are
 * cached in `cache` (fresh per case) because tag and heading texts repeat.
 */
function slugOf(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = '';
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === '') {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  out = end === out.length ? out : out.slice(0, end);
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlugOf(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDateOf(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  const m = text.match(WORD_RE);
  return m === null ? 0 : m.length;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isDigit(c) {
  return c >= 48 && c <= 57;
}

/** A quoted or bare string value, or why it is refused. */
function stringValue(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    let seg = 1;
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += raw.slice(seg, i) + n;
        i++;
        seg = i + 1;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      }
    }
    out += raw.slice(seg, raw.length - 1);
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = stringValue(raw);
    return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
  }
  if (key === 'date') {
    let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
    if (ok) {
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        if (!isDigit(raw.charCodeAt(i))) { ok = false; break; }
      }
    }
    const y = ok ? Number(raw.slice(0, 4)) : 0;
    const mo = ok ? Number(raw.slice(5, 7)) : 0;
    const d = ok ? Number(raw.slice(8, 10)) : 0;
    if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
      return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    return { value: raw };
  }
  if (key === 'tags') {
    if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
      return { error: 'key "tags": not a list [a, b]' };
    }
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',').map((t) => t.trim());
    for (const t of tags) {
      if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
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
    let ok = raw.length > 0;
    for (let i = 0; ok && i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) ok = false;
    }
    return ok ? { value: raw } : { error: 'key "layout": not a template name' };
  }
  // slug: a-z and 0-9, single "-" between, at most 64 characters.
  let ok = raw.length > 0 && raw.length <= 64;
  if (ok) {
    let i = 0;
    const alnum = (c) => (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
    while (ok && i < raw.length) {
      if (!alnum(raw.charCodeAt(i))) { ok = false; break; }
      i++;
      if (i < raw.length && raw.charCodeAt(i) === 45) {
        i++;
        if (i >= raw.length || !alnum(raw.charCodeAt(i))) ok = false;
      }
    }
  }
  return ok ? { value: raw } : { error: 'key "slug": not a slug' };
}

/** One front-matter line into `data`, or the reason it refuses the source. */
function fmLine(line, lineNo, data) {
  if (isBlank(line) || line.charCodeAt(0) === 35) return null;
  let k = 0;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if ((c >= 97 && c <= 122) || c === 95) k++;
    else break;
  }
  if (k === 0 || line.charCodeAt(k) !== 58) return `line ${lineNo + 1} is not "key: value"`;
  const key = line.slice(0, k);
  let raw;
  if (k + 1 === line.length) raw = '';
  else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
  else return `line ${lineNo + 1} is not "key: value"`;
  raw = trimEndST(raw);
  if (!FM_KEYS.has(key)) return `unknown key "${key}"`;
  if (Object.hasOwn(data, key)) return `key "${key}" is given twice`;
  if (raw === '') return `key "${key}" has no value`;
  const v = fmValue(key, raw);
  if ('error' in v) return v.error;
  data[key] = v.value;
  return null;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const firstEnd = text.indexOf('\n');
  if ((firstEnd === -1 ? text : text.slice(0, firstEnd)) !== '---') return { error: 'no front matter' };
  const fmStart = firstEnd === -1 ? text.length : firstEnd + 1;
  let closeLineStart = -1;
  let closeAt = -1;
  let scan = fmStart;
  while (scan <= text.length) {
    const e = text.indexOf('\n', scan);
    const line = e === -1 ? text.slice(scan) : text.slice(scan, e);
    if (line === '---') {
      closeLineStart = scan;
      closeAt = e === -1 ? text.length : e + 1;
      break;
    }
    if (e === -1) break;
    scan = e + 1;
  }
  if (closeAt === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let p = fmStart;
  let lineNo = 1;
  while (p < closeLineStart) {
    const e = text.indexOf('\n', p);
    const line = e === -1 ? text.slice(p) : text.slice(p, e);
    const err = fmLine(line, lineNo, data);
    if (err !== null) return { error: err };
    if (e === -1) break;
    p = e + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeAt) };
}

// ---------------------------------------------------------------- Markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** A fence's language, or null when `line` does not open one. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line.charCodeAt(j))) j++;
  const lang = line.slice(3, j);
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
    j++;
  }
  return lang;
}

/** Whether `line` closes a fence: three backticks, spaces or tabs after. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6) return null;
  let j = h;
  if (j >= line.length || (line.charCodeAt(j) !== 32 && line.charCodeAt(j) !== 9)) return null;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  let end = line.length;
  while (end > j && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end === j) return null;
  return { depth: h, text: line.slice(j, end) };
}

/** Whether `line` is a thematic break: --- or ***, spaces or tabs after. */
function isHr(line) {
  const dash = line.charCodeAt(0) === 45 && line.charCodeAt(1) === 45 && line.charCodeAt(2) === 45;
  const star = line.charCodeAt(0) === 42 && line.charCodeAt(1) === 42 && line.charCodeAt(2) === 42;
  if (!dash && !star) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** An ordered list's start number and item text, or null. */
function orderedOf(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j === 0 || j > 9) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { start: Number(line.slice(0, j)), rest: line.slice(j + 2) };
}

/** A bullet item's text, or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  if (j < 2 || j >= line.length) return false;
  return /\S/.test(line[j]);
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/** The first index from `from` where `s` holds `what` outside an escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
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
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The characters inline rendering must stop at: structure marks and the HTML escape table. */
const INLINE_SPECIAL = /[\\`*\[&<>"']/g;
const INLINE_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `s` rendered inline, appended to `out`; `link(target)` is a link's href. */
function inlineInto(s, link, out) {
  let i = 0;
  const n = s.length;
  while (i < n) {
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    const j = m === null ? n : m.index;
    if (j > i) out.push(s.slice(i, j));
    if (m === null) break;
    i = j;
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        out.push(INLINE_ESCAPE[s[i + 1]] ?? s[i + 1]);
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        out.push('<code>', escText(s.slice(i + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) {
          out.push('<strong>');
          inlineInto(s.slice(i + 2, k), link, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i += 2;
        }
      } else {
        const k = findSingleStar(s, i + 1);
        if (k > i + 1) {
          out.push('<em>');
          inlineInto(s.slice(i + 1, k), link, out);
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i++;
        }
      }
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1);
      const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        out.push('<a href="', escText(link(target)), '">');
        inlineInto(s.slice(i + 1, k), link, out);
        out.push('</a>');
        i = mm + 1;
      } else {
        out.push('[');
        i++;
      }
      continue;
    }
    out.push(INLINE_ESCAPE[s[i]]);
    i++;
  }
  INLINE_SPECIAL.lastIndex = 0;
}

/** `s` rendered inline, as one string. */
function inlineStr(s, link) {
  const out = [];
  inlineInto(s, link, out);
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading: level, id and
 * its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, link, slugCache) {
  const lines = src.split('\n');
  const total = lines.length;
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = '';
  let haveExcerpt = false;
  let i = 0;
  while (i < total) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < total && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      out.push('<pre><code', lang === '' ? '' : ` class="language-${lang}"`, '>');
      for (const b of body) {
        out.push(escText(b), '\n');
      }
      out.push('</code></pre>\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlugOf(slugOf(heading.text, slugCache), ids);
      const html = inlineStr(heading.text, link);
      out.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < total && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(trimST(l.slice(l.charCodeAt(1) === 32 ? 2 : 1)));
      }
      const keptLines = body.filter((l) => l !== '');
      out.push(
        keptLines.length === 0
          ? '<blockquote>\n</blockquote>\n'
          : `<blockquote>\n<p>${inlineStr(keptLines.join('\n'), link)}</p>\n</blockquote>\n`,
      );
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const start = isOrdered ? ordered.start : 1;
      const items = [];
      while (i < total) {
        const l = lines[i];
        let rest = null;
        if (isOrdered) {
          const o = orderedOf(l);
          if (o !== null) rest = o.rest;
        } else {
          rest = bulletOf(l);
        }
        if (rest !== null) {
          items.push(trimST(rest));
          i++;
        } else if (items.length > 0 && isContinued(l)) {
          items[items.length - 1] += `\n${trimST(l)}`;
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      out.push(open, '\n');
      for (const item of items) out.push(`<li>${inlineStr(item, link)}</li>\n`);
      out.push(`</${tag}>\n`);
      continue;
    }
    let text = trimST(line);
    i++;
    while (i < total && !endsParagraph(lines[i])) {
      text += `\n${trimST(lines[i++])}`;
    }
    const html = inlineStr(text, link);
    if (!haveExcerpt) {
      excerpt = html;
      haveExcerpt = true;
    }
    out.push(`<p>${html}</p>\n`);
  }
  return { html: out.join(''), toc, excerpt };
}

// ---------------------------------------------------------------- links

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
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

/** Whether `target` opens with a scheme (`https:`, `mailto:` ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  let j = 1;
  while (j < target.length) {
    const c = target.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) j++;
    else break;
  }
  return j < target.length && target.charCodeAt(j) === 58;
}

/** A source's link resolver: pages and static files by path, the rest broken. */
function makeLinker(dir, bySource, staticPaths, base, broken, sourcePath) {
  return (target) => {
    if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
    const hash = target.indexOf('#');
    const rel = hash === -1 ? target : target.slice(0, hash);
    const frag = hash === -1 ? '' : target.slice(hash);
    const path = rel === '' ? null : resolvePath(dir, rel);
    if (path !== null) {
      const page = bySource.get(path);
      if (page !== undefined) return `${page.url}${frag}`;
      if (staticPaths.has(path)) return `${base}/${path}${frag}`;
    }
    broken.add(`broken-link ${sourcePath} -> ${target}`);
    return target;
  };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function splitPath(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `src` holds only spaces or tabs between `a` and `b`. */
function onlySpacesTabs(src, a, b) {
  for (let j = a; j < b; j++) {
    const c = src.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * `src` parsed into its tree of nodes (a TemplateError when it does not
 * parse). A {% %} tag alone on its line (only spaces or tabs beside it)
 * takes the whole line with it, its newline included.
 */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  let text = '';
  let i = 0;
  const len = src.length;
  const flushText = () => {
    if (text !== '') {
      body.push({ kind: 'text', text });
      text = '';
    }
  };
  while (i < len) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === len - 1) {
      text += src.slice(i);
      break;
    }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      flushText();
      body.push({ kind: raw ? 'raw' : 'var', path: splitPath(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? len : nl;
    const standalone = onlySpacesTabs(src, lineStart, open) && onlySpacesTabs(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    flushText();
    const tag = src.slice(open + 2, close).trim();
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { kind: 'for', name: m[1], path: splitPath(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { kind: 'if', not: m[1] !== undefined, path: splitPath(name, m[2]), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      const top = stack[stack.length - 1];
      if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.else = [];
      body = top.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      const top = stack[stack.length - 1];
      if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
        throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else !== null ? parent.else : parent.then;
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push({ kind: 'include', name: m[1] });
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
    i = standalone ? (nl === -1 ? len : nl + 1) : end;
  }
  flushText();
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** Adjacent literal text nodes joined into one (concatenation is associative). */
function mergeText(nodes) {
  const out = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (n.kind === 'text' && last !== undefined && last.kind === 'text') {
      out[out.length - 1] = { kind: 'text', text: last.text + n.text };
    } else out.push(n);
  }
  return out;
}

/**
 * `nodes` with every include spliced in (a missing template, or one nested
 * more than 8 deep, renders nothing). Fresh for/if nodes; text and value
 * nodes are shared, never written.
 */
function expandNodes(nodes, depth, parsed) {
  const out = [];
  for (const n of nodes) {
    if (n.kind === 'text' || n.kind === 'var' || n.kind === 'raw') {
      out.push(n);
    } else if (n.kind === 'if') {
      out.push({
        kind: 'if',
        not: n.not,
        path: n.path,
        then: expandNodes(n.then, depth, parsed),
        else: n.else === null ? null : expandNodes(n.else, depth, parsed),
      });
    } else if (n.kind === 'for') {
      out.push({ kind: 'for', name: n.name, path: n.path, body: expandNodes(n.body, depth, parsed), frame: null });
    } else if (depth < INCLUDE_DEPTH) {
      const sub = parsed.get(n.name);
      if (sub !== undefined) {
        const expanded = expandNodes(sub, depth + 1, parsed);
        for (const x of expanded) out.push(x);
      }
    }
  }
  return mergeText(out);
}

/** The value at `path` in the scope chain, or undefined. */
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

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let k = 0; k < v.length; k++) {
      if (k > 0) s += ', ';
      s += textOf(v[k]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope` ({ vars, parent }), appended to `out`. */
function renderInto(nodes, scope, out) {
  for (const n of nodes) {
    if (n.kind === 'text') {
      out.push(n.text);
    } else if (n.kind === 'var') {
      out.push(escText(textOf(lookup(scope, n.path))));
    } else if (n.kind === 'raw') {
      out.push(textOf(lookup(scope, n.path)));
    } else if (n.kind === 'if') {
      const branch = truthy(lookup(scope, n.path)) !== n.not ? n.then : n.else;
      if (branch !== null) renderInto(branch, scope, out);
    } else {
      const xs = lookup(scope, n.path);
      if (!Array.isArray(xs)) continue;
      let fr = n.frame;
      if (fr === null) {
        fr = n.frame = { vars: { [n.name]: undefined, loop: { index: 0, first: false, last: false, length: 0 } }, parent: null };
      }
      fr.parent = scope;
      const vs = fr.vars;
      const lp = vs.loop;
      const len = xs.length;
      for (let k = 0; k < len; k++) {
        if (n.name !== 'loop') vs[n.name] = xs[k];
        lp.index = k + 1;
        lp.first = k === 0;
        lp.last = k === len - 1;
        lp.length = len;
        renderInto(n.body, fr, out);
      }
    }
  }
}

// --- constant hoisting: parts of a layout that only read the case's own
// values (site, tags, recent) are rendered once per case, not once per page.
// `env` maps each name in scope to whether its value is case-constant; a
// name a non-constant loop binds is marked not constant, so a shadowing loop
// can never make a page-varying read look constant.

function caseEnv() {
  const env = new Map();
  env.set('site', true);
  env.set('tags', true);
  env.set('recent', true);
  return env;
}

function pathConst(path, env) {
  return env.get(path[0]) === true;
}

function listConst(nodes, env) {
  for (const n of nodes) if (!nodeConst(n, env)) return false;
  return true;
}

function nodeConst(n, env) {
  if (n.kind === 'text') return true;
  if (n.kind === 'var' || n.kind === 'raw') return pathConst(n.path, env);
  if (n.kind === 'if') {
    return pathConst(n.path, env) && listConst(n.then, env) && (n.else === null || listConst(n.else, env));
  }
  const pc = pathConst(n.path, env);
  if (!pc) return false;
  const inner = new Map(env);
  inner.set(n.name, true);
  inner.set('loop', true);
  return listConst(n.body, inner);
}

/**
 * `nodes` with each maximal case-constant subtree (other than plain text)
 * replaced by the text it renders to under `scope`, which holds the case's
 * own values alone.
 */
function flattenList(nodes, scope, env) {
  const out = [];
  for (const n of nodes) {
    if (n.kind === 'text') {
      out.push(n);
      continue;
    }
    if (nodeConst(n, env)) {
      const tmp = [];
      renderInto([n], scope, tmp);
      const s = tmp.join('');
      if (s !== '') out.push({ kind: 'text', text: s });
      continue;
    }
    if (n.kind === 'for') {
      const inner = new Map(env);
      inner.set(n.name, false);
      inner.set('loop', false);
      n.body = flattenList(n.body, scope, inner);
      out.push(n);
    } else if (n.kind === 'if') {
      n.then = flattenList(n.then, scope, env);
      if (n.else !== null) n.else = flattenList(n.else, scope, env);
      out.push(n);
    } else {
      out.push(n);
    }
  }
  return mergeText(out);
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** A page's link record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  return { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDateOf(s.data.date) };
}

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDateOf(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(s, card) {
  return {
    title: card.title,
    url: card.url,
    date: card.date,
    date_long: card.date_long,
    summary: card.summary,
    excerpt: card.excerpt,
    reading_minutes: card.reading_minutes,
    tags: card.tags,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
function build(input) {
  const slugCache = new Map();
  const report = [];
  const parsed = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const files = [...input.files].sort((a, b) => byCodeUnits(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }

  const base = input.site.base_url.replace(/\/+$/, '');
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
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!parsed.has(layout)) {
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

  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let takenSet = taken.get(dir);
    if (takenSet === undefined) {
      takenSet = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, takenSet);
    }
    s.slug = uniqueSlugOf(s.data.slug ?? slugOf(s.data.title, slugCache), takenSet);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const link = makeLinker(dirOf(s.path), bySource, staticPaths, base, broken, s.path);
    const md = renderMarkdown(s.body, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  const bySlug = new Map();
  const ownTagNames = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugOf(name, slugCache);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTagNames(p)) {
      const slug = slugOf(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTagNames(s).map((name) => {
      const slug = slugOf(name, slugCache);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const cards = new Map();
  for (const s of kept) cards.set(s, cardOf(s));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const caseVars = { site, tags: allTags, recent };
  const caseScope = { vars: caseVars, parent: null };
  const output = {};

  const flatCache = new Map();
  const renderTemplate = (name, vars) => {
    if (!parsed.has(name)) return null;
    let nodes = flatCache.get(name);
    if (nodes === undefined) {
      nodes = flattenList(expandNodes(parsed.get(name), 0, parsed), caseScope, caseEnv());
      flatCache.set(name, nodes);
    }
    const out = [];
    renderInto(nodes, { vars, parent: caseScope }, out);
    return out.join('');
  };

  for (const s of kept) {
    output[`${s.outDir}/index.html`] = renderTemplate(s.layout, { page: pageOf(s, cards.get(s)) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = renderTemplate('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = renderTemplate('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = renderTemplate('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
