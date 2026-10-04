/* Dendrite Dashboard — vanilla JS SPA */

/* ---------- utils ---------- */
function $(sel, ctx) { return (ctx || document).querySelector(sel); }
function $$(sel, ctx) { return Array.from((ctx || document).querySelectorAll(sel)); }

function showToast(msg, type) {
  var t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + (type || '') + ' show';
  clearTimeout(t._hide);
  t._hide = setTimeout(function() { t.className = 'toast'; }, 3000);
}

function openModal(html) {
  var m = $('#modal');
  m.innerHTML = html;
  m.classList.remove('hidden');
}

function closeModal() {
  $('#modal').classList.add('hidden');
}

/* close modal on Escape */
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeModal();
});

function colorClass(confidence) {
  if (confidence >= 0.72) return 'conf-high';
  if (confidence >= 0.45) return 'conf-mid';
  return 'conf-low';
}

function confColor(confidence) {
  if (confidence >= 0.72) return '#00ff9f';
  if (confidence >= 0.45) return '#ffaa00';
  return '#ff4444';
}

function sourceLabel(s) {
  return s === 'telegram-text' ? 'tg' : s === 'telegram-voice' ? 'voice' : s === 'webhook' ? 'web' : s || '?';
}

function escHtml(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/* ---------- API helpers ---------- */
function authHeaders() {
  var t = localStorage.getItem('dendrite.token');
  return t ? { Authorization: 'Bearer ' + t } : {};
}

function api(path, opts) {
  opts = opts || {};
  var headers = authHeaders();
  if (opts.body) headers['Content-Type'] = 'application/json';
  return fetch(path, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }).then(function(r) { return r.json(); });
}

/* ---------- Tab switching ---------- */
function switchTab(name) {
  $$('.tab').forEach(function(t) { t.classList.toggle('active', t.dataset.tab === name); });
  $$('.view').forEach(function(v) { v.classList.toggle('hidden', v.id !== 'view-' + name); });
  if (name === 'triage') loadTriage();
  if (name === 'life') loadLife();
}

$$('.tab').forEach(function(t) {
  t.addEventListener('click', function() { switchTab(this.dataset.tab); });
});

/* ---------- Quick Glance ---------- */
function loadGlance() {
  api('/api/stats').then(function(data) {
    $('#inbox-count').textContent = data.inbox_count;
    $('#today-count').textContent = data.today_count;
    $('#week-count').textContent = data.week_count;

    /* stats cards */
    var cardsHtml = '';
    cardsHtml += '<div class="stat-card clickable" id="stat-inbox" onclick="switchTab(\'triage\')">' +
      '<span class="label">Inbox</span><span class="value">' + data.inbox_count + '</span><span class="hint">unfiled</span></div>';
    cardsHtml += '<div class="stat-card"><span class="label">Today</span><span class="value">' + data.today_count +
      '</span><span class="hint">captures</span></div>';
    cardsHtml += '<div class="stat-card"><span class="label">This Week</span><span class="value">' + data.week_count +
      '</span><span class="hint">captures</span></div>';
    $('#stats-cards').innerHTML = cardsHtml;

    /* compartment bars */
    var barsHtml = '';
    var maxCount = 1;
    (data.compartments || []).forEach(function(c) { if (c.count > maxCount) maxCount = c.count; });
    (data.compartments || []).forEach(function(c) {
      var pct = (c.count / maxCount) * 100;
      barsHtml += '<div class="comp-bar">' +
        '<span class="name">' + escHtml(c.name) + '</span>' +
        '<div class="bar"><div class="fill" style="width:' + pct + '%"></div></div>' +
        '<span class="count">' + c.count + '</span></div>';
    });
    $('#compartment-bars').innerHTML = barsHtml;

    /* latest capture */
    if (data.latest_capture) {
      var lc = data.latest_capture;
      var confCls = colorClass(lc.confidence);
      $('#latest-capture').innerHTML =
        '<span class="time">' + lc.received_at.slice(11, 16) + '</span> ' +
        '<span class="comp-badge ' + lc.compartment + '">' + lc.compartment + '</span> ' +
        '<span class="title">' + escHtml(lc.title || lc.path) + '</span> ' +
        '<span class="conf ' + confCls + '">' + lc.confidence.toFixed(2) + '</span>';
    } else {
      $('#latest-capture').innerHTML = '<span class="muted">No captures yet</span>';
    }
  }).catch(function() {
    showToast('Failed to load stats', 'error');
  });
}

