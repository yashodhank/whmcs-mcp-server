/* eslint-disable no-console -- one-off CLI probe; stdout IS the output */
/**
 * SPIKE — dev WHMCS9 only — probes UpdateClientProduct field-name shape.
 *
 * No mutation: we deliberately send an INVALID serviceid so WHMCS rejects
 * before mutating, but the error message reveals which param names it
 * recognises (`recurringamount` vs `amount`).
 *
 * Run:
 *   set -a; . ./.env.local; set +a
 *   npx tsx scripts/price-restore-spike.ts
 */

interface ProbeResult {
  field: 'recurringamount' | 'amount';
  message: string;
}

async function probe(field: 'recurringamount' | 'amount'): Promise<ProbeResult> {
  const url = process.env.WHMCS_API_URL ?? 'http://localhost:8890';
  const identifier = process.env.WHMCS_IDENTIFIER ?? '';
  const secret = process.env.WHMCS_SECRET ?? '';
  const body = new URLSearchParams({
    identifier,
    secret,
    action: 'UpdateClientProduct',
    responsetype: 'json',
    serviceid: '0',
    [field]: '1.00',
  });
  const res = await fetch(`${url}/includes/api.php`, { method: 'POST', body });
  const text = await res.text();
  return { field, message: text.slice(0, 400) };
}

const r1 = await probe('recurringamount');
const r2 = await probe('amount');
console.log('=== UpdateClientProduct probe ===');
console.log('with recurringamount:', r1.message);
console.log('with amount:        :', r2.message);
console.log();
console.log('Interpretation:');
console.log('  "Invalid API Action" → action not exposed; STOP/escalate');
console.log('  "Service ID not found" / "Invalid serviceid" → field name is honored');
console.log('  "Missing required field <X>" → field <X> is the canonical name');
