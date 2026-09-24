// Editable email copy, shared by every function that sends mail.
//
// The wording of a client email used to live only in the function that sent it, so changing one
// sentence meant a code edit and a deploy. Now each email declares named SLOTS (a greeting, a lead
// line, a button label, a sign-off) and the words for those slots come from, in order:
//
//   1. public.email_overrides  — what Billy typed in admin, if anything
//   2. portal/email-templates.json — the defaults, deployed with the portal
//   3. the fallback passed in here — so a fetch failure or a bad row can never stop an email
//
// The STRUCTURE stays in code on purpose. A template language that can rebuild the whole email is a
// template language that can break every email, and the parts worth editing are the sentences.
//
// Placeholders are {{snake_case}} and are filled from the vars object. Every value is escaped, and
// so is the slot text itself: slots are prose, not HTML.

const REGISTRY_URL = 'https://portal.webeaze.io/email-templates.json';

type Slots = Record<string, string>;
type Override = { subject?: string | null; slots?: Slots | null };
type Vars = Record<string, string | number | null | undefined>;

let _registry: Record<string, { subject: string; slots: Slots }> | null = null;
let _fetchedAt = 0;
// The digests send one email per client in a loop, so without this the override table is queried
// once per recipient to read the same row. A minute stale is invisible; the next send has it.
const _overrides = new Map<string, { val: Override | null; at: number }>();
const OVERRIDE_TTL = 60 * 1000;

export function escHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

// One fetch per cold start, and never a blocking failure: defaults are already in the fallback.
async function registry(): Promise<Record<string, { subject: string; slots: Slots }>> {
  if (_registry && Date.now() - _fetchedAt < 10 * 60 * 1000) return _registry;
  try {
    // A timeout, because this now sits in front of an invite and a sign-in link, where somebody is
    // watching the portal wait. Three seconds and we send the built-in copy instead.
    const res = await fetch(REGISTRY_URL, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const rows = await res.json();
      const out: Record<string, { subject: string; slots: Slots }> = {};
      for (const r of rows || []) if (r && r.key) out[r.key] = { subject: String(r.subject || ''), slots: r.slots || {} };
      _registry = out;
      _fetchedAt = Date.now();
    }
  } catch (e) {
    console.error('[email-template] registry fetch failed:', e);
  }
  return _registry || {};
}

// esc=false is for the subject line, which is plain text in a mail header: escaping there would
// put a literal &amp; in front of the client.
function fill(text: string, vars: Vars, esc = true): string {
  return String(text || '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_m, name) => {
    const v = vars[name];
    if (v == null) return '';
    return esc ? escHtml(v) : String(v);
  });
}

export interface EmailCopy {
  /** The subject line, placeholders filled. Plain text, never HTML. */
  subject(vars?: Vars): string;
  /** One slot as escaped HTML, placeholders filled. Empty string if the slot was cleared. */
  text(slot: string, vars?: Vars): string;
  /** One slot as <p> blocks, splitting on blank lines and single newlines. */
  paras(slot: string, vars?: Vars, style?: string): string;
  /** True when Billy has edited this email in admin. For logging only. */
  edited: boolean;
}

export async function emailCopy(
  service: any,
  key: string,
  fallback: { subject: string; slots: Slots },
): Promise<EmailCopy> {
  const reg = (await registry())[key];
  let override: Override | null = null;
  const cached = _overrides.get(key);
  if (cached && Date.now() - cached.at < OVERRIDE_TTL) {
    override = cached.val;
  } else {
    try {
      const { data, error } = await service.from('email_overrides').select('subject, slots').eq('key', key).maybeSingle();
      // A read that failed is not "no override": caching that would pin the defaults for a minute
      // for a reason nobody could see, so only a clean read is remembered.
      if (!error) {
        override = data || null;
        _overrides.set(key, { val: override, at: Date.now() });
      }
    } catch (e) {
      console.error('[email-template] override read failed:', e);
    }
  }
  // An empty string is a deliberate "say nothing here", so only null and undefined fall through.
  const pick = (...vals: (string | null | undefined)[]) => vals.find((v) => v != null) ?? '';
  const slots: Slots = { ...fallback.slots, ...(reg?.slots || {}), ...(override?.slots || {}) };
  const subject = pick(override?.subject, reg?.subject, fallback.subject);
  const edited = !!(override && (override.subject != null || (override.slots && Object.keys(override.slots).length)));

  return {
    edited,
    subject: (vars = {}) => fill(subject, vars, false).replace(/\s+/g, ' ').trim(),
    text: (slot, vars = {}) => fill(escHtml(slots[slot] ?? ''), vars),
    paras(slot, vars = {}, style = 'margin:0 0 16px;') {
      const body = fill(escHtml(slots[slot] ?? ''), vars).trim();
      if (!body) return '';
      return body.split(/\n+/).map((line) => '<p style="' + style + '">' + line.trim() + '</p>').join('');
    },
  };
}