/* ---------- Triage ---------- */
function loadTriage() {
  api('/api/inbox').then(function(inbox) {
    $('#inbox-count-badge').textContent = '(' + inbox.length + ')';

    if (inbox.length === 0) {
      $('#inbox-queue').innerHTML = '';
      $('#inbox-empty').classList.remove('hidden');
    } else {
      $('#inbox-empty').classList.add('hidden');
      var html = '';
      inbox.forEach(function(note) {
        var confCls = colorClass(note.confidence);
        var segBadge = note.split_group ? '<span class="segment-badge">split</span>' : '';
        html += '<div class="inbox-card" data-path="' + escHtml(note.path) + '" style="--conf-color:' +
          confColor(note.confidence) + '">' +
          '<div class="filename">' + escHtml(note.path) + segBadge + '</div>' +
          '<div class="preview">' + escHtml((note.body_preview || note.summary || '').slice(0, 200)) + '</div>' +
          '<div class="meta">' +
          '<span class="comp-badge ' + (note.compartment || 'inbox') + '">' + (note.compartment || 'inbox') +
          '</span> ' +
          '<span class="' + confCls + '">' + note.confidence.toFixed(2) + '</span> · ' +
          '<span>' + (note.created ? note.created.slice(11, 16) : '') + '</span> · ' +
          '<span>' + sourceLabel(note.source) + '</span>' +
          '</div>' +
          '<div class="actions">' +
          '<button class="btn btn-approve" onclick="doApprove(\'' + escHtml(note.path) + '\')">✓ Approve</button>' +
          '<select class="compartment-select" onchange="doReclassify(\'' + escHtml(note.path) + '\', this.value)">' +
          '<option value="">Reclassify...</option>' +
          '</select>' +
          '<button class="btn btn-reject" onclick="doReject(this, \'' + escHtml(note.path) + '\')">✗ Reject</button>' +
          '</div></div>';
      });
      $('#inbox-queue').innerHTML = html;

      /* populate compartment dropdowns */
      api('/api/compartments').then(function(comps) {
        $$('.compartment-select').forEach(function(sel) {
          comps.forEach(function(c) {
            if (c.name === 'inbox') return;
            var opt = document.createElement('option');
            opt.value = c.name;
            opt.textContent = c.name;
            sel.appendChild(opt);
          });
        });
      });
    }
  }).catch(function() { showToast('Failed to load inbox', 'error'); });

  /* Recent captures */
  api('/api/recent?limit=20').then(function(notes) {
    var html = '';
    notes.forEach(function(n) {
      var confCls = colorClass(n.confidence);
      html += '<div class="recent-row" onclick="openNoteModal(\'' + escHtml(n.path) + '\')">' +
        '<span class="time">' + (n.received_at ? n.received_at.slice(11, 16) : '') + '</span>' +
        '<span class="comp"><span class="comp-badge ' + n.compartment + '">' + n.compartment + '</span></span>' +
        '<span class="title">' + escHtml(n.title || n.path) + '</span>' +
        '<span class="conf ' + confCls + '">' + n.confidence.toFixed(2) + '</span></div>';
    });
    $('#recent-captures').innerHTML = html;
  }).catch(function() { /* silent fail */ });
}

/* ---------- Triage actions ---------- */
window.doApprove = function(path) {
  api('/api/triage/approve', { method: 'POST', body: { path: path } }).then(function(r) {
    if (r.ok) {
      showToast('Approved → ' + r.compartment, 'success');
      removeCard(path);
      loadTriage();
    } else {
      showToast(r.error || 'Approve failed', 'error');
    }
  }).catch(function() { showToast('Approve request failed', 'error'); });
};

window.doReclassify = function(path, compartment) {
  if (!compartment) return;
  api('/api/triage/reclassify', { method: 'POST', body: { path: path, compartment: compartment } }).then(function(r) {
    if (r.ok) {
      showToast('Moved to ' + compartment, 'success');
      removeCard(path);
      loadTriage();
    } else {
      showToast(r.error || 'Reclassify failed', 'error');
    }
  }).catch(function() { showToast('Reclassify request failed', 'error'); });
};

window.doReject = function(btn, path) {
  if (!btn.classList.contains('confirming')) {
    btn.classList.add('confirming');
    btn.textContent = 'Sure?';
    var orig = btn.textContent;
    setTimeout(function() {
      btn.classList.remove('confirming');
      btn.textContent = '✗ Reject';
    }, 2500);
    return;
  }
  api('/api/triage/reject', { method: 'POST', body: { path: path } }).then(function(r) {
    if (r.ok) {
      showToast('Rejected — moved to trash', 'success');
      removeCard(path);
      loadTriage();
    } else {
      showToast(r.error || 'Reject failed', 'error');
    }
  }).catch(function() { showToast('Reject request failed', 'error'); });
};

