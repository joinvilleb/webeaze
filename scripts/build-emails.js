#!/usr/bin/env node
/*
 * build-emails.js — check emails/templates.json and copy it to portal/email-templates.json.
 *
 * WHY A COPY: the registry has to be readable by two things that cannot read the repo — the admin
 * page in a browser, and the edge functions that send the mail. Both can read the portal's own
 * origin, the way chat-assist already reads help-content.json. portal/ is gitignored, so the file
 * that lives in git is emails/templates.json and this copies it out.
 *
 *   node scripts/build-emails.js           write portal/email-templates.json
 *   node scripts/build-emails.js --check   write nothing, exit 1 if it would change
 *
 * Run it after editing the defaults, then deploy the portal.
 */
const fs = require('fs'), path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'emails', 'templates.json');
const OUT = path.join(ROOT, 'portal', 'email-templates.json');
const CHECK = process.argv.includes('--check');

let rows;
try {
  rows = JSON.parse(fs.readFileSync(SRC, 'utf8'));
} catch (e) {
  console.error('emails/templates.json is not valid JSON:', e.message);
  process.exit(1);
}
if (!Array.isArray(rows)) { console.error('expected an array'); process.exit(1); }

const problems = [];
const seen = new Set();
for (const r of rows) {
  const at = r && r.key ? r.key : JSON.stringify(r).slice(0, 40);
  if (!r || !r.key) { problems.push(at + ': no key'); continue; }
  if (seen.has(r.key)) problems.push(r.key + ': duplicate key');
  seen.add(r.key);
  for (const f of ['name', 'audience', 'when', 'sentBy']) if (!r[f]) problems.push(r.key + ': missing ' + f);
  if (r.audience && !['client', 'you'].includes(r.audience)) problems.push(r.key + ': audience must be client or you');
  if (!r.editable) continue;
  if (!r.subject) problems.push(r.key + ': editable, so it needs a subject');
  if (!r.slots || !Object.keys(r.slots).length) problems.push(r.key + ': editable, so it needs slots');
  // Every placeholder has to be declared, or the editor offers a variable that renders as nothing.
  const declared = new Set(Object.keys(r.vars || {}));
  const used = new Set();
  const scan = (s) => String(s || '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_m, n) => used.add(n.toLowerCase()));
  scan(r.subject);
  Object.values(r.slots || {}).forEach(scan);
  for (const v of used) if (!declared.has(v)) problems.push(r.key + ': uses {{' + v + '}}, which is not in vars');
}
if (problems.length) {
  console.error('emails/templates.json:');
  problems.forEach(p => console.error('  ' + p));
  process.exit(1);
}

const body = JSON.stringify(rows);
const before = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
if (CHECK) {
  if (before !== body) { console.error('portal/email-templates.json is out of date. Run: node scripts/build-emails.js'); process.exit(1); }
  console.log('up to date: ' + rows.length + ' emails');
  process.exit(0);
}
fs.writeFileSync(OUT, body);
const editable = rows.filter(r => r.editable).length;
console.log('wrote portal/email-templates.json — ' + rows.length + ' emails, ' + editable + ' editable' + (before === body ? ' (unchanged)' : ''));
