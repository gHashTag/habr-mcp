#!/usr/bin/env node
// The gate for habr-mcp.
//
// Three kinds of check, in order of how much they are worth:
//
//   1. The spec's laws, run against deliberately broken specs. A law that has
//      only ever seen a spec it accepts is not known to work. Fourteen
//      mutations here; each one must be refused, by name.
//   2. The containment law, which is the reason the server was rewritten: the
//      owner's session cookie cannot leave habr.com. Proved by counting
//      requests with a fake fetch, including one that tries to walk out
//      through a redirect.
//   3. Live read-only probes against Habr. If the network is not there, these
//      SKIP loudly -- they never pass by absence.
//
// Run: node test_habr.mjs        (add --no-live to stay offline)

import { DECLS, SpecError, TOOLS, TOOL_KIND, TOOL_NAMES, buildSurface, validateArgs, ARTICLE_PAGE_WALK_MAX, REQUEST_ORIGIN } from './spec.mjs';
import { api, handlers, resolve, walkArticles } from './server.mjs';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` -- ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}
const skipped = (name, why) => {
  skip += 1;
  console.log(`  SKIP ${name} -- ${why}`);
};
const section = (t) => console.log(`\n${t}`);

async function throws(name, fn, wants) {
  let message = null;
  try {
    await fn();
  } catch (e) {
    message = e.message;
  }
  if (message === null) return ok(name, false, 'it was accepted');
  if (wants && !message.toLowerCase().includes(wants.toLowerCase())) {
    return ok(name, false, `refused for the wrong reason: ${message.slice(0, 120)}`);
  }
  return ok(name, true);
}

// ---------------------------------------------------------------- 1. the laws

const clone = () => JSON.parse(JSON.stringify({ ...DECLS }));

function refuses(name, mutate, wants) {
  const d = clone();
  mutate(d);
  let message = null;
  try {
    buildSurface(d);
  } catch (e) {
    message = e instanceof SpecError ? e.message : `threw ${e.constructor.name}: ${e.message}`;
  }
  if (message === null) return ok(name, false, 'the broken spec built a tool table');
  if (wants && !message.includes(wants)) return ok(name, false, `wrong reason: ${message.slice(0, 140)}`);
  return ok(name, true);
}

section('The spec builds, and the laws refuse what they claim to refuse');

ok('the real spec builds', TOOLS.length > 0, `${TOOLS.length} tools`);
ok('nine tools', TOOLS.length === 9, TOOL_NAMES.join(', '));
ok('every tool has a description', TOOLS.every((t) => t.description && t.description.length > 10));
ok('every tool has an object schema', TOOLS.every((t) => t.inputSchema?.type === 'object'));

refuses('no __STRUCT_ORDER__', (d) => delete d.__STRUCT_ORDER__, '__STRUCT_ORDER__');
refuses('__STRUCT_ORDER__ names a non-struct', (d) => d.__STRUCT_ORDER__.push('SERVER_NAME'), 'not a struct');
refuses('a field types itself with something that is not a marker', (d) => {
  d.HabrSearch.fields[0][1] = 'Wobble';
}, 'not a declared argument marker');
refuses('a marker with an unknown requiredness prefix', (d) => {
  d.Maybe = { __struct__: 'Maybe', fields: [['v', 'str']] };
  d.__STRUCT_ORDER__.unshift('Maybe');
}, 'must start with Req or Opt');
refuses('a marker carrying a type JSON has no name for', (d) => {
  d.ReqStr.fields[0][1] = 'quaternion';
}, 'must start with Req or Opt');
refuses('a tool with no description', (d) => delete d.HABR_SEARCH_DESC, 'HABR_SEARCH_DESC');
refuses('an argument with no description', (d) => delete d.HABR_SEARCH_QUERY_DESC, 'HABR_SEARCH_QUERY_DESC');
refuses('a description with nothing to describe', (d) => {
  d.HABR_GHOST_DESC = 'a tool that does not exist';
}, 'nothing to describe');
refuses('ToolKind with the wrong members', (d) => {
  d.ToolKind = { read_only: 0, outward: 1, maybe: 2 };
}, 'ToolKind must be');
refuses('OUTWARD_TOOLS naming a tool that does not exist', (d) => {
  d.OUTWARD_TOOLS = [...d.OUTWARD_TOOLS, 'habr_launch_missiles'];
}, 'do not exist');
refuses('an outward tool with no confirm', (d) => {
  d.HabrCommentCreate.fields = d.HabrCommentCreate.fields.filter(([f]) => f !== 'confirm');
  delete d.HABR_COMMENT_CREATE_CONFIRM_DESC;
}, 'must be gated');
refuses('a bound on an argument that is not an integer', (d) => {
  d.HABR_SEARCH_QUERY_MIN = 1;
}, 'not an integer');
refuses('a closed value set on an argument that is not a string', (d) => {
  d.HABR_SEARCH_PAGE_VALUES = ['1', '2'];
}, 'not a string');
refuses('an empty closed value set', (d) => {
  d.HABR_SEARCH_ORDER_VALUES = [];
}, 'non-empty');
refuses('non-ASCII in a string literal', (d) => {
  d.SERVER_NAME = 'habr—mcp';
}, 'non-ASCII');

section('The artifact is what the compiler prints, not what anyone typed');

// The whole point of `t27c gen-js` is that habr_decls.mjs has no author. If
// someone edits it -- to add a tool, to widen a limit -- this is where it
// shows up. A compiler that cannot be found SKIPs loudly; it never passes.
{
  const { execFileSync } = await import('node:child_process');
  const { readFileSync, existsSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.T27C,
    't27c',
    join(here, '..', 't27', 'target', 'release', 't27c'),
  ].filter(Boolean);
  let printed = null;
  let usedCompiler = null;
  for (const c of candidates) {
    try {
      if (c.includes('/') && !existsSync(c)) continue;
      printed = execFileSync(c, ['gen-js', join(here, 'spec', 'habr.t27')], { encoding: 'utf8' });
      usedCompiler = c;
      break;
    } catch {
      /* try the next one */
    }
  }
  if (printed === null) {
    skipped('habr_decls.mjs is byte-identical to `t27c gen-js`',
      `no t27c found (tried ${candidates.join(', ')}). Set T27C=/path/to/t27c.`);
  } else {
    const onDisk = readFileSync(join(here, 'habr_decls.mjs'), 'utf8');
    ok('habr_decls.mjs is byte-identical to `t27c gen-js`', printed === onDisk,
      `${usedCompiler} prints ${printed.length} bytes, the file is ${onDisk.length}`);
  }
}

// ------------------------------------------------- 2. what the schema promises

section('The schema says what the server enforces');

ok('search order is a closed set', Array.isArray(TOOLS.find((t) => t.name === 'habr_search').inputSchema.properties.order.enum));
ok('page cannot be zero', TOOLS.find((t) => t.name === 'habr_articles').inputSchema.properties.page.minimum === 1);
ok('both outward tools are marked outward',
  TOOL_KIND.habr_comment_create === 'outward' && TOOL_KIND.habr_request === 'outward',
  JSON.stringify(TOOL_KIND));
ok('reads are not marked outward', TOOL_KIND.habr_search === 'read_only' && TOOL_KIND.habr_article === 'read_only');
ok('every outward tool advertises confirm',
  TOOLS.filter((t) => TOOL_KIND[t.name] === 'outward').every((t) => 'confirm' in t.inputSchema.properties));

ok('a missing required argument is refused', validateArgs('habr_search', {}) !== null, String(validateArgs('habr_search', {})));
ok('an order outside the set is refused', (validateArgs('habr_search', { query: 'x', order: 'whatever' }) || '').includes('must be one of'));
ok('page 0 is refused', (validateArgs('habr_search', { query: 'x', page: 0 }) || '').includes('>= 1'));
ok('a non-integer page is refused', validateArgs('habr_search', { query: 'x', page: 'seven' }) !== null);
ok('a legal call passes', validateArgs('habr_search', { query: 'x', page: 2, order: 'date' }) === null);

section('Spec and implementation name the same nine tools');
const implemented = Object.keys(handlers);
ok('no tool is advertised without an implementation',
  TOOL_NAMES.every((n) => implemented.includes(n)),
  TOOL_NAMES.filter((n) => !implemented.includes(n)).join(', '));
ok('no handler exists that the spec never advertised',
  implemented.every((n) => TOOL_NAMES.includes(n)),
  implemented.filter((n) => !TOOL_NAMES.includes(n)).join(', '));

// ------------------------------------------- 3. the cookie cannot leave habr.com

section('Containment: the session cannot leave habr.com');

ok('a real API path resolves', resolve('/kek/v2/articles/?user=x').origin === REQUEST_ORIGIN);
await throws('an absolute URL to another host', () => resolve('https://evil.example/kek/v2/me/'), 'must begin');
await throws('a protocol-relative URL', () => resolve('//evil.example/kek/v2/me/'), 'must begin');
await throws('a path outside the API prefix', () => resolve('/admin/secrets'), 'must begin');
await throws('a traversal back out of the prefix', () => resolve('/kek/v2/../../admin'), 'outside');
await throws('a scheme that is not http', () => resolve('file:///etc/passwd'), 'must begin');

const realFetch = globalThis.fetch;
let seen = [];
const fake = (handler) => {
  seen = [];
  globalThis.fetch = async (url, opts = {}) => {
    seen.push({ url: String(url), headers: opts.headers || {} });
    return handler(String(url), opts, seen.length);
  };
};
const json = (body, status = 200, headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => JSON.stringify(body),
});

try {
  // The defect this replaces: habr_request took any path, api() sent the cookie
  // with it, and GET needed no confirm. Measured once with a fake credential
  // against a local listener -- the session arrived verbatim at a machine that
  // is not Habr.
  fake(() => json({ ok: true }));
  await throws('habr_request cannot be pointed off-origin',
    () => handlers.habr_request({ path: 'https://evil.example/collect' }), 'must begin');
  ok('and no request left the process', seen.length === 0, `${seen.length} requests`);

  fake((url, _o, n) => (n === 1
    ? json({}, 302, { location: 'https://evil.example/collect' })
    : json({ ok: true })));
  await throws('a redirect off-origin is refused, not followed',
    () => api('/kek/v2/me/'), 'is not https://habr.com');
  ok('the redirect target was never fetched',
    seen.length === 1 && !seen.some((r) => r.url.includes('evil.example')),
    seen.map((r) => r.url).join(' -> '));

  fake((url, _o, n) => (n === 1
    ? json({}, 302, { location: '/kek/v2/articles/?user=x' })
    : json({ publicationIds: ['1'], pagesCount: 1, publicationRefs: {} })));
  const redirected = await api('/kek/v2/me/');
  ok('a redirect that stays on habr.com is followed', redirected.pagesCount === 1, JSON.stringify(redirected).slice(0, 80));

  // "Walks every page" was false, and page 1 was fetched twice.
  const page = (n, total) => json({
    publicationIds: [`id${n}`],
    pagesCount: total,
    publicationRefs: { [`id${n}`]: { titleHtml: `T${n}`, timePublished: '2026-01-01', statistics: {} } },
  });
  let n = 0;
  fake(() => page(++n, 3));
  const small = await walkArticles('someone');
  ok('three pages cost three requests', seen.length === 3, `${seen.length} requests`);
  ok('and every id was kept', small.ids.length === 3, small.ids.join(','));
  ok('and nothing was truncated', small.truncated === false);
  ok('and every id has its title', small.ids.every((id) => small.refs[id]?.titleHtml));

  n = 0;
  const over = ARTICLE_PAGE_WALK_MAX + 5;
  fake(() => page(++n, over));
  const big = await walkArticles('prolific');
  ok(`the walk stops at ${ARTICLE_PAGE_WALK_MAX} pages`, seen.length === ARTICLE_PAGE_WALK_MAX, `${seen.length} requests`);
  ok('and says so instead of pretending it finished', big.truncated === true);
  ok('and reports the real page count', big.pagesCount === over, String(big.pagesCount));

  // The gate on an outward tool, at the handler rather than in prose.
  fake(() => json({ ok: true }));
  await throws('a comment without confirm is refused', () => handlers.habr_comment_create({ articleId: '1', message: 'hi' }), 'confirm must be true');
  await throws('confirm:"true" is not confirm:true', () => handlers.habr_comment_create({ articleId: '1', message: 'hi', confirm: 'true' }), 'confirm must be true');
  await throws('a POST through habr_request needs confirm', () => handlers.habr_request({ path: '/kek/v2/x', method: 'POST' }), 'confirm:true');
  await throws('lower-case post is still a write', () => handlers.habr_request({ path: '/kek/v2/x', method: 'post' }), 'confirm:true');
  ok('no write attempt reached the network', seen.length === 0, `${seen.length} requests`);
} finally {
  globalThis.fetch = realFetch;
}

// ----------------------------------------------------------- 4. live, read-only

section('Live probes against habr.com (read-only)');

const live = !process.argv.includes('--no-live');
let online = false;
if (live) {
  try {
    await realFetch(`${REQUEST_ORIGIN}/kek/v2/articles/?fl=ru&hl=ru&page=1&query=t27`, { signal: AbortSignal.timeout(8000) });
    online = true;
  } catch (e) {
    skipped('all live probes', `habr.com is not reachable from here: ${e.message}`);
  }
} else {
  skipped('all live probes', '--no-live');
}

if (online) {
  try {
    const s = await handlers.habr_search({ query: 'zig comptime', order: 'date' });
    ok('search returns results', Array.isArray(s.results) && s.results.length > 0, `${s.results?.length} results`);
    ok('every result has an id and a title', s.results.every((r) => r.id && typeof r.title === 'string'));

    // Not "do the two orders return different articles" -- when the whole
    // result set fits on one page they return the same twenty, rearranged.
    // The question worth asking is whether the sort is real.
    const relevance = await handlers.habr_search({ query: 'zig comptime', order: 'relevance' });
    const seq = (r) => r.results.map((x) => x.id).join(',');
    ok('order rearranges the answer', seq(s) !== seq(relevance), 'date and relevance came back in the same order');
    const dates = s.results.map((r) => r.timePublished).filter(Boolean);
    ok('order:date really is newest first',
      dates.every((d, i) => i === 0 || dates[i - 1] >= d),
      dates.map((d) => d.slice(0, 10)).join(' '));

    const id = s.results[0].id;
    const art = await handlers.habr_article({ id, text: false });
    ok('an article reads back', art.id === id && art.title.length > 0, `${art.id} ${art.title?.slice(0, 40)}`);
    ok('body is omitted when text:false', art.body === undefined);

    const c = await handlers.habr_comments({ articleId: id });
    ok('comments read back', typeof c.total === 'number', `${c.total} comments`);

    const who = await handlers.habr_whoami({});
    ok('whoami answers without a cookie', 'canWrite' in who, JSON.stringify(who).slice(0, 120));
    ok('whoami names the env vars rather than their values',
      !JSON.stringify(who).includes(process.env.HABR_COOKIE || ' never'),
      'a credential appeared in the whoami payload');
  } catch (e) {
    ok('live probes', false, e.message);
  }
}

// -------------------------------------------------------------------- verdict

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
if (skip && !fail) console.log('\nSome checks did not run. That is not the same as passing.');
process.exit(fail ? 1 : 0);
