// swiftpress — a fast drop-in replacement for makefun-site 1.0.0.
//
// run(input) answers one case: it builds the site's output tree (path -> text) exactly as makefun-site 1.0.0's
// build does, byte for byte, and spends its effort where a build spends its time: bulk-escaped inline rendering
// instead of a character at a time, memoized slugs, front matter read without splitting the body, and templates
// compiled once into plain functions instead of a walked node tree. No dependencies, no state between calls:
// every run starts from the input alone.

// ---------------------------------------------------------------- text rules

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped, and nothing else. */
function escapeHtml(text) {
  return text.replace(ESCAPE_RE, (c) => ESCAPES[c]);
}

const SLUG_MAX = 64;

/**
 * The slug of `text`, unmemoized: NFKD, combining marks dropped, A-Z lowered, every run of characters other than
 * a-z and 0-9 one "-", none at either end, cut to SLUG_MAX characters (a "-" left at the cut dropped), "untitled"
 * when nothing is left. Pure-ASCII text skips the Unicode machinery: NFKD is the identity on ASCII and no ASCII
 * character is a combining mark, so the scan below is the whole rule there. Non-ASCII text is normalized first;
 * the scan then walks code units, which agrees with a code-point walk because a kept character is always ASCII
 * and every half of a surrogate pair is simply another character that is not kept.
 */
function slugifyRaw(text) {
  let plain = text;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
      break;
    }
  }
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = null;
    if (code >= 65 && code <= 90) keep = String.fromCharCode(code + 32);
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = plain[i];
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** A slug function with a per-build memory: titles, tag names and heading texts repeat across a whole site. */
function makeSlugger() {
  const cache = new Map();
  return (text) => {
    let slug = cache.get(text);
    if (slug === undefined) {
      slug = slugifyRaw(text);
      cache.set(text, slug);
    }
    return slug;
  };
}

/** `slug` made unique against the `taken` set (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whether a line is nothing but spaces and tabs. */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line with its leading and trailing spaces and tabs dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function fmString(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has
 * "\n" line ends. Only the head of the text is scanned line by line; the body is the untouched rest of the string
 * after the closing "---" line, which is exactly the lines after it joined by "\n".
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  if (firstNl === -1) return { error: 'the front matter is not closed' };
  const fmLines = [];
  let bodyStart = -1;
  let pos = firstNl + 1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    if (text.slice(pos, end) === '---') {
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    fmLines.push(text.slice(pos, end));
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (bodyStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 2} is not "key: value"` };
    const key = m[1];
    let raw = m[2] ?? '';
    let rawEnd = raw.length;
    while (rawEnd > 0 && (raw.charCodeAt(rawEnd - 1) === 32 || raw.charCodeAt(rawEnd - 1) === 9)) rawEnd--;
    if (rawEnd < raw.length) raw = raw.slice(0, rawEnd);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const CONTINUED = /^ {2,}\S/;

/** A heading line's level and text, or null: 1 to 6 "#", at least one space or tab, then non-empty text. */
function headingOf(line) {
  let depth = 0;
  while (line.charCodeAt(depth) === 35) depth++;
  if (depth < 1 || depth > 6) return null;
  const after = line.charCodeAt(depth);
  if (after !== 32 && after !== 9) return null;
  let a = depth;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break: exactly "---" or "***", then spaces or tabs only. */
function isBreak(line) {
  let b = line.length;
  while (b > 0 && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b !== 3) return false;
  const head = line.slice(0, 3);
  return head === '---' || head === '***';
}

/** A list item line's parts, or null: a bullet ("- " or "* ") as { text }, an ordered item ("12. ") as { text, num }. */
function listItemOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return { text: line.slice(2) };
  if (c >= 48 && c <= 57) {
    let d = 0;
    while (d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
    if (d <= 9 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
      return { text: line.slice(d + 2), num: Number(line.slice(0, d)) };
    }
  }
  return null;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (isBlankLine(line)) return true;
  if (line.charCodeAt(0) === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96 && FENCE_OPEN.test(line)) return true;
  return headingOf(line) !== null || isBreak(line);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
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
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
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

const SPECIAL_RE = /[\\`*[]/g;
const SPACE_RE = /\s/;

/**
 * `s` rendered inline; `env.link(target)` is a link's href. Plain runs between the four characters that can open
 * a construct (a backslash, a backtick, a star, a bracket) are escaped in one piece each; the constructs
 * themselves are read exactly as the dialect states them.
 */
function inline(s, env) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    SPECIAL_RE.lastIndex = i;
    const m = SPECIAL_RE.exec(s);
    if (m === null) {
      out += escapeHtml(s.slice(i));
      break;
    }
    const at = m.index;
    if (at > i) out += escapeHtml(s.slice(i, at));
    i = at;
    const c = s[i];
    if (c === '\\') {
      const nx = s[i + 1];
      if (nx !== undefined && ESCAPABLE.has(nx)) {
        out += nx === '>' ? '&gt;' : nx;
        i += 2;
      } else {
        out += '\\';
        i++;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out += `<strong>${inline(s.slice(i + 2, j), env)}</strong>`;
          i = j + 2;
        } else {
          out += '**';
          i += 2;
        }
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          out += `<em>${inline(s.slice(i + 1, j), env)}</em>`;
          i = j + 1;
        } else {
          out += '*';
          i++;
        }
      }
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', i + 1);
    const close = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = close === -1 ? '' : s.slice(k + 2, close);
    if (target !== '' && !SPACE_RE.test(target)) {
      out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
      i = close + 1;
    } else {
      out += '[';
      i++;
    }
  }
  return out;
}

