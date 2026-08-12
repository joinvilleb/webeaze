(function () {
  var cfg      = window.WZ_CHAT_PAGE || {};
  var greeting = cfg.greeting || "Hi! I’m Eazy, your WebEaze assistant. Ask me anything about our plans, pricing, or process.";
  var starters = cfg.starters || [
    { label: 'Plans & pricing',  msg: 'What plans do you offer?' },
    { label: "What’s included", msg: "What’s included in the Essential plan?" },
    { label: 'How long to launch', msg: 'How long does it take to launch my site?' },
    { label: 'Contracts?',       msg: 'Do you require a contract?' },
  ];

  // Render starter buttons
  var $starters = document.getElementById('wzStarters');
  if ($starters) {
    $starters.innerHTML = starters.map(function (s) {
      return '<button class="wz-starter" onclick="wzSend(\'' + s.msg.replace(/'/g, "\\'") + '\')">' + s.label + '</button>';
    }).join('');
  }

  var history = [];
  var busy    = false;
  var opened  = false;

  window.wzOpenChat = function () {
    var panel = document.getElementById('wz-chat-panel');
    var btn   = document.getElementById('wz-chat-btn');
    var badge = document.getElementById('wzBadge');
    if (panel) { panel.removeAttribute('hidden'); panel.classList.add('open'); }
    if (btn)     btn.removeAttribute('hidden');
    if (badge)   badge.style.display = 'none';
    if (!opened) {
      opened = true;
      wzAppend('bot', greeting);
    }
    setTimeout(function () {
      var inp = document.getElementById('wz-chat-input');
      if (inp) inp.focus();
    }, 220);
  };

  window.wzCloseChat = function () {
    var panel = document.getElementById('wz-chat-panel');
    if (panel) panel.classList.remove('open');
  };

  window.wzSend = function (preset) {
    if (busy) return;
    var input = document.getElementById('wz-chat-input');
    var text  = (preset || (input && input.value) || '').trim();
    if (!text) return;

    if (!preset && input) { input.value = ''; input.style.height = 'auto'; }
    if ($starters) $starters.style.display = 'none';

    wzAppend('user', text);
    var typing  = wzAppend('bot typing', null);
    busy = true;
    var sendBtn = document.getElementById('wz-chat-send');
    if (sendBtn) sendBtn.disabled = true;

    history.push({ role: 'user', content: text });

    fetch('https://webeaze.netlify.app/.netlify/functions/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, history: history.slice(0, -1) }),
    })
      .then(function (r) { return r.text().then(function (t) { return { s: r.status, t: t }; }); })
      .then(function (r) {
        var reply, ok = false;
        try {
          var d = JSON.parse(r.t);
          if (d.reply) { reply = d.reply; ok = true; }
          else { reply = d.error || 'Something went wrong — try <a href="website-request.html">submitting a request</a> instead.'; }
        } catch (e) {
          reply = 'Something went wrong — try <a href="website-request.html">submitting a request</a> instead.';
        }
        if (ok) {
          history.push({ role: 'assistant', content: reply });
          if (history.length > 20) history = history.slice(-20);
        }
        wzFill(typing, 'bot', reply);
      })
      .catch(function () {
        wzFill(typing, 'bot', 'Network error — try <a href="website-request.html">submitting a request</a> instead.');
      })
      .finally(function () {
        busy = false;
        if (sendBtn) sendBtn.disabled = false;
      });
  };

  function wzScrollBottom() {
    var msgs = document.getElementById('wz-chat-msgs');
    if (!msgs) return;
    var go = function () { msgs.scrollTop = msgs.scrollHeight; };
    // Always scroll downward to the end, after layout settles (covers long,
    // wrapped replies) so it never bumps back up.
    go();
    if (window.requestAnimationFrame) requestAnimationFrame(go);
    setTimeout(go, 60);
  }

  function wzAppend(cls, text) {
    var msgs = document.getElementById('wz-chat-msgs');
    var el   = document.createElement('div');
    el.className = 'wz-msg ' + cls;
    if (cls.includes('typing')) {
      el.innerHTML = '<span></span><span></span><span></span>';
    } else {
      el.innerHTML = wzSanitize(text);
    }
    msgs.appendChild(el);
    wzScrollBottom();
    return el;
  }

  // Turn the typing bubble into the reply in place, so the list never
  // shrinks-then-grows (which is what made it bump up and down).
  function wzFill(el, cls, text) {
    el.className = 'wz-msg ' + cls;
    el.innerHTML = wzSanitize(text);
    wzScrollBottom();
  }

  function wzSanitize(text) {
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
      .replace(/([a-zA-Z0-9_-]+\.html(?:#\/[a-zA-Z0-9_-]+)?)/g, '<a href="$1">$1</a>')
      .replace(/\n/g, '<br>');
  }

  // Notification badge after 8 s if chat never opened
  setTimeout(function () {
    if (!opened) {
      var badge = document.getElementById('wzBadge');
      if (badge) badge.style.display = 'block';
    }
  }, 8000);
})();
