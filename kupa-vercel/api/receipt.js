'use strict';
const S = require('../lib/store');

module.exports = S.route(['POST'], async (req, res) => {
  S.requireAuth(req);
  const buf = await S.readRaw(req, S.MAX_IMAGE);
  if (buf.length < 100 || !(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) {
    throw S.httpErr(400, 'not_jpeg');
  }
  const url = await S.putReceipt(buf);
  return res.status(201).json({ url });
});