/**
 * `src` rendered: its HTML (each block followed by "\n"), its table of contents (every level 2 and 3 heading:
 * level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or ""). Blocks are read in
 * one pass over the lines; `env.slugify` is the build's memoized slug rule, so a heading's id costs a map hit
 * once its text has been seen anywhere in the site.
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < lines.length && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
        i++;
        const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
        // Escaping is a character-by-character map, so the joined body escapes in one pass.
        blocks.push(`<pre><code${cls}>${body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`}</code></pre>`);
        continue;
      }
    }
    const heading = c0 === 35 ? headingOf(line) : null;
    if (heading !== null) {
      const id = uniqueSlug(env.slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if ((c0 === 45 || c0 === 42) && isBreak(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (c0 === 62) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const raw = lines[i++];
        body.push(trimLine(raw.charCodeAt(1) === 32 ? raw.slice(2) : raw.slice(1)));
      }
      const kept = body.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const first = listItemOf(line);
    if (first !== null) {
      const ordered = first.num !== undefined;
      const items = [];
      while (i < lines.length) {
        const item = listItemOf(lines[i]);
        if (item !== null && (item.num !== undefined) === ordered) {
          items.push([trimLine(item.text)]);
          i++;
        } else if (items.length > 0 && CONTINUED.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && first.num !== 1 ? `<ol start="${first.num}">` : `<${tag}>`;
      blocks.push(`${open}\n${items.map((parts) => `<li>${inline(parts.join('\n'), env)}</li>\n`).join('')}</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;
const T_SPACES = /^[ \t]*$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
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
    const standalone = T_SPACES.test(src.slice(lineStart, open)) && T_SPACES.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
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
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
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
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/**
 * The value at a path in the scope stack `S` (innermost last): its first name from the nearest scope holding it
 * as an own property, then own properties down. Anything else is undefined.
 */
