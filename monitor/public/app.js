(function () {
  const logFeed = document.getElementById('log-feed');
  const logCount = document.getElementById('log-count');
  const botFilterSelect = document.getElementById('bot-filter');
  const searchInput = document.getElementById('search-input');
  const autoscrollCheckbox = document.getElementById('autoscroll-checkbox');
  const connStatus = document.getElementById('connection-status');
  const statusPanel = document.getElementById('bot-status-panel');
  const statusEmpty = document.getElementById('status-empty');

  const knownBots = new Set();
  let visibleCount = 0;
  let ws = null;
  let reconnectTimer = null;

  function relativeTime(isoString) {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(isoString).getTime()) / 1000));
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function addBotOption(bot) {
    if (knownBots.has(bot)) return;
    knownBots.add(bot);
    const opt = document.createElement('option');
    opt.value = bot;
    opt.textContent = bot;
    botFilterSelect.appendChild(opt);
  }

  function matchesFilters(entry) {
    const botOk = !botFilterSelect.value || entry.bot === botFilterSelect.value;
    const search = searchInput.value.trim().toLowerCase();
    const textOk = !search || entry.message.toLowerCase().includes(search) || entry.bot.toLowerCase().includes(search);
    return botOk && textOk;
  }

  function appendLogLine(entry) {
    addBotOption(entry.bot);

    const line = document.createElement('div');
    line.className = `log-line level-${entry.level}`;
    line.dataset.bot = entry.bot;
    line.dataset.message = entry.message.toLowerCase();
    const time = new Date(entry.timestamp).toLocaleTimeString();
    line.innerHTML =
      `<span class="log-time">${time}</span>` +
      `<span class="log-bot">${escapeHtml(entry.bot)}</span>` +
      `<span class="log-message">${escapeHtml(entry.message)}</span>`;

    if (!matchesFilters(entry)) line.classList.add('hidden');
    else visibleCount++;

    logFeed.appendChild(line);
    logCount.textContent = `${visibleCount} shown`;

    // Cap DOM size so a long-running session doesn't grow unbounded.
    while (logFeed.children.length > 5000) {
      const removed = logFeed.removeChild(logFeed.firstChild);
      if (!removed.classList.contains('hidden')) visibleCount--;
    }

    if (autoscrollCheckbox.checked) {
      logFeed.scrollTop = logFeed.scrollHeight;
    }
  }

  function reapplyFilters() {
    visibleCount = 0;
    for (const line of logFeed.children) {
      const entry = { bot: line.dataset.bot, message: line.dataset.message };
      const botOk = !botFilterSelect.value || entry.bot === botFilterSelect.value;
      const search = searchInput.value.trim().toLowerCase();
      const textOk = !search || entry.message.includes(search) || entry.bot.toLowerCase().includes(search);
      const visible = botOk && textOk;
      line.classList.toggle('hidden', !visible);
      if (visible) visibleCount++;
    }
    logCount.textContent = `${visibleCount} shown`;
  }

  botFilterSelect.addEventListener('change', reapplyFilters);
  searchInput.addEventListener('input', reapplyFilters);

  function renderStatus(statusList) {
    if (statusList.length === 0) {
      statusEmpty.style.display = '';
      return;
    }
    statusEmpty.style.display = 'none';
    statusPanel.querySelectorAll('.bot-card').forEach((el) => el.remove());

    for (const bot of statusList) {
      addBotOption(bot.bot);
      const card = document.createElement('div');
      card.className = 'bot-card';
      card.innerHTML =
        `<div class="bot-card-header">` +
        `<span class="status-dot ${bot.online ? 'online' : 'offline'}"></span>` +
        `<span class="bot-name">${escapeHtml(bot.bot)}</span>` +
        `</div>` +
        `<div class="bot-last-seen">${bot.online ? 'online' : 'offline'} · last seen ${relativeTime(bot.lastSeen)}</div>` +
        `<div class="bot-last-message">${escapeHtml(bot.lastMessage || '')}</div>`;
      statusPanel.appendChild(card);
    }
  }

  async function refreshStatus() {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) return;
      renderStatus(await res.json());
    } catch {
      // status panel just goes stale until the next successful poll - non-fatal
    }
  }

  async function loadInitialLogs() {
    try {
      const res = await fetch('/api/logs?limit=500');
      if (!res.ok) return;
      const initialLogs = await res.json();
      initialLogs.forEach(appendLogLine);
    } catch {
      // WebSocket snapshot will fill this in once connected
    }
  }

  function setConnStatus(connected) {
    connStatus.textContent = connected ? 'live' : 'reconnecting…';
    connStatus.className = `conn-status ${connected ? 'conn-connected' : 'conn-disconnected'}`;
  }

  function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws`);

    ws.onopen = () => setConnStatus(true);

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'snapshot') {
        // Only backfill from the snapshot if we have no history yet (avoids duplicates
        // with the REST-loaded initial log list).
        if (logFeed.children.length === 0) data.logs.forEach(appendLogLine);
      } else if (data.type === 'log') {
        appendLogLine(data.entry);
      }
    };

    ws.onclose = () => {
      setConnStatus(false);
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = () => ws.close();
  }

  async function refreshStrips() {
    try {
      const res = await fetch('/api/dashboard/flightstrips');
      if (!res.ok) return;
      const strips = await res.json();
      const tbody = document.getElementById('strips-tbody');
      tbody.innerHTML = '';
      for (const s of strips) {
        const c = s.clearance || {};
        const row = document.createElement('tr');
        const updated = s.updatedAt ? new Date(s.updatedAt).toLocaleTimeString() : '';
        const vector = typeof c.assignedHeadingDeg === 'number' ? `${c.assignedHeadingDeg}°${c.vectorReason ? ` (${c.vectorReason})` : ''}` : '';
        row.innerHTML = [
          s.callsign,
          s.aircraftType || '',
          s.currentPosition || '',
          c.destination || '',
          c.initialClimbAltitude || '',
          c.squawk || '',
          c.departureFreq || '',
          vector,
          updated,
        ]
          .map((v) => `<td>${escapeHtml(String(v))}</td>`)
          .join('');
        tbody.appendChild(row);
      }
    } catch {
      // table just goes stale until the next successful poll - non-fatal
    }
  }

  loadInitialLogs().then(connectWebSocket);
  refreshStatus();
  setInterval(refreshStatus, 5000);
  refreshStrips();
  setInterval(refreshStrips, 5000);

  // View tab switching (Logs / Radar / Strips). The Radar tab is an
  // iframe onto public/365radar/ - see monitor/server.js's /365radar route.
  document.querySelectorAll('.view-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.view-tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.view-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `${tab.dataset.view}-panel`));
    });
  });
})();
