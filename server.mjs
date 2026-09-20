#!/usr/bin/env node
// habr-mcp -- MCP server for the Habr internal /kek/v2 API.
//
// The surface is NOT described here. Tool names, the prose an agent reads,
// argument schemas, the allowed origin, the write methods and the page cap all
// come from spec/habr.t27 by way of habr_decls.mjs (emitted by `t27c gen-js`)
// and spec.mjs (which assembles them and refuses an inconsistent spec). What
// lives in this file is the runtime: HTTP, JSON-RPC over stdio, and the nine
// handlers.
//
// Read tools work anonymously. Write tools need HABR_COOKIE + HABR_CSRF in the
// environment -- exported by the owner, never minted by an agent -- and
// confirm:true.

import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ARTICLE_PAGE_WALK_MAX,
  COOKIE_ENV,
  CSRF_ENV,
  DEFAULT_LANG,
  MCP_PROTOCOL_VERSION,
  REQUEST_ORIGIN,
  REQUEST_PATH_PREFIX,
  SEARCH_ORDER_DEFAULT,
  SERVER_NAME,
  SERVER_VERSION,
  TOOLS,
  TOOL_NAMES,
  USER_AGENT,
  WRITE_METHODS,
  validateArgs,
} from './spec.mjs';

const COOKIE = process.env[COOKIE_ENV] || '';
const CSRF = process.env[CSRF_ENV] || '';
const LANG = { fl: process.env.HABR_FL || DEFAULT_LANG, hl: process.env.HABR_HL || DEFAULT_LANG };
const WRITES = new Set(WRITE_METHODS);

// ---------------------------------------------------------------- http layer

/**
 * The one place a request URL is built, and the reason the session cookie
 * cannot leave habr.com.
 *
 * The previous version accepted `path.startsWith('http')` and sent the cookie
 * to whatever host followed. Measured with a fake credential against a local
 * listener: one habr_request call, no confirm needed because GET was free, and
 * the session arrived verbatim at a machine that is not Habr. Anything that can
 * get text in front of an agent -- a comment, an article -- could ask for that.
 */
function resolve(path) {
  const p = String(path);
  if (!p.startsWith(REQUEST_PATH_PREFIX)) {
    throw new Error(
      `Refused: a path must begin ${REQUEST_PATH_PREFIX} and stay on ${REQUEST_ORIGIN}. ` +
        `Got ${JSON.stringify(p.slice(0, 80))}. This server holds a logged-in session; it is not a general fetcher.`,
    );
  }
  const url = new URL(p, REQUEST_ORIGIN);
  if (url.origin !== REQUEST_ORIGIN) throw new Error(`Refused: ${url.origin} is not ${REQUEST_ORIGIN}.`);
  // Checked again after resolution: `/kek/v2/../admin` passes the first test and
  // is not a /kek/v2/ path by the time it is a URL.
  if (!url.pathname.startsWith(REQUEST_PATH_PREFIX)) {
    throw new Error(`Refused: ${p} resolves to ${url.pathname}, which is outside ${REQUEST_PATH_PREFIX}.`);
  }
  return url;
}

const MAX_REDIRECTS = 3;

