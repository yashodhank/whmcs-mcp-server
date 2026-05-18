// Structural digest of stdin JSON for root-cause analysis.
// Prints key → type/shape, array lengths, scalars; truncates strings to
// 48 chars; masks secret-ish keys; depth-limited. We want SHAPE not data.
let s = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (s += d));
process.stdin.on('end', () => {
  const i = s.indexOf('{');
  if (i < 0) { console.log('NON-JSON:', s.slice(0, 300)); return; }
  let o; try { o = JSON.parse(s.slice(i)); } catch (e) { console.log('PARSE-FAIL:', s.slice(0, 300)); return; }
  const SEC = /(secret|password|token|identifier|apikey|api_key|privatekey|accesshash|smtppass|authdata|credential)/i;
  const digest = (v, depth, key) => {
    if (SEC.test(key || '')) return '‹masked›';
    if (v === null) return 'null';
    if (Array.isArray(v)) return `Array[${v.length}]` + (v.length && depth < 4 ? ` of ${digest(v[0], depth + 1, key)}` : '');
    if (typeof v === 'object') {
      if (depth >= 4) return '{…}';
      const ks = Object.keys(v);
      return '{ ' + ks.map((k) => `${k}: ${digest(v[k], depth + 1, k)}`).join(', ') + ' }';
    }
    if (typeof v === 'string') return JSON.stringify(v.length > 48 ? v.slice(0, 48) + '…' : v);
    return String(v); // number/bool
  };
  console.log(digest(o, 0, ''));
});
