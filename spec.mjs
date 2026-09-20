// Assemble the MCP surface from the declarations the compiler emitted.
//
// THERE ARE NO FACTS IN THIS FILE. Every name, every string an agent reads,
// every limit and every origin comes from spec/habr.t27, lowered to
// habr_decls.mjs by `t27c gen-js`. What lives here is the *rules* for turning
// those declarations into a JSON-Schema tool table -- and the laws that refuse
// to build one when the spec is inconsistent.
//
// The laws run at import, so a server with a broken spec does not start and
// answer tools/list with something half-formed.

import * as D from './habr_decls.mjs';

export class SpecError extends Error {}

// A marker struct's prefix says whether the argument is required; its `v` field
// says what JSON type it is. Both are read off the spec, so a marker that is
// not one of these shapes is an error rather than a guess.
const REQUIREDNESS = { Req: true, Opt: false };
const JSON_TYPE = {
  str: { type: 'string' },
  usize: { type: 'integer' },
  bool: { type: 'boolean' },
  strlist: { type: 'array', items: { type: 'string' } },
  obj: { type: 'object' },
};

/** HabrMyComments -> habr_my_comments, articleId -> article_id. One rule, applied to both. */
export const snake = (name) => name.replace(/(?<!^)(?=[A-Z])/g, '_').toLowerCase();

/**
 * The laws, as a function of a declarations module rather than of the one on
 * disk -- so the gate can hand it a deliberately broken spec and watch it
 * refuse. A law that is only ever run against a spec that satisfies it is not
 * known to work.
 */
export function buildSurface(D) {
  const isStruct = (v) => v && typeof v === 'object' && Array.isArray(v.fields);
  const constants = () =>
    Object.fromEntries(
      Object.entries(D).filter(([k, v]) => !k.startsWith('__') && !isStruct(v) && typeof v !== 'function'),
    );
  const consts = constants();
  const order = D.__STRUCT_ORDER__;
  if (!Array.isArray(order)) throw new SpecError('habr_decls.mjs carries no __STRUCT_ORDER__; regenerate it');

  // --- markers, derived from shape rather than from a list kept in step by hand
  const markers = {};
  const toolStructs = [];
  for (const name of order) {
    const s = D[name];
    if (!isStruct(s)) throw new SpecError(`${name}: __STRUCT_ORDER__ names something that is not a struct`);
    if (s.fields.length === 1 && s.fields[0][0] === 'v') {
      const prefix = name.slice(0, 3);
      const vtype = s.fields[0][1];
      if (!(prefix in REQUIREDNESS) || !(vtype in JSON_TYPE)) {
        throw new SpecError(
          `${name}: a one-field \`v\` struct is an argument marker, so its name must start with Req or Opt ` +
            `and \`v\` must be one of ${Object.keys(JSON_TYPE).join(', ')}. Got ${prefix}/${vtype}.`,
        );
      }
      markers[name] = { required: REQUIREDNESS[prefix], json: JSON_TYPE[vtype] };
    } else {
      toolStructs.push(name);
    }
  }
  if (!Object.keys(markers).length) throw new SpecError('the spec declares no argument markers');

  const kinds = D.ToolKind && Object.keys(D.ToolKind);
  if (String(kinds) !== 'read_only,outward') throw new SpecError(`ToolKind must be read_only, outward -- got ${kinds}`);

  const outwardLeft = new Set(D.OUTWARD_TOOLS ?? []);
  const described = new Set(Object.keys(consts).filter((k) => k.endsWith('_DESC')));
  const used = new Set();
  const tools = [];
  const rules = {};

  for (const structName of toolStructs) {
    const tool = snake(structName);
    const SCREAM = tool.toUpperCase();
    const descKey = `${SCREAM}_DESC`;
    if (!(descKey in consts)) throw new SpecError(`tool ${tool}: no ${descKey} in the spec`);
    used.add(descKey);

    const properties = {};
    const required = [];
    const fieldRules = {};

    for (const [field, ftype] of D[structName].fields) {
      const marker = markers[ftype];
      if (!marker) {
        throw new SpecError(
          `${tool}.${field}: type ${ftype} is not a declared argument marker. Declared: ${Object.keys(markers).join(', ')}`,
        );
      }
      const FIELD = snake(field).toUpperCase();
      const fieldDescKey = `${SCREAM}_${FIELD}_DESC`;
      if (!(fieldDescKey in consts)) throw new SpecError(`${tool}.${field}: no ${fieldDescKey} in the spec`);
      used.add(fieldDescKey);

      const prop = { ...marker.json, description: consts[fieldDescKey] };
      const rule = {};

      const minKey = `${SCREAM}_${FIELD}_MIN`;
      if (minKey in consts) {
        if (prop.type !== 'integer') throw new SpecError(`${minKey} bounds ${tool}.${field}, which is not an integer`);
        prop.minimum = consts[minKey];
        rule.minimum = consts[minKey];
        used.add(minKey);
      }
      const valuesKey = `${SCREAM}_${FIELD}_VALUES`;
      if (valuesKey in consts) {
        const values = consts[valuesKey];
        if (!Array.isArray(values) || !values.length) throw new SpecError(`${valuesKey} must be a non-empty array`);
        if (prop.type !== 'string') throw new SpecError(`${valuesKey} closes ${tool}.${field}, which is not a string`);
        prop.enum = values;
        rule.enum = values;
        used.add(valuesKey);
      }

      properties[field] = prop;
      if (marker.required) required.push(field);
      if (Object.keys(rule).length) fieldRules[field] = rule;
    }

    if (outwardLeft.has(tool)) {
      // An outward tool with no gate is a tool that publishes on its first call.
      if (!D[structName].fields.some(([f]) => f === 'confirm')) {
        throw new SpecError(`${tool} is in OUTWARD_TOOLS but has no \`confirm\` argument. An outward tool must be gated.`);
      }
      outwardLeft.delete(tool);
    }

    const inputSchema = { type: 'object', properties };
    if (required.length) inputSchema.required = required;
    tools.push({ name: tool, description: consts[descKey], inputSchema });
    rules[tool] = { required, fields: fieldRules };
  }

  if (outwardLeft.size) throw new SpecError(`OUTWARD_TOOLS names tools that do not exist: ${[...outwardLeft].join(', ')}`);

  const orphans = [...described].filter((d) => !used.has(d));
  if (orphans.length) {
    throw new SpecError(
      `descriptions with nothing to describe: ${orphans.sort().join(', ')}. ` +
        `Every *_DESC must belong to a tool or one of its arguments.`,
    );
  }

  // Non-ASCII in a string literal is mangled by the lexer -- an em dash arrives
  // as three code points -- so it is refused here rather than shipped as
  // mojibake into prose an agent has to read.
  for (const [name, value] of Object.entries(consts)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      // eslint-disable-next-line no-control-regex
      if (typeof item === 'string' && /[^\x00-\x7F]/.test(item)) {
        throw new SpecError(`${name}: non-ASCII in a string literal. The t27 lexer reads bytes as characters and mangles it.`);
      }
    }
  }

  return { tools, rules, outward: new Set(D.OUTWARD_TOOLS ?? []) };
}

