const {
  computeFreeWindows,
  fetchTodayEvents,
  getCalendarIntegration,
  getValidCalendarSessions,
  toIsoDate,
} = require('./calendar/_lib');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const integration = await getCalendarIntegration();
    if (!integration.connections.length) {
      return res.status(200).json({
        connected: false,
        date: toIsoDate(new Date()),
        events: [],
        freeWindows: [],
        connections: [],
        connectedCount: 0,
        message: 'Google Calendar is not connected yet',
      });
    }

    const sessionState = await getValidCalendarSessions();
    if (!sessionState.connected) {
      return res.status(200).json({
        connected: false,
        date: toIsoDate(new Date()),
        events: [],
        freeWindows: [],
        connections: integration.connections.map(connection => ({
          id: connection.id,
          email: connection.email,
          displayName: connection.displayName,
        })),
        connectedCount: integration.connections.length,
        message: sessionState.reason || 'Google Calendar is not connected',
      });
    }

    const eventGroups = await Promise.all(
      sessionState.sessions.map(session => fetchTodayEvents(session.accessToken, session.connection))
    );
    const events = eventGroups
      .flat()
      .sort((a, b) => new Date(a.start || 0).getTime() - new Date(b.start || 0).getTime());
    const freeWindows = computeFreeWindows(events);

    return res.status(200).json({
      connected: true,
      date: toIsoDate(new Date()),
      events,
      freeWindows,
      connections: sessionState.integration.connections.map(connection => ({
        id: connection.id,
        email: connection.email,
        displayName: connection.displayName,
      })),
      connectedCount: sessionState.sessions.length,
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to fetch calendar data',
      detail: error.message,
    });
  }
};
