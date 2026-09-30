/*
 * Site analytics — SAFE by construction. This file NEVER sends anything a
 * person typed, pasted, dropped, or the demo's result text: only fixed event
 * names, fixed target names, coarse size/length BUCKETS, and (for outbound
 * links) the destination hostname. Autocapture and session recording are off
 * (see the posthog.init config); this is the only source of interaction events.
 * Feature-detects per page, so demo hooks run only where the demo exists.
 */
(function () {
  if (!window.posthog) return;
  var ph = window.posthog;
  function t(name, props) { try { ph.capture(name, props || {}); } catch (e) {} }

  // ---- Clicks (event delegation, fixed names) --------------------------------
  var LINK_MAP = [
    ['npmjs.com/package/rulereceipt', 'npm'],
    ['github.com/rulereceipt', 'github'],
    ['producthunt.com', 'product_hunt'],
    ['/accuracy', 'accuracy'],
    ['known-gaps', 'known_gaps'],
    ['KNOWN-GAPS', 'known_gaps'],
    ['/privacy', 'privacy'],
    ['/terms', 'terms'],
    ['/postmortem', 'postmortem'],
    ['/check', 'demo_open'],
    ['x.com/RuleReceipt', 'x'],
    ['linkedin.com', 'linkedin']
  ];
  function targetFor(href) {
    for (var i = 0; i < LINK_MAP.length; i++) {
      if (href.indexOf(LINK_MAP[i][0]) !== -1) return LINK_MAP[i][1];
    }
    return null;
  }
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('a, button') : null;
    if (!el) return;
    // The copy-install buttons fire their own copy_install_command event.
    if (el.hasAttribute('data-copy') || el.classList.contains('copy')) return;
    if (el.tagName !== 'A') return;
    var href = el.getAttribute('href') || '';
    var name = targetFor(href);
    if (!name) return;
    var props = { target: name };
    if (/^https?:\/\//.test(href)) {
      try { props.destination_domain = new URL(href).hostname; } catch (e2) {}
    }
    t('click', props);
  }, true);

  // ---- Waitlist open (first focus on the email field) ------------------------
  var email = document.getElementById('signup-email');
  if (email) {
    var opened = false;
    email.addEventListener('focus', function () { if (!opened) { opened = true; t('waitlist_open'); } });
  }

  // ---- Demo (check.html only) — sizes/buckets only, never content ------------
  var demo = document.getElementById('demo');
  var drop = document.getElementById('drop');
  var started = false;
  function demoStart() { if (!started) { started = true; t('demo_started'); } }
  function charsBucket(n) { return n < 1000 ? '<1k' : (n <= 10000 ? '1-10k' : '>10k'); }
  function sizeBucket(bytes) { var mb = bytes / (1024 * 1024); return mb < 1 ? '<1MB' : (mb <= 10 ? '1-10MB' : '>10MB'); }

  if (demo) {
    demo.addEventListener('paste', function () {
      demoStart();
      // Read the length AFTER the paste applies; the text itself is never sent.
      setTimeout(function () { t('demo_rules_pasted', { chars_bucket: charsBucket((demo.value || '').length) }); }, 0);
    });
    demo.addEventListener('input', function () { demoStart(); }, { once: true });
  }
  if (drop) {
    function handleFiles(files) {
      if (!files || !files.length) return;
      demoStart();
      t('demo_session_dropped', { size_bucket: sizeBucket(files[0].size || 0) });
    }
    // #drop may be the file input itself or a container holding one.
    var fileInput = (drop.tagName === 'INPUT') ? drop : (drop.querySelector ? drop.querySelector('input[type=file]') : null);
    if (fileInput) fileInput.addEventListener('change', function (e) { handleFiles(e.target.files); });
    drop.addEventListener('drop', function (e) {
      try { handleFiles(e.dataTransfer && e.dataTransfer.files); } catch (er) {}
    });
  }
})();
