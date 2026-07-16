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

function renderWikilinks(text) {
  return escHtml(text).replace(/\[\[([^\]]+)\]\]/g, function(_m, slug) {
    return '<span class="wikilink">[[' + escHtml(slug) + ']]</span>';
  });
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

/* ---------- Health strip ---------- */
function loadHealth() {
  api('/api/health').then(function(h) {
    if (!h.ok) return;
    var cov = h.embedding_coverage || {};
    var q = h.queue || {};
    var items = [];

    if (h.embeddings_enabled) {
      var covCls = cov.pct >= 80 ? 'ok' : cov.pct >= 40 ? '' : 'warn';
      items.push('<span class="health-item ' + covCls + '"><span class="label">Embeddings</span><span class="value">' +
        (cov.pct || 0) + '%</span></span>');
    } else {
      items.push('<span class="health-item"><span class="label">Embeddings</span><span class="value">off</span></span>');
    }

    var queueCls = q.pending > 0 ? 'warn' : 'ok';
    items.push('<span class="health-item ' + queueCls + '"><span class="label">Queue</span><span class="value">' +
      (q.pending || 0) + ' pending</span></span>');

    var danglingCls = h.dangling_links > 0 ? 'warn' : 'ok';
    items.push('<span class="health-item ' + danglingCls + '"><span class="label">Dangling links</span><span class="value">' +
      (h.dangling_links || 0) + '</span></span>');

    $('#health-strip').innerHTML = items.join('');
  }).catch(function() {
    $('#health-strip').innerHTML = '<span class="health-item"><span class="value">Health unavailable</span></span>';
  });
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
    var cardsHtml = '';
    cardsHtml += '<div class="stat-card clickable" id="stat-inbox" onclick="switchTab(\'triage\')">' +
      '<span class="label">Inbox</span><span class="value">' + data.inbox_count + '</span>' +
      '<span class="hint">unfiled</span></div>';
    cardsHtml += '<div class="stat-card"><span class="label">Today</span><span class="value">' + data.today_count +
      '</span><span class="hint">captures</span></div>';
    cardsHtml += '<div class="stat-card"><span class="label">This week</span><span class="value">' + data.week_count +
      '</span><span class="hint">captures</span></div>';
    $('#stats-cards').innerHTML = cardsHtml;

    var barsHtml = '';
    var maxCount = 1;
    (data.compartments || []).forEach(function(c) { if (c.count > maxCount) maxCount = c.count; });
    if ((data.compartments || []).length === 0) {
      barsHtml = '<div class="empty-state"><p class="empty-title">No notes indexed</p>' +
        '<p class="empty-detail">Run ingest or sort to populate compartments.</p></div>';
    } else {
      (data.compartments || []).forEach(function(c) {
        var pct = (c.count / maxCount) * 100;
        barsHtml += '<div class="comp-bar">' +
          '<span class="name">' + escHtml(c.name) + '</span>' +
          '<div class="bar"><div class="fill" style="width:' + pct + '%"></div></div>' +
          '<span class="count">' + c.count + '</span></div>';
      });
    }
    $('#compartment-bars').innerHTML = barsHtml;

    var lcEl = $('#latest-capture');
    if (data.latest_capture) {
      var lc = data.latest_capture;
      var confCls = colorClass(lc.confidence);
      lcEl.className = 'latest-capture';
      lcEl.innerHTML =
        '<span class="time">' + lc.received_at.slice(11, 16) + '</span>' +
        '<span class="comp-badge ' + lc.compartment + '">' + lc.compartment + '</span>' +
        '<span class="title">' + escHtml(lc.title || lc.path) + '</span>' +
        '<span class="conf ' + confCls + '">' + lc.confidence.toFixed(2) + '</span>';
    } else {
      lcEl.className = 'latest-capture empty-hint';
      lcEl.innerHTML = 'No captures yet. Send a thought via CLI, Telegram, or webhook.';
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
        var safePath = note.path.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        html += '<div class="inbox-card" data-path="' + escHtml(note.path) + '" style="--conf-color:' +
          confColor(note.confidence) + '">' +
          '<div class="filename">' + escHtml(note.path) + segBadge + '</div>' +
          '<div class="preview">' + escHtml((note.body_preview || note.summary || '').slice(0, 240)) + '</div>' +
          '<div class="meta">' +
          '<span class="comp-badge ' + (note.compartment || 'inbox') + '">' + (note.compartment || 'inbox') +
          '</span> ' +
          '<span class="' + confCls + '">' + note.confidence.toFixed(2) + '</span> · ' +
          '<span>' + (note.created ? note.created.slice(11, 16) : '') + '</span> · ' +
          '<span>' + sourceLabel(note.source) + '</span>' +
          '</div>' +
          '<div class="actions">' +
          '<button class="btn btn-approve" onclick="doApprove(\'' + safePath + '\')">Approve</button>' +
          '<select class="compartment-select" onchange="doReclassify(\'' + safePath + '\', this.value)">' +
          '<option value="">Reclassify...</option>' +
          '</select>' +
          '<button class="btn btn-reject" onclick="doReject(this, \'' + safePath + '\')">Reject</button>' +
          '</div></div>';
      });
      $('#inbox-queue').innerHTML = html;

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

  api('/api/recent?limit=20').then(function(notes) {
    if (!notes.length) {
      $('#recent-captures').innerHTML = '';
      $('#recent-empty').classList.remove('hidden');
      return;
    }
    $('#recent-empty').classList.add('hidden');
    var html = '';
    notes.forEach(function(n) {
      var confCls = colorClass(n.confidence);
      var safePath = n.path.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      html += '<div class="recent-row" onclick="openNoteModal(\'' + safePath + '\')">' +
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
      showToast('Approved to ' + r.compartment, 'success');
      removeCard(path);
      loadTriage();
      loadHealth();
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
    btn.textContent = 'Confirm?';
    setTimeout(function() {
      btn.classList.remove('confirming');
      btn.textContent = 'Reject';
    }, 2500);
    return;
  }
  api('/api/triage/reject', { method: 'POST', body: { path: path } }).then(function(r) {
    if (r.ok) {
      showToast('Rejected and moved to trash', 'success');
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
    var safePath = path.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
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
        '<button class="btn btn-approve" onclick="doApprove(\'' + safePath + '\')">Approve</button>' +
        '<select class="compartment-select" onchange="doReclassify(\'' + safePath +
        '\', this.value); closeModal();">' +
        '<option value="">Reclassify...</option></select>' +
        '<button class="btn btn-reject" onclick="doReject(this, \'' + safePath + '\'); setTimeout(closeModal, 500)">Reject</button>' +
        '</div>';
    } else {
      actionHtml = '<div class="modal-filed-note">Already filed in ' + comp + '/</div>';
    }

    var popupHtml =
      '<div class="modal-content">' +
      '<div class="modal-header"><span class="modal-title">' + escHtml(path.split('/').pop()) +
      '</span><span class="modal-close" onclick="closeModal()">x</span></div>' +
      '<div class="modal-meta">' + metaHtml + '</div>' +
      '<pre class="modal-body">' + escHtml(data.body || '') + '</pre>' +
      actionHtml + '</div>';

    openModal(popupHtml);

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

/* ---------- Ask tab ---------- */
$('#ask-form').addEventListener('submit', function(e) {
  e.preventDefault();
  var q = $('#ask-input').value.trim();
  if (!q) return;

  $('#ask-error').classList.add('hidden');
  $('#ask-result').classList.add('hidden');
  $('#ask-loading').classList.remove('hidden');
  $('#ask-submit').disabled = true;

  api('/api/ask', { method: 'POST', body: { question: q } }).then(function(r) {
    $('#ask-loading').classList.add('hidden');
    $('#ask-submit').disabled = false;

    if (!r.ok) {
      $('#ask-error').textContent = r.error || 'Ask failed';
      $('#ask-error').classList.remove('hidden');
      return;
    }

    $('#ask-answer').innerHTML = renderWikilinks(r.answer || '');
    $('#ask-result').classList.remove('hidden');

    var sources = r.sources || [];
    if (sources.length > 0) {
      var listHtml = '';
      sources.forEach(function(s) {
        listHtml += '<li><span class="wikilink">[[' + escHtml(s.slug) + ']]</span> ' +
          escHtml(s.title) + ' <span class="path">(' + escHtml(s.path) + ')</span></li>';
      });
      $('#ask-sources-list').innerHTML = listHtml;
      $('#ask-sources').classList.remove('hidden');
    } else {
      $('#ask-sources').classList.add('hidden');
    }
  }).catch(function() {
    $('#ask-loading').classList.add('hidden');
    $('#ask-submit').disabled = false;
    $('#ask-error').textContent = 'Request failed. Is the LLM reachable?';
    $('#ask-error').classList.remove('hidden');
  });
});

/* ---------- Refresh button ---------- */
$('#refresh-inbox').addEventListener('click', function() {
  loadTriage();
  loadHealth();
});

/* ---------- Init ---------- */
loadGlance();
loadHealth();

setInterval(function() {
  loadGlance();
  loadHealth();
}, 30000);
