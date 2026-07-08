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
function api(path, opts) {
  opts = opts || {};
  return fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }).then(function(r) { return r.json(); });
}

/* ---------- Tab switching ---------- */
function switchTab(name) {
  $$('.tab').forEach(function(t) { t.classList.toggle('active', t.dataset.tab === name); });
  $$('.view').forEach(function(v) { v.classList.toggle('hidden', v.id !== 'view-' + name); });
  if (name === 'triage') loadTriage();
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