function removeCard(path) {
  var card = document.querySelector('.inbox-card[data-path="' + CSS.escape(path) + '"]');
  if (card) {
    card.classList.add('removing');
    setTimeout(function() { if (card.parentNode) card.parentNode.removeChild(card); }, 300);
  }
}

/* ---------- Note modal ---------- */
window.openNoteModal = function(path) {
  api('/api/note?path=' + encodeURIComponent(path)).then(function(data) {
    if (data.error) { showToast(data.error, 'error'); return; }
    var fm = data.frontmatter || {};
    var isInbox = path.indexOf('/inbox/') >= 0;
    var comp = fm.compartment || '?';
    var confCls = colorClass(Number(fm.confidence) || 0);
    var metaHtml = '';
    metaHtml += '<div>Compartment: <span class="comp-badge ' + comp + '">' + comp + '</span></div>';
    if (fm.confidence) metaHtml += '<div>Confidence: <span class="' + confCls + '">' + Number(fm.confidence).toFixed(2) +
      '</span></div>';
    if (fm.source) metaHtml += '<div>Source: ' + escHtml(fm.source) + '</div>';
    if (fm.created) metaHtml += '<div>Created: ' + escHtml(fm.created) + '</div>';
    if (Array.isArray(fm.entities) && fm.entities.length)
      metaHtml += '<div>Entities: ' + fm.entities.map(function(e) { return escHtml(e); }).join(', ') + '</div>';
    if (Array.isArray(fm.tags) && fm.tags.length)
      metaHtml += '<div>Tags: ' + fm.tags.map(function(t) { return escHtml(t); }).join(', ') + '</div>';

    var actionHtml = '';
    if (isInbox) {
      actionHtml = '<div class="modal-actions">' +
        '<button class="btn btn-approve" onclick="doApprove(\'' + escHtml(path) + '\')">✓ Approve</button>' +
        '<select class="compartment-select" onchange="doReclassify(\'' + escHtml(path) +
        '\', this.value); closeModal();">' +
        '<option value="">Reclassify...</option></select>' +
        '<button class="btn btn-reject" onclick="doReject(this, \'' + escHtml(path) + '\'); setTimeout(closeModal, 500)">✗ Reject</button>' +
        '</div>';
    } else {
      actionHtml = '<div class="modal-filed-note">Already filed in ' + comp + '/</div>';
    }

    var popupHtml =
      '<div class="modal-header"><span class="modal-title">' + escHtml(path.split('/').pop()) +
      '</span><span class="modal-close" onclick="closeModal()">✕</span></div>' +
      '<div class="modal-meta">' + metaHtml + '</div>' +
      '<pre class="modal-body">' + escHtml(data.body || '') + '</pre>' +
      actionHtml;

    openModal(popupHtml);

    /* populate compartment dropdown in modal */
    if (isInbox) {
      api('/api/compartments').then(function(comps) {
        var sel = $('.modal-actions .compartment-select');
        if (!sel) return;
        comps.forEach(function(c) {
          if (c.name === 'inbox') return;
          var opt = document.createElement('option');
          opt.value = c.name;
          opt.textContent = c.name;
          sel.appendChild(opt);
        });
      });
    }
  }).catch(function() { showToast('Failed to load note', 'error'); });
};

/* ---------- Refresh button ---------- */
$('#refresh-inbox').addEventListener('click', loadTriage);

/* ---------- Init ---------- */
loadGlance();

/* Poll glance every 30s */
setInterval(loadGlance, 30000);
/* ---------- Life (event log) ---------- */
var life = { date: null, live: null };

