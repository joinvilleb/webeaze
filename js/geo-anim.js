/* WebEaze geo-page click ripple.
   Spawns a ripple from the pointer position on interactive elements.
   Skipped entirely when the visitor prefers reduced motion. Plan cards
   are excluded on purpose: they carry a badge that overflows the top,
   so clipping a ripple would cut it off (they get a CSS press instead). */
(function () {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var SELECTOR = '.btn-gold, .btn-ghost, .chip, .value-band-item, details.faq-item summary';

  document.addEventListener('pointerdown', function (e) {
    if (e.button && e.button !== 0) return; // primary click / touch only
    var host = e.target.closest(SELECTOR);
    if (!host) return;

    host.classList.add('wb-ripple-host');
    var rect = host.getBoundingClientRect();
    var size = Math.max(rect.width, rect.height);

    var ripple = document.createElement('span');
    ripple.className = 'wb-ripple';
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';

    ripple.addEventListener('animationend', function () { ripple.remove(); });
    host.appendChild(ripple);
  }, { passive: true });
})();
