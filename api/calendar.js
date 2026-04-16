const {
  computeFreeWindows,
  fetchTodayEvents,
  getCalendarIntegration,
  getValidCalendarSession,
  toIsoDate,
} = require('./calendar/_lib');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const integration = await getCalendarIntegration();
    if (!integration?.refreshToken) {
      return res.status(200).json({
        connected: false,
        date: toIsoDate(new Date()),
        events: [],
        freeWindows: [],
        message: 'Google Calendar is not connected yet',
      });
    }

    const session = await getValidCalendarSession();
    if (!session.connected) {
      return res.status(200).json({
        connected: false,
        date: toIsoDate(new Date()),
        events: [],
        freeWindows: [],
        message: session.reason || 'Google Calendar is not connected',
      });
    }

    const events = await fetchTodayEvents(session.accessToken);
    const freeWindows = computeFreeWindows(events);

    return res.status(200).json({
      connected: true,
      date: toIsoDate(new Date()),
      events,
      freeWindows,
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to fetch calendar data',
      detail: error.message,
    });
  }
};
