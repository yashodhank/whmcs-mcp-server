// Reads JSON on stdin, enforces the user's prod PII/secret rules, prints
// redacted JSON. ALLOWED through: names, emails, domains, invoice/ticket
// numbers, subjects, statuses, amounts, dates, IDs. WITHHELD: secrets,
// full addresses, full phone numbers, custom fields, message bodies,
// internal notes (unless explicitly requested later).
let s = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (s += d));
process.stdin.on('end', () => {
  const head = s.slice(0, s.indexOf('{') >= 0 ? s.indexOf('{') : 0);
  const jsonStart = s.indexOf('{');
  if (jsonStart < 0) { process.stdout.write(s); return; }
  if (head.trim()) process.stdout.write(head);
  let obj;
  try { obj = JSON.parse(s.slice(jsonStart)); }
  catch { process.stdout.write(s.slice(jsonStart)); return; }

  const SECRET = /(secret|password|passwd|token|identifier|apikey|api_key|privatekey|private_key|accesshash|smtppass|authdata|sessionkey|auth_header|authorization|credentials?)/i;
  // REDACT_MODE=secrets-only → PII passes through; secret-keyed fields are
  // STILL masked (user's Forbidden list + stop-on-secret rule are unchanged).
  const PII = (process.env.REDACT_MODE || 'full') !== 'secrets-only';
  const maskPhone = (v) => {
    const str = String(v);
    return str.length <= 3 ? '‹phone withheld›' : `‹phone …${str.slice(-2)}›`;
  };
  const walk = (v, key) => {
    if (v === null || v === undefined) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (typeof v === 'object') {
      const o = {};
      for (const [k, val] of Object.entries(v)) {
        if (SECRET.test(k)) { o[k] = '‹redacted-secret›'; continue; }
        if (PII && /^(address1|address2|address|street)$/i.test(k)) { o[k] = '‹address withheld›'; continue; }
        if (PII && /phone/i.test(k)) { o[k] = maskPhone(val); continue; }
        if (PII && /^custom_fields$/i.test(k)) { o[k] = `‹${Array.isArray(val) ? val.length : 'n'} custom field(s) withheld›`; continue; }
        if (PII && /^(message|initial_message)$/i.test(k) && typeof val === 'string') {
          o[k] = `‹message body withheld (${val.length} chars) — ask to reveal›`; continue;
        }
        if (PII && /^(internal_notes|notes)$/i.test(k)) {
          o[k] = Array.isArray(val) ? `‹${val.length} internal note(s) withheld — ask to reveal›` : '‹withheld›';
          continue;
        }
        o[k] = walk(val, k);
      }
      return o;
    }
    if (typeof v === 'string' && SECRET.test(key || '')) return '‹redacted-secret›';
    return v;
  };
  process.stdout.write(JSON.stringify(walk(obj), null, 2) + '\n');
});