const { tools, rules, outward } = buildSurface(D);

/** The raw declarations, so the gate can clone and corrupt them. */
export { D as DECLS };

export const TOOLS = tools;
export const TOOL_NAMES = tools.map((t) => t.name);
export const TOOL_KIND = Object.fromEntries(tools.map((t) => [t.name, outward.has(t.name) ? 'outward' : 'read_only']));

/** Reject a call the schema already forbids, rather than letting Habr answer it with an HTTP error. */
export function validateArgs(name, args) {
  const rule = rules[name];
  if (!rule) return `unknown tool: ${name}`;
  for (const key of rule.required) {
    const v = args[key];
    if (v === undefined || v === null || v === '') return `${key} is required`;
  }
  for (const [field, r] of Object.entries(rule.fields)) {
    const v = args[field];
    if (v === undefined || v === null) continue;
    if (r.enum && !r.enum.includes(String(v))) return `${field} must be one of ${r.enum.join(', ')}, got ${JSON.stringify(v)}`;
    if (r.minimum !== undefined) {
      const n = Number(v);
      if (!Number.isInteger(n) || n < r.minimum) return `${field} must be an integer >= ${r.minimum}, got ${JSON.stringify(v)}`;
    }
  }
  return null;
}

export const {
  MCP_PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_VERSION,
  REQUEST_ORIGIN,
  REQUEST_PATH_PREFIX,
  WRITE_METHODS,
  READ_METHOD,
  USER_AGENT,
  DEFAULT_LANG,
  COOKIE_ENV,
  CSRF_ENV,
  PAGE_MIN,
  ARTICLE_PAGE_WALK_MAX,
  SEARCH_ORDER_DEFAULT,
} = D;
