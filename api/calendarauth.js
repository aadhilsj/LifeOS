const { buildGoogleAuthUrl } = require('./_lib');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const authUrl = buildGoogleAuthUrl();
    return res.redirect(authUrl);
  } catch (error) {
    return res.status(500).json({
      error: 'Calendar auth configuration is incomplete',
      detail: error.message,
    });
  }
};
