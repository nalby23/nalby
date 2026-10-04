'use strict';
const S = require('../lib/store');

module.exports = S.route(['POST'], async (req, res) => {
  const body = S.readJson(req);
  if (!S.checkPassword(body.password)) {
    await S.sleep(800);
    throw S.httpErr(401, 'wrong_password');
  }
  return res.status(200).json({ token: S.makeToken() });
});