function lookup(S, ...path) {
  const first = path[0];
  for (let d = S.length - 1; d >= 0; d--) {
    const vars = S[d];
    if (Object.hasOwn(vars, first)) {
      let v = vars[first];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

const pathArgs = (path) => path.map((p) => JSON.stringify(p)).join(',');

/**
 * A node tree as the body of a render function: text is a literal, a variable a lookup, a loop a real loop over
 * a pushed scope. The generated function takes the scope stack S, the shared context C (escape, text, truth,
 * lookup, the compiled templates) and the include depth D, and returns its output.
 */
function compileNodes(nodes) {
  let code = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        code += `O+=${JSON.stringify(n.text)};`;
        break;
      case 'var':
        code += `O+=C.e(C.t(C.l(S,${pathArgs(n.path)})));`;
        break;
      case 'raw':
        code += `O+=C.t(C.l(S,${pathArgs(n.path)}));`;
        break;
      case 'if':
        code += `if(C.y(C.l(S,${pathArgs(n.path)}))!==${n.not}){${compileNodes(n.then)}}`;
        if (n.else !== null) code += `else{${compileNodes(n.else)}}`;
        break;
      case 'for':
        code += `{const X=C.l(S,${pathArgs(n.path)});if(Array.isArray(X)){const M=X.length;for(let k=0;k<M;k++){const V={};V[${JSON.stringify(n.name)}]=X[k];V.loop={index:k+1,first:k===0,last:k===M-1,length:M};S.push(V);${compileNodes(n.body)}S.pop();}}}`;
        break;
      case 'include':
        code += `{const F=C.m.get(${JSON.stringify(n.name)});if(F!==undefined&&D<${INCLUDE_DEPTH})O+=F(S,C,D+1);}`;
        break;
    }
  }
  return code;
}

/** A template parsed and compiled into its render function (a TemplateError when it does not parse). */
function compileTemplate(name, src) {
  const body = compileNodes(parseTemplate(name, src));
  return new Function('S', 'C', 'D', `'use strict';let O='';${body}return O;`);
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The words of a body: its runs of characters other than whitespace (the \s set, spelled out). */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c === 32 || (c >= 9 && c <= 13)) ws = true;
    else if (c < 128) ws = false;
    else ws = c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      count++;
      inWord = true;
    }
  }
  return count;
}

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

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One site's output tree: path -> text, exactly makefun-site 1.0.0's answer for the input. */
function build(input) {
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const slugify = makeSlugger();
  // The same strings (a post's title, url, date, its tags' names) are escaped again on every page that lists the
  // post — its own page, an index page, its tag pages, every page's recent list. Escape each distinct string once.
  const escCache = new Map();
  const escapeCached = (s) => {
    let r = escCache.get(s);
    if (r === undefined) {
      r = escapeHtml(s);
      escCache.set(s, r);
    }
    return r;
  };
  const ctx = { e: escapeCached, t: textOf, y: truthy, l: lookup, m: templates };
  const render = (name, vars) => {
    const fn = templates.get(name);
    return fn === undefined ? null : fn([{ site: vars.site, tags: vars.tags, recent: vars.recent, ...vars.extra }], ctx, 0);
  };

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter and the checks on it, in order: a refused source is reported and dropped, and
  // so is a draft.
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
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
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

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  // A link's resolution depends only on its source's directory and its target (the source map and the static
  // paths are fixed by now), and sources link to the same targets again and again: resolve each pair once.
  // The value is the href, or null for a broken link (the report line still names each source that holds it).
  const linkCache = new Map();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      slugify,
      link: (target) => {
        if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const key = `${dir}\n${target}`;
        let href = linkCache.get(key);
        if (href === undefined) {
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          href = null;
          if (path !== null) {
            const hit = bySource.get(path);
            if (hit !== undefined) href = `${hit.url}${frag}`;
            else if (staticPaths.has(path)) href = `${base}/${path}${frag}`;
          }
          linkCache.set(key, href);
        }
        if (href !== null) return href;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
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
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs, then the static files.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardCache = new Map();
  const cardOf = (s) => {
    let card = cardCache.get(s);
    if (card === undefined) {
      card = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
      cardCache.set(s, card);
    }
    return card;
  };
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  const shared = { site, tags: allTags, recent };
  const output = {};
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { ...shared, extra: { page: pageOf(s) } });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      ...shared,
      extra: {
        posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { ...shared, extra: { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) } } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', { ...shared, extra: {} });
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input, computed faster. */
export function run(input) {
  return build(input);
}
