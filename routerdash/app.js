/*
 * Router dashboard: polls the router's read-only tv-status CGI (JSON, v1) and shows WAN, CPU, memory,
 * connections, throughput, ports, Wi-Fi and each WireGuard tunnel. The bar on each card rises and turns from
 * green to red with load (CPU per core, memory, connections, traffic against qosify's limits) or poor
 * health. Grey means "not applicable here": a secondary gateway runs no tunnels, no WAN6 and no DHCP.
 */
(function () {
  'use strict';

  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, OK: 13, BACK: 461, ESC: 27 };
  var TOKEN = window.TV_TOKEN || '';   // from token.js (gitignored); unlocks the route editor
  var gasUrl = null;                   // the route editor's Apps Script URL, handed out by tv-status for the token
  var STALE_AFTER = 3;          // missed polls before the whole screen dims
  var $ = function (id) { return document.getElementById(id); };

  var last = null;              // previous good sample, for rates
  var lastOk = 0;               // Date.now() of the last good poll
  var history = [];             // WAN: [{down, up}] bytes per second
  var wgHistory = {};           // the same per tunnel, by name
  var cpuPct = null;            // last CPU usage % the router reported
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

  function clamp(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

  /**
   * The bar on a card's left edge: it fills from the bottom to level (0..1, how loaded or unhealthy)
   * and turns from green to red as it rises: green up to 40 %, red at 100 %. A warn or bad state lifts
   * it to at least amber or full red. With no level the bar is full, in the state's colour.
   */
  /** Green up to a level of 0.4, then through amber to red at 1. */
  function levelHue(l) { return 135 * (1 - clamp((l - 0.4) / 0.6)); }

  /** Text colour for a ping on the bars' scale: green when normal, amber to red as it gets worse. */
  function pingColor(level) { return 'hsl(' + Math.round(levelHue(clamp(level))) + ', 80%, 60%)'; }

  function gauge(el, state, level) {
    var l, hue;
    var noData = level === null || level === undefined || isNaN(level);
    // Nothing measured and nothing wrong: an empty track with a dot, so a full green bar always means
    // a real, high reading. Down or warning still fills the bar, as an alarm.
    el.classList.toggle('nodata', noData && state !== 'bad' && state !== 'warn');
    if (noData) {
      l = 1;
      hue = state === 'bad' ? 0 : state === 'warn' ? 35 : 135;
    } else {
      l = clamp(level);
      if (state === 'warn') l = Math.max(l, 0.75);
      if (state === 'bad') l = 1;
      hue = levelHue(l);
    }
    el.style.setProperty('--lvl', l);
    el.style.setProperty('--c', state === 'na' || state === '' ? 'rgba(255,255,255,0.2)' : 'hsl(' + Math.round(hue) + ', 75%, 50%)');
  }

  /** How unhealthy a ping is: pingBad ms or 50 % loss is the full bar. Null when there's no ping. */
  function pingLevel(ms, loss, pingTs, now) {
    if (typeof ms !== 'number' || !pingTs || now - pingTs > CONFIG.pingStale) return null;
    return Math.max(ms / CONFIG.pingBad, (loss || 0) / 50);
  }

  /** How much of qosify's configured bandwidth a {down, up} rate uses, by interface name; null when
   *  qosify sets no limit for it. */
  function trafficLevel(d, iface, h) {
    var q = (d.qosify || []).filter(function (x) { return x.iface === iface; })[0];
    if (!q || !h) return null;
    return Math.max(q.down_bps ? h.down * 8 / q.down_bps : 0, q.up_bps ? h.up * 8 / q.up_bps : 0);
  }

  /** The larger of two levels, either of which may be null. */
  function worst(a, b) { return a === null || a === undefined ? b : b === null || b === undefined ? a : Math.max(a, b); }

  /** Fills a card: state is 'ok' | 'warn' | 'bad' | 'na' | ''; level drives the bar (see gauge). */
  function card(id, state, value, sub, level) {
    var el = $(id);
    el.className = 'card' + (state ? ' ' + state : '');
    gauge(el, state, level);
    el.querySelector('.value').textContent = value;
    el.querySelector('.sub').textContent = sub || '';
  }

  // ---- rendering -----------------------------------------------------------------------------

  /** " · 23 ms" (plus loss) for a fresh ping result, else "". The router measures; ts is its clock. */
  function pingText(ms, loss, pingTs, now) {
    if (typeof ms !== 'number' || !pingTs || now - pingTs > CONFIG.pingStale) return '';
    return ' · ' + Math.round(ms) + ' ms' + (loss ? ' ' + Math.round(loss) + '% loss' : '');
  }

  function renderLink(id, link, addr, ping, level) {
    if (!link) { card(id, 'na', 'N/A', 'not on this gateway'); return; }
    if (!link.up) { card(id, 'bad', 'Down', ''); return; }
    // An uptime that keeps resetting means the link is flapping.
    card(id, link.uptime < 300 ? 'warn' : 'ok', 'Up', '', level);
    // Subtitle: uptime, the ping in its health colour, then the masked address.
    var sub = $(id).querySelector('.sub'), p = document.createElement('span');
    sub.textContent = 'for ' + duration(link.uptime);
    if (ping) {
      p.textContent = ping.replace(/^ · /, '');
      p.style.color = pingColor(level);
      sub.appendChild(document.createTextNode(' · '));
      sub.appendChild(p);
    }
    if (addr) sub.appendChild(document.createTextNode(' · ' + addr));
  }

  function render(d) {
    if (d.gas_url) gasUrl = d.gas_url;
    $('host').textContent = d.host || 'Router';
    $('role').textContent = d.role === 'main' ? 'Main gateway' : d.role === 'sub' ? 'Secondary' : '';
    var sub = d.role === 'sub';

    var wp = (d.ping || []).filter(function (p) { return p.iface === 'wan'; })[0];
    renderLink('cWan', d.wan, d.wan && d.wan.ipv4_masked, wp && pingText(wp.ms, wp.loss, wp.ping_ts, d.ts),
      wp && pingLevel(wp.ms, wp.loss, wp.ping_ts, d.ts));
    renderLink('cWan6', d.wan6, d.wan6 && d.wan6.ipv6_masked);

    var load = d.load || [];
    var temp = d.cpu_temp_c;
    // Load average (runnable processes, not a usage %); 1, 5 and 15 minutes side by side show the trend.
    var loads = ['1m', '5m', '15m'].map(function (m, i) {
      return m + ' ' + (typeof load[i] === 'number' ? load[i].toFixed(2) : '-');
    }).join(' · ');
    $('cpuInfo').textContent = (d.cpus ? d.cpus + ' cores' : '') +
      (temp !== null && temp !== undefined ? (d.cpus ? ' · ' : '') + Math.round(temp) + '°C' : '');
    // cpu_pct is usage since the router's previous call (it diffs /proc/stat snapshots), already per
    // machine, not per core. The first call after a pause has no snapshot yet and gives null: keep the
    // last number shown, "--" until there is one.
    if (typeof d.cpu_pct === 'number') cpuPct = d.cpu_pct;
    // The bar is the usage %, like the big number; empty and grey until the first figure. Heat only
    // shows through the state (amber over 75 °C, red over 85 °C).
    var hot = temp > 85 ? 'bad' : temp > 75 ? 'warn' : 'ok';
    card('cCpu', hot, cpuPct !== null ? Math.round(cpuPct) + '%' : '--', loads, cpuPct !== null ? cpuPct / 100 : 0);
    if (cpuPct === null && hot === 'ok') gauge($('cCpu'), '', 0);

    $('memTotal').textContent = d.mem_total ? bytes(d.mem_total) : '';
    if (d.mem_total && d.mem_available !== null) {
      var free = d.mem_available;
      card('cMem', free < 25 * 1048576 ? 'bad' : free < 50 * 1048576 ? 'warn' : 'ok',
        Math.round((1 - free / d.mem_total) * 100) + '%', bytes(free) + ' free', 1 - free / d.mem_total);
    } else card('cMem', '', '-', '');

    var ct = d.conntrack || {};
    var full = ct.max ? ct.count / ct.max : 0;
    card('cConn', full > 0.9 ? 'bad' : full > 0.7 ? 'warn' : 'ok', num(ct.count), 'of ' + num(ct.max), full);

    if (d.dhcp_clients === null || d.dhcp_clients === undefined) card('cDhcp', 'na', 'N/A', sub ? 'not on this gateway' : '');
    else card('cDhcp', 'ok', num(d.dhcp_clients), 'leases');

    renderPorts(d);
    renderWifi(d);
    renderTop(d);
    renderWg(d, sub);
    renderRates(d);
  }

  /** Reuses a list card's rows: one <div class="row"> per item, built by fill(row, item). */
  function renderRows(id, items, empty, fill) {
    var box = $(id).querySelector('.rows');
    if (!items || !items.length) { box.innerHTML = '<div class="empty">' + empty + '</div>'; return; }
    if (box.querySelector('.empty')) box.innerHTML = '';
    while (box.children.length > items.length) box.removeChild(box.lastChild);
    items.forEach(function (it, i) {
      var row = box.children[i];
      if (!row) {
        row = document.createElement('div');
        row.innerHTML = '<span class="dot"></span><span class="n"></span><span class="m"></span><span class="r"></span>';
        box.appendChild(row);
      }
      fill(row, it);
    });
  }

  function speed(mbps) { return mbps >= 1000 ? (mbps / 1000) + ' GbE' : mbps + ' Mb'; }

  var portHistory = {};   // live rate per port, by name

  function renderPorts(d) {
    var prev = {};
    if (last && last.ports) last.ports.forEach(function (p) { prev[p.name] = p; });
    var ports = d.ports || [];
    ports.forEach(function (p) {
      var hist = portHistory[p.name] || (portHistory[p.name] = []), q = prev[p.name];
      if (q) addRate(hist, p.rx_bytes, p.tx_bytes, q.rx_bytes, q.tx_bytes, d.ts - last.ts);
    });
    renderRows('cPorts', ports, d.ports === undefined ? 'Not reported by the router' : 'No ports', function (row, p) {
      var hist = portHistory[p.name], h = hist[hist.length - 1];
      row.className = 'row' + (p.up ? '' : ' off');
      row.children[1].textContent = p.name;
      // A LAN port in batman's bat0 instead of br-lan is the wired mesh backbone.
      row.children[2].textContent = p.up ? (p.speed_mbps ? speed(p.speed_mbps) : 'up') + (p.attached === 'bat0' ? ' · mesh' : '')
        : 'not connected';
      row.children[3].textContent = p.up && h ? '↓ ' + rate(h.down) + '  ↑ ' + rate(h.up) : '';
    });
    var bad = ports.some(function (p) { return p.role === 'wan' && !p.up; });
    gauge($('cPorts'), ports.length ? (bad ? 'bad' : 'ok') : '', null);
  }

  /** The busiest devices right now (top_hosts, already sorted by the router), each with a bar
   *  against the busiest one: blue for down, purple for up. */
  function renderTop(d) {
    var hosts = (d.top_hosts || []).slice(0, 10), box = $('cTop').querySelector('.rows');
    $('topInfo').textContent = d.top_hosts ? 'live' : '';
    gauge($('cTop'), hosts.length ? 'ok' : '', null);
    if (!hosts.length) {
      box.innerHTML = '<div class="empty">' + (d.top_hosts === undefined ? 'Not reported by the router'
        : d.top_hosts === null ? 'Measuring…' : 'No traffic') + '</div>';
      return;
    }
    if (box.querySelector('.empty')) box.innerHTML = '';
    var top = 1;
    hosts.forEach(function (x) { top = Math.max(top, (x.down_bps || 0) + (x.up_bps || 0)); });
    while (box.children.length > hosts.length) box.removeChild(box.lastChild);
    hosts.forEach(function (x, i) {
      var row = box.children[i];
      if (!row) {
        row = document.createElement('div');
        row.className = 'host';
        row.innerHTML = '<span class="n"></span><span class="b"><i class="down"></i><i class="up"></i></span><span class="r"></span>';
        box.appendChild(row);
      }
      var down = x.down_bps || 0, up = x.up_bps || 0;
      row.children[0].textContent = x.name || x.ip || '?';
      row.children[1].children[0].style.width = down / top * 100 + '%';
      row.children[1].children[1].style.width = up / top * 100 + '%';
      row.children[2].textContent = rate((down + up) / 8);   // rate() takes bytes per second
    });
  }

  function bandName(b) { return b === '2g' ? '2.4G' : b === '5g' ? '5G' : b === '6g' ? '6G' : (b || ''); }

  function renderWifi(d) {
    // The whole house (every mesh AP, from the main gateway) when the router reports it; otherwise
    // only this gateway's own radios.
    var mesh = d.wifi_mesh, list, total = 0;
    if (mesh && mesh.by_ssid) {
      // The router's order changes between polls: sort so rows don't jump.
      list = mesh.by_ssid.slice().sort(function (a, b) {
        return (a.ssid || '').localeCompare(b.ssid || '') || (a.band || '').localeCompare(b.band || '');
      });
      total = typeof mesh.total === 'number' ? mesh.total : list.reduce(function (s, w) { return s + (w.clients || 0); }, 0);
    } else {
      list = d.wifi || [];
      list.forEach(function (w) { total += w.clients || 0; });
    }
    $('wifiTotal').textContent = list.length ? total + (total === 1 ? ' client' : ' clients') +
      (mesh && mesh.by_ssid ? ' · ' + (mesh.nodes_seen || (mesh.by_node || []).length) + ' APs' : ' · this AP') : '';
    renderRows('cWifi', list, d.wifi === undefined && !mesh ? 'Not reported by the router' : 'No Wi-Fi up', function (row, w) {
      row.className = 'row';
      row.children[1].textContent = w.ssid || w.radio;
      // One AP gives a channel; the whole house gives each AP's channel for this SSID: "ch11/6".
      var chans = w.channels ? w.channels.map(function (c) { return c.channel; }).filter(function (c, i, a) {
        return c && a.indexOf(c) === i;
      }) : w.channel ? [w.channel] : [];
      row.children[2].textContent = bandName(w.band) + (chans.length ? ' · ch' + chans.join('/') : '');
      row.children[3].className = 'r big';
      row.children[3].textContent = w.clients === null || w.clients === undefined ? '-' : w.clients;
    });
    gauge($('cWifi'), list.length ? 'ok' : '', null);
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

  var WG_HEIGHT = 364, WG_GAP = 16;   // the WireGuard area, from #wg's top to the bottom margin

  /**
   * Fits every tunnel on screen: 5 per row in 2 rows up to 10 tunnels, then 3 rows of smaller tiles
   * (no graph), then 6 per row, then 4 rows of bare tiles (no bar either) with as many columns as needed.
   */
  function layoutWg(box, n) {
    var cols = 5, rows = Math.max(1, Math.ceil(n / cols));
    if (rows > 3) { cols = 6; rows = Math.ceil(n / cols); }
    if (rows > 4) { rows = 4; cols = Math.ceil(n / rows); }
    rows = Math.max(rows, 2);
    box.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
    box.style.gridAutoRows = Math.floor((WG_HEIGHT - (rows - 1) * WG_GAP) / rows) + 'px';
    box.style.gap = WG_GAP + 'px';
    box.className = rows >= 4 ? 'compact tiny' : rows === 3 ? 'compact' : '';
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
    layoutWg(box, list.length);
    while (box.children.length > list.length) box.removeChild(box.lastChild);
    list.forEach(function (w, i) {
      var el = box.children[i];
      if (!el) {
        el = document.createElement('div');
        el.innerHTML = '<div class="name"><span class="nm"></span><span class="tags"></span></div><div class="state"></div>' +
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
      var shortText = text;   // the corner keeps it short; the handshake age goes to the small print
      if (w.up && w.handshake_age !== null && w.handshake_age !== undefined) text += ' · ' + duration(w.handshake_age);

      var hist = wgHistory[w.name], h = hist[hist.length - 1];
      var ping = state === 'ok' && w.up ? pingText(w.ping_ms, w.ping_loss, w.ping_ts, d.ts).replace(/^ · /, '') : '';
      el.className = 'card ' + state;
      // Bar: the tunnel's share of its qosify limit, or its ping health, whichever is worse.
      gauge(el, state, w.up ? worst(trafficLevel(d, w.name, h), pingLevel(w.ping_ms, w.ping_loss, w.ping_ts, d.ts)) : null);
      el.querySelector('.nm').textContent = w.name;
      // PBR and DBR tags: shown only when the tunnel carries that kind of routing, coloured by the
      // router's health check (ok, down = fell back to WAN, locked = flap lock, unchecked).
      var tags = el.querySelector('.tags');
      tags.innerHTML = '';
      [['PBR', w.pbr], ['DBR', w.dbr]].forEach(function (t) {
        if (!t[1]) return;
        var s = document.createElement('span');
        s.className = 'tag ' + (t[1].state || 'unchecked');
        s.textContent = t[0];
        tags.appendChild(s);
      });
      // Top right: the ping, readable from the sofa, when the tunnel is up and measured; otherwise the
      // state (Down, No handshake, Standby). Up and the handshake age move to the small print.
      var corner = el.querySelector('.state');
      corner.className = 'state' + (ping ? ' ping' : '');
      corner.textContent = ping || shortText;
      corner.style.color = ping ? pingColor(pingLevel(w.ping_ms, w.ping_loss, w.ping_ts, d.ts)) : '';
      el.querySelector('.wgRates .down').textContent = '↓ ' + (h ? rate(h.down) : '-');
      el.querySelector('.wgRates .up').textContent = '↑ ' + (h ? rate(h.up) : '-');
      el.querySelector('.share .down').style.width = (h ? h.down / busiest * 100 : 0) + '%';
      el.querySelector('.share .up').style.width = (h ? h.up / busiest * 100 : 0) + '%';
      el.querySelector('.small').textContent = w.up ? text + ' · total ↓ ' + bytes(w.rx_bytes) + '  ↑ ' + bytes(w.tx_bytes) : '';
      drawLines(el.querySelector('canvas'), hist, max, 3);
    });
  }

  function renderRates(d) {
    if (last) addRate(history, d.wan_rx_bytes, d.wan_tx_bytes, last.wan_rx_bytes, last.wan_tx_bytes, d.ts - last.ts);
    var h = history[history.length - 1];
    $('rateDown').textContent = '↓ ' + (h ? rate(h.down) : '-');
    $('rateUp').textContent = '↑ ' + (h ? rate(h.up) : '-');
    // Bar: WAN use against the limits set in qosify.
    var lvl = trafficLevel(d, 'wan', h);
    gauge($('cGraph'), lvl === null ? '' : 'ok', lvl);
    var max = 1;
    history.forEach(function (p) { max = Math.max(max, p.down, p.up); });
    drawLines($('graph'), history, max, 4);
    // The scale goes under the title: drawn on the graph, the lines run over it.
    $('wanDev').textContent = d.wan_dev || '';
    $('scale').textContent = history.length > 1 ? 'scale ' + rate(max) : '';
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
    x.open('GET', CONFIG.url + (CONFIG.url.indexOf('?') < 0 ? '?' : '&') +
      (TOKEN ? 'token=' + encodeURIComponent(TOKEN) + '&' : '') + '_=' + Date.now());
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

  // ---- route editor ---------------------------------------------------------------------------
  //
  // OK (or a click on Top 10) lists the devices in the Sheet's PBR_Source with the tunnel each is sent
  // through. Up/Down picks one; OK (or a click) pops up every tunnel at once, Up/Down and OK (or a
  // click) choose and save, Back cancels or closes. The Google Sheet decides routing: saving goes through an Apps Script web app that edits the
  // PBR tab, and the router picks the change up on its next sync, about a minute later (none 01:00-06:59).
  // Choices are the Sheet's own tunnel labels (its column E drop-down), plus "default", which unticks
  // the row and keeps its tunnel for later.

  var DEFAULT = { label: 'default', wg: 'default' };
  var routes = { open: false, hosts: [], options: [], sel: 0, picking: false, choice: 0, busy: false };
  var GAS_ERRORS = {
    forbidden: 'Token rejected by the Apps Script (wrong token, or the new version isn’t deployed)',
    bad_reply: 'Unexpected reply from the Apps Script', not_in_pbr_source: 'Not in the Sheet’s PBR_Source list',
    bad_tunnel: 'Not one of the Sheet’s tunnels', not_static_host: 'Not a static host',
    bad_wg: 'Invalid tunnel name', no_free_number: 'No free rule number', busy: 'Busy, try again', network: 'Can’t reach Google',
    no_gas: 'Route editing is not set up (no token, or the router gave no Apps Script URL)'
  };

  /** Calls the Apps Script web app with a plain GET (no custom headers: it can't answer a preflight). */
  function gas(params, cb) {
    if (!gasUrl || !TOKEN) { cb({ ok: false, error: 'no_gas' }); return; }
    var q = Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); });
    q.push('tvtoken=' + encodeURIComponent(TOKEN));
    var x = new XMLHttpRequest(), done = false;
    function finish(res) { if (!done) { done = true; cb(res); } }
    x.open('GET', gasUrl + '?' + q.join('&'));
    x.timeout = CONFIG.gasTimeout;
    x.onload = function () {
      // A web app that rejects the call outright answers plain text ("Forbidden"), not JSON.
      try { finish(JSON.parse(x.responseText)); } catch (e) {
        finish({ ok: false, error: /forbidden/i.test(x.responseText) ? 'forbidden' : 'bad_reply' });
      }
    };
    x.onerror = x.ontimeout = function () { finish({ ok: false, error: 'network' }); };
    x.send();
  }

  function routesStatus(text, bad) {
    var s = $('routesStatus');
    s.textContent = text;
    s.className = bad ? 'bad' : '';
  }

  /** "台灣VPN · wg_tw", or "default" when the row is unticked. */
  function tunnelText(h) {
    if (h.enabled) return (h.label || h.wg) + (h.wg && h.wg !== h.label ? ' · ' + h.wg : '');
    return 'default';
  }

  function openRoutes() {
    routes.open = true;
    routes.picking = false;
    $('routes').classList.remove('hidden');
    routesStatus('Loading…');
    gas({ action: 'TvList' }, function (res) {
      if (!routes.open) return;
      if (!res.ok) { routesStatus(GAS_ERRORS[res.error] || res.error || 'Failed', true); return; }
      var keep = routes.hosts[routes.sel] ? routes.hosts[routes.sel].ip : null;
      routes.hosts = res.hosts || [];
      if (res.options) {
        routes.options = [DEFAULT].concat(res.options);   // labels, in the Sheet's own order
      } else {
        // The older web app lists bare interface names, and "default" instead of an enabled flag.
        routes.options = [DEFAULT].concat((res.allowed || []).map(function (wg) { return { label: wg, wg: wg }; }));
        routes.hosts.forEach(function (h) {
          if (h.enabled === undefined) { h.enabled = h.wg !== 'default'; if (!h.label && h.enabled) h.label = h.wg; }
        });
      }
      routes.legacy = !res.options;
      routes.sel = Math.max(0, routes.hosts.map(function (h) { return h.ip; }).indexOf(keep));
      routesStatus('OK to change a device’s tunnel · Back to close');
      drawRoutes();
    });
  }

  function closeRoutes() {
    routes.open = false;
    $('routes').classList.add('hidden');
  }

  function drawRoutes() {
    var box = $('routesList');
    box.innerHTML = '';
    routes.hosts.forEach(function (h, i) {
      var row = document.createElement('div'), picking = routes.picking && i === routes.sel;
      row.className = 'route' + (i === routes.sel ? ' sel' : '') + (picking ? ' picking' : '') + (h.enabled ? '' : ' plain');
      row.innerHTML = '<span class="n"></span><span class="ip"></span><span class="wg"></span><span class="p"></span>';
      row.children[0].textContent = h.name || '';
      row.children[1].textContent = h.ip;
      row.children[2].textContent = tunnelText(h);
      row.children[3].textContent = h.pending && Date.now() - h.pending < 120000 ? 'applying…' : '';
      row.addEventListener('click', function () {
        if (routes.busy) return;
        routes.sel = i;
        routes.picking = true;
        routes.choice = currentChoice(h);
        drawRoutes();
      });
      box.appendChild(row);
    });
    var sel = box.children[routes.sel];
    if (sel) sel.scrollIntoView({ block: 'nearest' });
    drawMenu();
  }

  /** The tunnel menu for the selected device: every choice at once, the current one ticked. */
  function drawMenu() {
    var menu = $('routesMenu'), h = routes.hosts[routes.sel];
    menu.classList.toggle('hidden', !routes.picking || !h);
    if (!routes.picking || !h) return;
    var current = currentChoice(h);
    menu.innerHTML = '<div class="title"></div>';
    menu.firstChild.textContent = h.name || h.ip;
    routes.options.forEach(function (opt, i) {
      var item = document.createElement('div');
      item.className = 'opt' + (i === routes.choice ? ' sel' : '') + (i === current ? ' current' : '');
      item.textContent = (i === current ? '✓ ' : '') + opt.label +
        (opt.wg && opt.wg !== opt.label && opt !== DEFAULT ? '  · ' + opt.wg : '');
      item.addEventListener('click', function (e) { e.stopPropagation(); if (!routes.busy) saveRoute(h, opt); });
      menu.appendChild(item);
    });
    var s = menu.children[routes.choice + 1];
    if (s) s.scrollIntoView({ block: 'nearest' });
  }

  /** The choice matching the host's current setting: "default" when unticked, else its label. */
  function currentChoice(h) {
    if (!h.enabled) return 0;
    for (var i = 1; i < routes.options.length; i++) if (routes.options[i].label === h.label) return i;
    for (i = 1; i < routes.options.length; i++) if (routes.options[i].wg === h.wg) return i;
    return 0;
  }

  function routesKey(k) {
    if (routes.busy) return;
    var h = routes.hosts[routes.sel], n = routes.options.length;
    if (k === KEY.BACK || k === KEY.ESC) {
      if (routes.picking) { routes.picking = false; drawRoutes(); } else closeRoutes();
    } else if (!h) {
      return;
    } else if (routes.picking) {
      if (k === KEY.UP) routes.choice = Math.max(0, routes.choice - 1);
      else if (k === KEY.DOWN) routes.choice = Math.min(n - 1, routes.choice + 1);
      else if (k === KEY.OK) { saveRoute(h, routes.options[routes.choice]); return; }
      drawMenu();
    } else {
      if (k === KEY.UP) routes.sel = Math.max(0, routes.sel - 1);
      else if (k === KEY.DOWN) routes.sel = Math.min(routes.hosts.length - 1, routes.sel + 1);
      else if (k === KEY.OK) { routes.picking = true; routes.choice = currentChoice(h); }
      drawRoutes();
    }
  }

  function saveRoute(h, opt) {
    routes.picking = false;
    if (routes.options.indexOf(opt) === currentChoice(h)) { drawRoutes(); return; }
    routes.busy = true;
    routesStatus('Saving ' + (h.name || h.ip) + ' → ' + opt.label + '…');
    var params = { action: 'TvSetTunnel', ip: h.ip };
    // The older web app only understands wg=<interface>; the current one prefers the Sheet's label.
    if (opt === DEFAULT) params.wg = 'default'; else if (routes.legacy) params.wg = opt.wg; else params.label = opt.label;
    gas(params, function (res) {
      routes.busy = false;
      if (res.ok) {
        var before = tunnelText(h);
        if (res.to && typeof res.to === 'object') { h.label = res.to.label; h.wg = res.to.wg; }
        else { h.label = opt.label; h.wg = opt.wg; }   // the older web app answers to: "<interface>"
        h.enabled = opt === DEFAULT ? false : res.enabled !== false;
        h.pending = Date.now();
        routesStatus((h.name || h.ip) + ': ' + before + ' → ' + tunnelText(h) +
          ' · the router applies it within about a minute (not 01:00-06:59)');
      } else {
        routesStatus(GAS_ERRORS[res.error] || res.error || 'Failed', true);
      }
      drawRoutes();
    });
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
    if (routes.open) { e.preventDefault(); routesKey(e.keyCode); return; }
    if (e.keyCode === KEY.OK) { e.preventDefault(); openRoutes(); }
    else if (e.keyCode === KEY.BACK || e.keyCode === KEY.ESC) { e.preventDefault(); goHome(); }
  });
  $('cTop').addEventListener('click', function () { if (!routes.open) openRoutes(); });

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