function isoDay(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function shiftDay(day, n) {
  var d = new Date(day + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return isoDay(d);
}
function v1(path, opts) {
  return api(path, opts).then(function(r) {
    if (r && r.error) throw new Error(r.error);
    return r;
  });
}
function entryHtml(e) {
  var imp = e.importance >= 0.7 ? ' hi' : '';
  return '<div class="tl-row' + imp + '"><span class="tl-time">' + escHtml(e.time || '') + '</span>' +
    '<span class="tl-stream s-' + escHtml(e.stream) + '">' + escHtml(e.stream) + '</span>' +
    '<span class="tl-text">' + escHtml(e.summary || e.kind) + '</span></div>';
}

function loadLife() {
  if (!life.date) life.date = isoDay(new Date());
  $('#life-date').value = life.date;
  v1('/v1/timeline?date=' + life.date).then(function(s) {
    $('#life-count').textContent = s.total ? s.total + ' events' : '';
    $('#life-stats').innerHTML = (s.streams.length ? s.streams.slice(0, 4) : [{ stream: 'events', count: 0 }]).map(function(st) {
      return '<div class="stat-card"><span class="label">' + escHtml(st.stream) + '</span><span class="value">' + st.count + '</span></div>';
    }).join('');
    $('#life-timeline').innerHTML = s.timeline.length
      ? s.timeline.map(entryHtml).join('') + (s.truncated ? '<div class="empty-state">…truncated</div>' : '')
      : '<div class="empty-state">Nothing recorded on this day.</div>';
    $('#life-entities').innerHTML = s.entities.slice(0, 24).map(function(x) {
      return '<button class="chip" data-entity="' + escHtml(x.entity) + '">' + escHtml(x.entity) + ' <b>' + x.count + '</b></button>';
    }).join('') || '<span class="muted">none</span>';
  }).catch(lifeError);
  loadLoops();
  loadNow();
  startLive();
}

function loadLoops() {
  v1('/v1/loops?status=active&limit=50').then(function(r) {
    var today = isoDay(new Date());
    $('#loops-count').textContent = r.loops.length || '';
    $('#life-loops').innerHTML = r.loops.length ? r.loops.map(function(l) {
      var due = l.due_date ? '<span class="due' + (l.due_date < today ? ' overdue' : '') + '">' + escHtml(l.due_date) + '</span>' : '';
      return '<div class="loop" data-id="' + l.id + '"><button class="btn btn-sm loop-done" title="Mark done">&#10003;</button>' +
        '<span class="loop-text">' + escHtml(l.text) + '</span>' + due +
        '<button class="btn btn-sm loop-snooze" title="Snooze 1 day">z</button>' +
        '<button class="btn btn-sm loop-drop" title="Drop">&times;</button></div>';
    }).join('') : '<div class="empty-state">No open loops. Nice.</div>';
  }).catch(lifeError);
}

function loadNow() {
  Promise.all([v1('/v1/now'), v1('/v1/habits'), v1('/v1/sources')]).then(function(r) {
    var n = r[0], habits = r[1].habits || [], sources = (r[2].sources || []).filter(function(s) { return s.continuous; });
    var where = n.where ? (n.where.place || n.where.lat.toFixed(4) + ', ' + n.where.lon.toFixed(4)) : null;
    var html = '<div class="now-row"><span class="muted">Where</span> ' + (where ? '<b>' + escHtml(where) + '</b>' : '<span class="muted">unknown</span>') + '</div>';
    (n.next || []).forEach(function(e) {
      var when = e.in_progress
        ? 'now' + (e.ended_at ? ' – ' + new Date(e.ended_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '')
        : new Date(e.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
      html += '<div class="now-row"><span class="muted">' + (e.in_progress ? 'In' : 'Next') + '</span> <b>' + escHtml(e.summary) + '</b> <span class="muted">' + escHtml(when) + '</span></div>';
    });
    if (habits.length) html += '<div class="chips">' + habits.map(function(h) {
      var t = h.last ? (h.days_ago === 0 ? 'today' : h.days_ago + 'd') : 'never';
      return '<span class="chip' + (h.overdue ? ' warn' : '') + '" title="every ' + h.every_days + 'd · ' + h.done_30d + '× in 30d">' +
        (h.overdue ? '&#9888; ' : '&#10003; ') + escHtml(h.name) + ' <b>' + t + (h.streak > 1 ? ' · ' + h.streak + '&#128293;' : '') + '</b></span>';
    }).join('') + '</div>';
    if (sources.length) html += '<div class="chips">' + sources.map(function(s) {
      return '<span class="chip' + (s.stale ? ' warn' : '') + '" title="p90 gap ' + s.p90_gap_hours + 'h">' +
        (s.stale ? '&#9888; ' : '&#9679; ') + escHtml(s.source) + ' <b>' + s.hours_since + 'h</b></span>';
    }).join('') + '</div>';
    $('#life-now').innerHTML = html;
  }).catch(lifeError);
}

function setLoop(id, status) {
  var body = { status: status };
  if (status === 'snoozed') body.snooze_until = new Date(Date.now() + 864e5).toISOString();
  v1('/v1/loops/' + encodeURIComponent(id), { method: 'PATCH', body: body }).then(function() {
    showToast('Loop ' + status, 'success');
    loadLoops();
  }).catch(lifeError);
}

function lifeError(e) {
  var msg = String(e && e.message || e);
  showToast(/unauthori|forbidden|401|403/i.test(msg) ? 'API key needed — click Key' : msg, 'error');
}

function runRecall(q) {
  var out = $('#recall-out');
  out.classList.remove('hidden');
  out.textContent = 'Recalling…';
  fetch('/v1/recall?format=markdown&limit=25&q=' + encodeURIComponent(q), { headers: authHeaders() })
    .then(function(r) { return r.text().then(function(t) { if (!r.ok) throw new Error(t); return t; }); })
    .then(function(t) { out.textContent = t || 'No matches.'; })
    .catch(function(e) { out.textContent = String(e.message || e); });
}

/* SSE over fetch so the Authorization header can be sent (EventSource can't). */
function startLive() {
  if (life.live) return;
  var ctrl = new AbortController();
  life.live = ctrl;
  var dot = $('#live-status');
  fetch('/v1/stream', { headers: authHeaders(), signal: ctrl.signal }).then(function(r) {
    if (!r.ok || !r.body) throw new Error('stream ' + r.status);
    dot.className = 'live-dot on';
    var reader = r.body.getReader(), dec = new TextDecoder(), buf = '';
    function pump() {
      return reader.read().then(function(x) {
        if (x.done) throw new Error('closed');
        buf += dec.decode(x.value, { stream: true });
        var parts = buf.split('\n\n');
        buf = parts.pop();
        parts.forEach(function(block) {
          var data = block.split('\n').filter(function(l) { return l.indexOf('data:') === 0; })
            .map(function(l) { return l.slice(5).trim(); }).join('');
          if (!data) return;
          try { onLive(JSON.parse(data)); } catch (_) { /* heartbeat or partial */ }
        });
        return pump();
      });
    }
    return pump();
  }).catch(function() {
    dot.className = 'live-dot';
    life.live = null;
    if (!ctrl.signal.aborted) setTimeout(function() { if (!$('#view-life').classList.contains('hidden')) startLive(); }, 5000);
  });
}

function onLive(e) {
  if (!e || !e.id) return;
  var t = new Date(e.occurred_at);
  var feed = $('#live-feed');
  feed.insertAdjacentHTML('afterbegin', entryHtml({
    time: String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'),
    stream: e.stream, kind: e.kind, summary: e.text || e.kind, importance: e.importance,
  }));
  while (feed.children.length > 50) feed.removeChild(feed.lastChild);
  if (life.date === isoDay(t)) loadLife();
}

function lifeGo(day) { life.date = day; loadLife(); }
$('#life-prev').addEventListener('click', function() { lifeGo(shiftDay(life.date, -1)); });
$('#life-next').addEventListener('click', function() { lifeGo(shiftDay(life.date, 1)); });
$('#life-today').addEventListener('click', function() { lifeGo(isoDay(new Date())); });
$('#life-date').addEventListener('change', function() { if (this.value) lifeGo(this.value); });
$('#life-token').addEventListener('click', function() {
  var cur = localStorage.getItem('dendrite.token') || '';
  var t = prompt('API key (stored in this browser only; blank to clear):', cur);
  if (t === null) return;
  if (t) localStorage.setItem('dendrite.token', t.trim()); else localStorage.removeItem('dendrite.token');
  if (life.live) { life.live.abort(); life.live = null; }
  loadLife();
});
$('#recall-form').addEventListener('submit', function(ev) {
  ev.preventDefault();
  var q = $('#recall-q').value.trim();
  if (q) runRecall(q);
});
$('#life-entities').addEventListener('click', function(ev) {
  var b = ev.target.closest('.chip');
  if (!b) return;
  $('#recall-q').value = b.dataset.entity;
  runRecall(b.dataset.entity);
});
$('#life-loops').addEventListener('click', function(ev) {
  var row = ev.target.closest('.loop');
  if (!row) return;
  if (ev.target.closest('.loop-done')) setLoop(row.dataset.id, 'done');
  else if (ev.target.closest('.loop-snooze')) setLoop(row.dataset.id, 'snoozed');
  else if (ev.target.closest('.loop-drop')) setLoop(row.dataset.id, 'dropped');
});
