'use strict';
const S = require('../lib/store');

module.exports = S.route(['GET', 'POST', 'PATCH', 'DELETE'], async (req, res) => {
  if (req.method === 'GET') {
    const entries = await S.listEntries();
    return res.status(200).json({ entries });
  }

  S.requireAuth(req);

  if (req.method === 'POST') {
    const entry = S.cleanEntry(S.readJson(req));
    await S.saveEntry(entry);
    return res.status(201).json({ entry });
  }

  const id = S.cleanId(req.query && req.query.id);
  const existing = await S.getEntry(id);
  if (!existing) throw S.httpErr(404, 'not_found');

  if (req.method === 'DELETE') {
    await S.removeEntry(id);
    if (existing.receipt) await S.deleteBlob(existing.receipt);
    return res.status(200).json({ ok: true });
  }

  /* PATCH: replace or clear the receipt of an expense */
  if (existing.kind !== 'expense') throw S.httpErr(400, 'not_expense');
  const body = S.readJson(req);
  const next = body.receipt ? S.validReceipt(body.receipt) : null;
  if (body.receipt && !next) throw S.httpErr(400, 'bad_receipt');
  const old = existing.receipt;
  existing.receipt = next;
  await S.saveEntry(existing);
  if (old && old !== next) await S.deleteBlob(old);
  return res.status(200).json({ entry: existing });
});
