// Router dashboard configuration. Edit, then reinstall (see the README's "Router dashboard").
window.CONFIG = {
  // The router's tv-status CGI: a read-only JSON endpoint (see routerdash/README.md for the format).
  url: 'http://192.168.1.1/cgi-bin/tv-status',

  // Poll every 5 s; a request that takes longer than 3 s counts as failed.
  interval: 5000,
  timeout: 3000,

  // A tunnel with peers but no handshake for this many seconds is shown red.
  handshakeStale: 180,

  // Tunnel ping results older than this many seconds aren't shown (the router measures every 25-40 s).
  pingStale: 120,

  // Dial-in WireGuard servers: idle is normal, so they're grey instead of red when nobody's connected.
  dialIn: ['wg1'],

  // Throughput history kept for the graph (72 x 5 s = 6 minutes).
  historyPoints: 72,

  // Back opens this app.
  launcher: 'com.gathin.tvhome'
};
