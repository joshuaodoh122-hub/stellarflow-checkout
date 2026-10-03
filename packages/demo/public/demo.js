(function () {
  var API_URL = window.location.origin;

  // Inject API URL into all widget containers
  document.querySelectorAll('[data-stellarflow]').forEach(function (el) {
    el.dataset.apiUrl = API_URL;
  });

  // Fetch network info and update UI
  fetch(API_URL + '/health')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var badge = document.getElementById('network-info');
      var headerBadge = document.getElementById('network-badge');
      if (data.network === 'mainnet') {
        badge.textContent = '⚠️ MAINNET — real funds';
        badge.className = 'network-badge mainnet';
        headerBadge.textContent = 'MAINNET';
        headerBadge.style.background = '#dc2626';
      } else {
        badge.textContent = '🧪 TESTNET — no real funds';
        badge.className = 'network-badge';
        headerBadge.textContent = 'TESTNET';
      }

      // Show integration snippet with actual API URL
      var snippet = document.getElementById('integration-snippet');
      if (snippet) {
        snippet.textContent = [
          '<script src="stellarflow-widget.js"',
          '  integrity="sha384-..." crossorigin="anonymous"><\/script>',
          '',
          '<div data-stellarflow',
          '  data-api-url="' + API_URL + '"',
          '  data-fiat-amount="9.99"',
          '  data-asset="XLM"',
          '  data-label="Your Product"><\/div>',
          '',
          '<script>StellarFlow.init();<\/script>',
        ].join('\n');
      }
    })
    .catch(function () {});

  // Initialize all widgets
  StellarFlow.init();

  // Event logging
  var log = document.getElementById('event-log');
  function logEvent(msg, color) {
    var p = document.createElement('p');
    var ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = new Date().toISOString().slice(11, 23) + ' ';
    p.appendChild(ts);
    p.appendChild(document.createTextNode(msg));
    if (color) p.style.color = color;
    log.appendChild(p);
    log.scrollTop = log.scrollHeight;
  }

  document.addEventListener('stellarflow:paid', function (e) {
    logEvent('✅ stellarflow:paid — order ' + e.detail.orderId, '#22c55e');
  });
  document.addEventListener('stellarflow:review', function (e) {
    logEvent('⚠️  stellarflow:review — order ' + e.detail.orderId + ' status=' + e.detail.status, '#f59e0b');
  });
  document.addEventListener('stellarflow:error', function (e) {
    logEvent('❌ stellarflow:error — ' + e.detail.message, '#ef4444');
  });
})();