async function api(path, { method = 'GET', body, auth = false } = {}) {
  let url = resolve(path);
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
  if (auth || COOKIE) {
    if (!COOKIE) throw new Error(`${COOKIE_ENV} is not set -- this call needs an authenticated session.`);
    headers.Cookie = COOKIE;
  }
  if (WRITES.has(method)) {
    if (!COOKIE) throw new Error(`${COOKIE_ENV} is not set -- write calls need an authenticated session.`);
    if (!CSRF) throw new Error(`${CSRF_ENV} is not set -- Habr rejects writes without a CSRF token.`);
    headers['csrf-token'] = CSRF;
    headers['Content-Type'] = 'application/json';
    headers.Origin = REQUEST_ORIGIN;
    headers.Referer = `${REQUEST_ORIGIN}/`;
  }

  // Redirects are followed by hand so that one leaving the origin cannot carry
  // the cookie with it, whatever the fetch implementation would have done.
  let res;
  for (let hop = 0; ; hop += 1) {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    if (res.status < 300 || res.status >= 400 || !res.headers.get('location')) break;
    if (hop >= MAX_REDIRECTS) throw new Error(`Habr ${method} ${path} -> more than ${MAX_REDIRECTS} redirects.`);
    const next = new URL(res.headers.get('location'), url);
    if (next.origin !== REQUEST_ORIGIN) {
      throw new Error(`Refused: ${method} ${path} redirected to ${next.origin}, which is not ${REQUEST_ORIGIN}.`);
    }
    url = next;
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { _nonJson: text.slice(0, 600) };
  }
  if (!res.ok) {
    const err = new Error(`Habr ${method} ${path} -> HTTP ${res.status}: ${JSON.stringify(data).slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const q = (obj) =>
  Object.entries({ ...LANG, ...obj })
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

const stripHtml = (h = '') =>
  h
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

// ------------------------------------------------------------- habr wrappers

async function articlePage(user, page) {
  const j = await api(`/kek/v2/articles/?${q({ user, page })}`);
  return { ids: j.publicationIds || [], pagesCount: j.pagesCount ?? 1, refs: j.publicationRefs || {} };
}

/**
 * One pass over the pages, collecting ids AND their refs together.
 *
 * The previous walk fetched page 1 to learn pagesCount, fetched every page
 * again to collect ids, then fetched pages 2..n a third time to collect refs --
 * 2n-1 requests for n pages, counted on a live account. It also stopped at
 * ARTICLE_PAGE_WALK_MAX without telling anyone, under a description that
 * promised every page.
 */
async function walkArticles(user) {
  const ids = [];
  const refs = {};
  let pagesCount = 1;
  let page = 1;
  do {
    const r = await articlePage(user, page);
    ids.push(...r.ids);
    Object.assign(refs, r.refs);
    pagesCount = r.pagesCount;
    page += 1;
  } while (page <= Math.min(pagesCount, ARTICLE_PAGE_WALK_MAX));
  return { ids, refs, pagesCount, truncated: pagesCount > ARTICLE_PAGE_WALK_MAX };
}

const describe = (id, refs) => ({
  id,
  title: stripHtml(refs[id]?.titleHtml || ''),
  timePublished: refs[id]?.timePublished,
  commentsCount: refs[id]?.statistics?.commentsCount,
});

function flattenComments(j) {
  return Object.values(j.comments || {}).map((c) => ({
    id: String(c.id),
    parentId: c.parentId == null ? null : String(c.parentId),
    author: c.author?.alias ?? null,
    authorName: c.author?.fullname ?? null,
    timePublished: c.timePublished,
    score: c.score,
    status: c.status,
    text: stripHtml(c.message || ''),
  }));
}

async function commentsOf(articleId) {
  return flattenComments(await api(`/kek/v2/articles/${articleId}/comments/?${q({})}`));
}

function unansweredIn(list, self) {
  const kids = new Map();
  for (const c of list) {
    if (!kids.has(c.parentId)) kids.set(c.parentId, []);
    kids.get(c.parentId).push(c);
  }
  return list.filter(
    (c) =>
      c.author &&
      c.author !== self &&
      c.status === 'published' &&
      !(kids.get(c.id) || []).some((k) => k.author === self),
  );
}

// Plain text -> the ProseMirror document Habr's comment endpoint expects.
function toProseMirror(text) {
  const paras = String(text).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return {
    type: 'doc',
    content: (paras.length ? paras : ['']).map((p) => ({
      type: 'paragraph',
      content: p
        ? p.split('\n').flatMap((line, i) =>
            i === 0 ? [{ type: 'text', text: line }] : [{ type: 'hardBreak' }, { type: 'text', text: line }],
          )
        : [],
    })),
  };
}

// ------------------------------------------------------------------ handlers
//
// Keyed by the tool names the spec declares. A name here with no tool in the
// spec, or a tool in the spec with no handler here, is a build that should not
// have shipped -- test_habr.mjs checks both directions.

const handlers = {
  habr_whoami: async () => {
    const res = { [COOKIE_ENV]: COOKIE ? 'set' : 'absent', [CSRF_ENV]: CSRF ? 'set' : 'absent' };
    if (!COOKIE) return { ...res, account: null, canWrite: false, note: 'Read tools still work anonymously.' };
    try {
      const me = await api(`/kek/v2/me/?${q({})}`, { auth: true });
      return { ...res, account: { id: me.id, alias: me.alias, fullname: me.fullname }, canWrite: Boolean(CSRF) };
    } catch (e) {
      return { ...res, account: null, canWrite: false, error: e.message };
    }
  },

  habr_articles: async ({ user, page }) => {
    if (page) {
      const r = await articlePage(user, page);
      return { page: Number(page), pagesCount: r.pagesCount, articles: r.ids.map((id) => describe(id, r.refs)) };
    }
    const w = await walkArticles(user);
    return {
      count: w.ids.length,
      pagesCount: w.pagesCount,
      pagesWalked: Math.min(w.pagesCount, ARTICLE_PAGE_WALK_MAX),
      walkTruncated: w.truncated,
      articles: w.ids.map((id) => describe(id, w.refs)),
    };
  },

  habr_article: async ({ id, text = true }) => {
    const a = await api(`/kek/v2/articles/${id}/?${q({})}`);
    return {
      id: a.id,
      title: stripHtml(a.titleHtml || ''),
      timePublished: a.timePublished,
      lang: a.lang,
      author: a.author?.alias,
      hubs: (a.hubs || []).map((h) => h.alias),
      tags: (a.tags || []).map((t) => t.titleHtml),
      statistics: a.statistics,
      url: `${REQUEST_ORIGIN}/ru/articles/${a.id}/`,
      lead: stripHtml(a.leadData?.textHtml || ''),
      body: text ? stripHtml(a.textHtml || '') : undefined,
    };
  },

  habr_comments: async ({ articleId }) => {
    const list = await commentsOf(articleId);
    return { articleId, total: list.length, comments: list };
  },

  habr_unanswered: async ({ user, articleIds, since }) => {
    let targets = articleIds;
    let truncated = false;
    let pagesCount;
    if (!targets?.length) {
      const w = await walkArticles(user);
      targets = w.ids;
      truncated = w.truncated;
      pagesCount = w.pagesCount;
    }
    const perArticle = [];
    let total = 0;
    for (const id of targets) {
      let list;
      try {
        list = await commentsOf(id);
      } catch (e) {
        perArticle.push({ articleId: id, error: e.message });
        continue;
      }
      let un = unansweredIn(list, user);
      if (since) un = un.filter((c) => c.timePublished >= since);
      total += un.length;
      perArticle.push({ articleId: id, total: list.length, unanswered: un.length, comments: un });
    }
    return { user, scanned: targets.length, pagesCount, walkTruncated: truncated, unansweredTotal: total, articles: perArticle };
  },

  habr_my_comments: async ({ user, page = 1 }) => {
    const j = await api(`/kek/v2/users/${user}/comments/?${q({ page })}`);
    return { user, page: Number(page), comments: flattenComments(j) };
  },

  habr_search: async ({ query, page = 1, order = SEARCH_ORDER_DEFAULT }) => {
    const j = await api(`/kek/v2/articles/?${q({ query, page, order })}`);
    const refs = j.publicationRefs || {};
    return {
      order,
      pagesCount: j.pagesCount,
      statistics: j.searchStatistics,
      results: (j.publicationIds || []).map((id) => ({
        id,
        title: stripHtml(refs[id]?.titleHtml || ''),
        author: refs[id]?.author?.alias,
        timePublished: refs[id]?.timePublished,
        url: `${REQUEST_ORIGIN}/ru/articles/${id}/`,
      })),
    };
  },

  habr_comment_create: async ({ articleId, message, parentId, confirm }) => {
    if (confirm !== true) throw new Error("Refused: confirm must be true, and only with the owner's explicit approval.");
    if (!String(message).trim()) throw new Error('Refused: empty message.');
    const body = { text: JSON.stringify(toProseMirror(message)), parentId: parentId ?? null };
    const r = await api(`/kek/v2/comments/posts/${articleId}/add`, { method: 'POST', body, auth: true });
    return { posted: true, articleId, parentId: parentId ?? null, response: r };
  },

  habr_request: async ({ path, method = 'GET', body, confirm }) => {
    const m = String(method).toUpperCase();
    if (WRITES.has(m) && confirm !== true) {
      throw new Error(`Refused: ${m} needs confirm:true and the owner's explicit approval.`);
    }
    return api(path, { method: m, body });
  },
};

// ------------------------------------------------------------ jsonrpc / mcp

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    return {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: TOOLS };
  if (method === 'tools/call') {
    const name = params?.name;
    if (!TOOL_NAMES.includes(name)) throw new Error(`Unknown tool: ${name}`);
    const args = params.arguments || {};
    // Required arguments, closed value sets and integer bounds all come off the
    // schema the spec published, so the check and the advertisement cannot drift.
    const bad = validateArgs(name, args);
    if (bad) throw new Error(bad);
    const handler = handlers[name];
    if (!handler) throw new Error(`${name} is in the spec but has no implementation here`);
    const result = await handler(args);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] };
  }
  if (typeof id === 'undefined') return null; // notification
  throw new Error(`Unknown method: ${method}`);
}

// Only when run as the server. Imported -- by the gate, or by anything that
// wants `resolve` and the handlers -- it must not take over stdin.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    try {
      const result = await handle(req);
      if (result === null || typeof req.id === 'undefined') return;
      send({ jsonrpc: '2.0', id: req.id, result });
    } catch (e) {
      if (typeof req.id === 'undefined') return;
      send({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: e.message } });
    }
  });
}

export { api, handle, handlers, resolve, walkArticles };
