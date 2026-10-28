/*
 * Router dashboard: polls the router's read-only tv-status CGI (JSON, v1) and shows WAN, CPU, memory,
 * connections, throughput, Tailscale and each WireGuard tunnel. Green / amber / red stripes mark state;
 * grey means "not applicable here" (a secondary gateway runs no tunnels, no WAN6 and no DHCP).
 */
(function () {
  'use strict';

  var KEY = { BACK: 461, ESC: 27 };
  var STALE_AFTER = 3;          // missed polls before the whole screen dims
  var $ = function (id) { return document.getElementById(id); };

  var last = null;              // previous good sample, for rates
  var lastOk = 0;               // Date.now() of the last good poll
  var history = [];             // WAN: [{down, up}] bytes per second
  var wgHistory = {};           // the same per tunnel, by name
  var timer = null;
  var busy = false;             // a request is in flight: never run two at once
  var failure = null;           // why the last poll failed: 'timeout' | 'refused' | 'bad'

  // ---- formatting ----------------------------------------------------------------------------

  function duration(s) {
    if (s === null || s === undefined) return '-';
    var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + m + 'm';
    if (m) return m + 'm';
    return Math.floor(s) + 's';
  }

  function bytes(n) {
    if (n === null || n === undefined) return '-';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i && n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
  }

  function rate(bps) {
    if (bps === null || bps === undefined) return '-';
    var bits = bps * 8, u = ['bps', 'Kbps', 'Mbps', 'Gbps'], i = 0;
    while (bits >= 1000 && i < u.length - 1) { bits /= 1000; i++; }
    return (i && bits < 10 ? bits.toFixed(1) : Math.round(bits)) + ' ' + u[i];
  }

  function num(n) { return n === null || n === undefined ? '-' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  /** Fills a card: state is 'ok' | 'warn' | 'bad' | 'na' | ''. */
  function card(id, state, value, sub) {
    var el = $(id);
    el.className = 'card' + (state ? ' ' + state : '');
    el.querySelector('.value').textContent = value;
    el.querySelector('.sub').textContent = sub || '';
  }

  // ---- rendering -----------------------------------------------------------------------------

  /** " · 23 ms" (plus loss) for a fresh ping result, else "". The router measures; ts is its clock. */
  function pingText(ms, loss, pingTs, now) {
    if (typeof ms !== 'number' || !pingTs || now - pingTs > CONFIG.pingStale) return '';
    return ' · ' + Math.round(ms) + ' ms' + (loss ? ' ' + Math.round(loss) + '% loss' : '');
  }

  function renderLink(id, link, addr, ping) {
    if (!link) { card(id, 'na', 'N/A', 'not on this gateway'); return; }
    if (!link.up) { card(id, 'bad', 'Down', ''); return; }
    // An uptime that keeps resetting means the link is flapping.
    card(id, link.uptime < 300 ? 'warn' : 'ok', 'Up', 'for ' + duration(link.uptime) + (ping || '') + (addr ? ' · ' + addr : ''));
  }

  function render(d) {
    $('host').textContent = d.host || 'Router';
    $('role').textContent = d.role === 'main' ? 'Main gateway' : d.role === 'sub' ? 'Secondary' : '';
    var sub = d.role === 'sub';

    var wp = (d.ping || []).filter(function (p) { return p.iface === 'wan'; })[0];
    renderLink('cWan', d.wan, d.wan && d.wan.ipv4_masked, wp && pingText(wp.ms, wp.loss, wp.ping_ts, d.ts));
    renderLink('cWan6', d.wan6, d.wan6 && d.wan6.ipv6_masked);

    var load = d.load || [];
    var temp = d.cpu_temp_c;
    card('cCpu', temp > 85 ? 'bad' : temp > 75 ? 'warn' : 'ok',
      load.length ? load[0].toFixed(2) : '-',
      (temp !== null && temp !== undefined ? Math.round(temp) + '°C · ' : '') + 'load 5m ' + (load[1] !== undefined ? load[1].toFixed(2) : '-'));

    if (d.mem_total && d.mem_available !== null) {
      var free = d.mem_available;
      card('cMem', free < 25 * 1048576 ? 'bad' : free < 50 * 1048576 ? 'warn' : 'ok',
        Math.round((1 - free / d.mem_total) * 100) + '%', bytes(free) + ' free of ' + bytes(d.mem_total));
    } else card('cMem', '', '-', '');

    var ct = d.conntrack || {};
    var full = ct.max ? ct.count / ct.max : 0;
    card('cConn', full > 0.9 ? 'bad' : full > 0.7 ? 'warn' : 'ok', num(ct.count), 'of ' + num(ct.max));

    if (d.dhcp_clients === null || d.dhcp_clients === undefined) card('cDhcp', 'na', 'N/A', sub ? 'not on this gateway' : '');
    else card('cDhcp', 'ok', num(d.dhcp_clients), 'leases');

    var ts = d.tailscale;
    if (!ts) card('cTs', 'na', 'N/A', '');
    else card('cTs', ts.online ? 'ok' : 'bad', ts.online ? 'Online' : (ts.state || 'Offline'),
      num(ts.peers_online) + ' of ' + num(ts.peers_total) + ' peers online');

    renderWg(d, sub);
    renderRates(d);
  }

  /** Adds a {down, up} bytes/s sample from two counter readings; counters reset when an interface is
   *  recreated, so a negative difference drops the sample. */
  function addRate(hist, rx, tx, prx, ptx, dt) {
    if (!(dt > 0) || rx === null || rx === undefined || prx === null || prx === undefined) return;
    var down = (rx - prx) / dt, up = (tx - ptx) / dt;
    if (down < 0 || up < 0) return;
    hist.push({ down: down, up: up });
    if (hist.length > CONFIG.historyPoints) hist.shift();
  }

  function renderWg(d, sub) {
    var list = d.wg || [], prev = {};
    if (last && last.wg) last.wg.forEach(function (w) { prev[w.name] = w; });
    list.forEach(function (w) {
      var p = prev[w.name], hist = wgHistory[w.name] || (wgHistory[w.name] = []);
      if (p) addRate(hist, w.rx_bytes, w.tx_bytes, p.rx_bytes, p.tx_bytes, d.ts - last.ts);
    });

    // One scale for every tunnel, so the bars and graphs compare directly: graphs against the peak
    // of any tunnel in the history, bars against the busiest tunnel right now.
    var max = 1, busiest = 1;
    list.forEach(function (w) {
      var hist = wgHistory[w.name], h = hist[hist.length - 1];
      hist.forEach(function (p) { max = Math.max(max, p.down, p.up); });
      if (h) busiest = Math.max(busiest, h.down + h.up);
    });

    var box = $('wg');
    while (box.children.length > list.length) box.removeChild(box.lastChild);
    list.forEach(function (w, i) {
      var el = box.children[i];
      if (!el) {
        el = document.createElement('div');
        el.innerHTML = '<div class="name"></div><div class="state"></div>' +
          '<div class="wgRates"><span class="down"></span><span class="up"></span></div>' +
          '<div class="share"><i class="down"></i><i class="up"></i></div>' +
          '<canvas width="280" height="36"></canvas>' +
          '<div class="small"></div>';
        box.appendChild(el);
      }
      var state, text;
      var dialIn = (CONFIG.dialIn || []).indexOf(w.name) >= 0;
      var stale = w.handshake_age === null || w.handshake_age > CONFIG.handshakeStale;
      if (!w.up) { state = sub ? 'na' : 'bad'; text = sub ? 'N/A' : 'Down'; }
      else if (dialIn) { state = w.peers_active ? 'ok' : 'na'; text = w.peers_active ? w.peers_active + ' connected' : 'Standby'; }
      else if (w.peers > 0 && stale) { state = 'bad'; text = 'No handshake'; }
      else { state = 'ok'; text = 'Up'; }
      if (w.up && w.handshake_age !== null && w.handshake_age !== undefined) text += ' · ' + duration(w.handshake_age);
      // Ping comes from the router's own tunnel check, so only some tunnels have it.
      if (w.up) text += pingText(w.ping_ms, w.ping_loss, w.ping_ts, d.ts);

      var hist = wgHistory[w.name], h = hist[hist.length - 1];
      el.className = 'card ' + state;
      el.querySelector('.name').textContent = w.name;
      el.querySelector('.state').textContent = text;
      el.querySelector('.wgRates .down').textContent = '↓ ' + (h ? rate(h.down) : '-');
      el.querySelector('.wgRates .up').textContent = '↑ ' + (h ? rate(h.up) : '-');
      el.querySelector('.share .down').style.width = (h ? h.down / busiest * 100 : 0) + '%';
      el.querySelector('.share .up').style.width = (h ? h.up / busiest * 100 : 0) + '%';
      el.querySelector('.small').textContent = w.up ? 'total ↓ ' + bytes(w.rx_bytes) + '  ↑ ' + bytes(w.tx_bytes) : '';
      drawLines(el.querySelector('canvas'), hist, max, 3);
    });
  }

  function renderRates(d) {
    $('wanDev').textContent = d.wan_dev || '';
    if (last) addRate(history, d.wan_rx_bytes, d.wan_tx_bytes, last.wan_rx_bytes, last.wan_tx_bytes, d.ts - last.ts);
    var h = history[history.length - 1];
    $('rateDown').textContent = '↓ ' + (h ? rate(h.down) : '-');
    $('rateUp').textContent = '↑ ' + (h ? rate(h.up) : '-');
    var max = 1;
    history.forEach(function (p) { max = Math.max(max, p.down, p.up); });
    var c = $('graph'), g = c.getContext('2d');
    drawLines(c, history, max, 4);
    g.fillStyle = 'rgba(255,255,255,0.4)';
    g.font = '20px sans-serif';
    g.fillText(rate(max), 8, 24);
  }

  /** Down and up lines, newest at the right edge, scaled to max; horizontal grid lines behind. */
  function drawLines(c, hist, max, lineWidth) {
    var g = c.getContext('2d'), w = c.width, h = c.height;
    g.clearRect(0, 0, w, h);
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.lineWidth = 2;
    for (var y = 0; y <= 4; y++) { g.beginPath(); g.moveTo(0, 1 + y * (h - 2) / 4); g.lineTo(w, 1 + y * (h - 2) / 4); g.stroke(); }
    if (hist.length < 2) return;
    var step = w / (CONFIG.historyPoints - 1), x0 = w - (hist.length - 1) * step;
    [['down', '#64d2ff'], ['up', '#bf5af2']].forEach(function (s) {
      g.beginPath();
      hist.forEach(function (p, i) {
        var x = x0 + i * step, y = h - 2 - p[s[0]] / max * (h - 4 - lineWidth);
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      });
      g.strokeStyle = s[1];
      g.lineWidth = lineWidth;
      g.stroke();
    });
  }

  // ---- polling -------------------------------------------------------------------------------

  function poll() {
    timer = null;
    busy = true;
    var x = new XMLHttpRequest(), done = false;
    function finish() {
      if (done) return;
      done = true;
      busy = false;
      updateStatus();
      if (!document.hidden) timer = setTimeout(poll, CONFIG.interval);
    }
    x.open('GET', CONFIG.url + (CONFIG.url.indexOf('?') < 0 ? '?' : '&') + '_=' + Date.now());
    x.timeout = CONFIG.timeout;
    x.onload = function () {
      var d = null;
      try { if (x.status === 200) d = JSON.parse(x.responseText); } catch (e) { d = null; }
      if (d) {
        render(d);
        last = d;
        lastOk = Date.now();
      }
      failure = d ? null : 'bad';
      finish();
    };
    // A 404 from a gateway without tv-status carries no CORS header, so the browser reports it as a
    // plain error (status 0) and the code is unreadable. A quick error therefore means "the router
    // answered but tv-status isn't available"; no answer at all ends in a timeout.
    x.onerror = function () { failure = 'refused'; finish(); };
    x.ontimeout = function () { failure = 'timeout'; finish(); };
    x.send();
  }

  function updateStatus() {
    var age = lastOk ? (Date.now() - lastOk) / 1000 : null;
    var stale = age === null || age > CONFIG.interval / 1000 * STALE_AFTER;
    document.body.classList.toggle('stale', stale);
    var s = $('status');
    s.className = stale ? 'bad' : '';
    var host = CONFIG.url.split('/')[2];
    var why = failure === 'refused' ? 'tv-status not available on ' + host + ' (not deployed on this gateway?)'
      : failure === 'bad' ? 'Bad answer from ' + host : "Can't reach " + host;
    s.textContent = !stale ? '' : age === null ? why : why + ' · no data for ' + duration(age);
  }

  function updateClock() {
    var d = new Date();
    $('clock').textContent = d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  // ---- keys and lifecycle --------------------------------------------------------------------

  function goHome() {
    try {
      var b = new PalmServiceBridge();
      b.call('luna://com.webos.applicationManager/launch', JSON.stringify({ id: CONFIG.launcher }));
      goHome.bridge = b;   // keep a reference until the call goes out
    } catch (e) { /* not on a TV */ }
  }

  document.addEventListener('keydown', function (e) {
    if (e.keyCode === KEY.BACK || e.keyCode === KEY.ESC) { e.preventDefault(); goHome(); }
  });

  // Stop polling while another app is in front; poll right away on return.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { clearTimeout(timer); timer = null; }
    else if (!timer && !busy) poll();
  });

  updateClock();
  setInterval(updateClock, 10000);
  setInterval(updateStatus, 1000);
  poll();
})();
