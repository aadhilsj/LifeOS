const { buildGoogleAuthUrl } = require('./_lib');

function inferRequestOrigin(req) {
  const protoHeader = req.headers['x-forwarded-proto'] || req.headers['x-forwarded-protocol'];
  const hostHeader = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = Array.isArray(protoHeader) ? protoHeader[0] : String(protoHeader || 'https').split(',')[0].trim();
  const host = Array.isArray(hostHeader) ? hostHeader[0] : String(hostHeader || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const returnOrigin = req.query?.returnOrigin || inferRequestOrigin(req);
    const authUrl = buildGoogleAuthUrl(req.query?.userId || '', returnOrigin);
    return res.redirect(authUrl);
  } catch (error) {
    return res.status(500).json({
      error: 'Calendar auth configuration is incomplete',
      detail: error.message,
    });
  }
};
