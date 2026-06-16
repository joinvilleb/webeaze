// WebEaze custom nav — hamburger, dropdown, scroll hide, active links
(function () {
  'use strict';

  function initNav() {
    var header    = document.getElementById('wb-header');
    var hamburger = document.getElementById('wb-hamburger');
    var mobileMenu = document.getElementById('wb-mobile-menu');

    if (!header) return;

    // ── Hamburger toggle ──────────────────────────────────────────────────────
    if (hamburger && mobileMenu) {
      hamburger.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = mobileMenu.classList.toggle('wb-open');
        hamburger.setAttribute('aria-expanded', String(open));
        mobileMenu.setAttribute('aria-hidden', String(!open));
        hamburger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
        document.dispatchEvent(new CustomEvent('wbMobileMenu', { detail: { open: open } }));
      });
    }

    // ── Dropdown (click for touch, hover for mouse — CSS handles hover) ───────
    document.querySelectorAll('.wb-has-dropdown .wb-dropdown-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var wrap = btn.closest('.wb-has-dropdown');
        var open = wrap.classList.toggle('wb-dd-open');
        btn.setAttribute('aria-expanded', String(open));
      });
    });

    // ── Close menus on outside click ──────────────────────────────────────────
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.wb-has-dropdown')) {
        document.querySelectorAll('.wb-has-dropdown.wb-dd-open').forEach(function (wrap) {
          wrap.classList.remove('wb-dd-open');
          var btn = wrap.querySelector('.wb-dropdown-btn');
          if (btn) btn.setAttribute('aria-expanded', 'false');
        });
      }
      if (mobileMenu && !e.target.closest('#wb-header')) {
        mobileMenu.classList.remove('wb-open');
        mobileMenu.setAttribute('aria-hidden', 'true');
        if (hamburger) {
          hamburger.setAttribute('aria-expanded', 'false');
          hamburger.setAttribute('aria-label', 'Open menu');
        }
        document.dispatchEvent(new CustomEvent('wbMobileMenu', { detail: { open: false } }));
      }
    });

    // ── Escape closes everything ──────────────────────────────────────────────
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      document.querySelectorAll('.wb-has-dropdown.wb-dd-open').forEach(function (w) {
        w.classList.remove('wb-dd-open');
        var b = w.querySelector('.wb-dropdown-btn');
        if (b) b.setAttribute('aria-expanded', 'false');
      });
      if (mobileMenu && mobileMenu.classList.contains('wb-open')) {
        mobileMenu.classList.remove('wb-open');
        mobileMenu.setAttribute('aria-hidden', 'true');
        if (hamburger) {
          hamburger.setAttribute('aria-expanded', 'false');
          hamburger.setAttribute('aria-label', 'Open menu');
        }
        document.dispatchEvent(new CustomEvent('wbMobileMenu', { detail: { open: false } }));
      }
    });

    // ── Scroll hide/show ──────────────────────────────────────────────────────
    var lastY = 0;
    var navVisible = true;

    function setNavVisible(show) {
      navVisible = show;
      if (show) {
        header.classList.remove('wb-nav-hidden');
      } else {
        header.classList.add('wb-nav-hidden');
        // also close mobile menu if hiding nav
        if (mobileMenu) {
          mobileMenu.classList.remove('wb-open');
          if (hamburger) hamburger.setAttribute('aria-expanded', 'false');
        }
      }
      document.dispatchEvent(new CustomEvent('wbNavVisibility', { detail: { visible: show } }));
    }

    window.addEventListener('scroll', function () {
      var y = window.pageYOffset || 0;
      header.classList.toggle('wb-scrolled', y > 10);
      if (y > lastY && y > 80) {
        if (navVisible) setNavVisible(false);
      } else if (y < lastY) {
        if (!navVisible) setNavVisible(true);
      }
      lastY = y <= 0 ? 0 : y;
    }, { passive: true });

    // ── Active nav links ──────────────────────────────────────────────────────
    var pathname = window.location.pathname;
    var path = (pathname.split('/').pop() || 'index.html').split('?')[0];
    var inBlog = pathname.indexOf('/blog/') !== -1 || path === 'blog.html';
    var svcPages = ['services.html', 'manage.html', 'maintenance.html', 'seo.html',
      'google-business-management.html', 'ai.html', 'ads.html', 'one-time-project.html', 'plan-guide.html'];

    document.querySelectorAll('.wb-nav-link[href], .wb-mob-link[href]').forEach(function (link) {
      var href = (link.getAttribute('href') || '').split('?')[0];
      var bare = href.replace(/^\.\.\//, '');
      if (href === path || bare === path) {
        link.classList.add('wb-active');
      } else if (inBlog && (bare === 'blog.html' || href === 'blog.html')) {
        link.classList.add('wb-active');
      }
    });

    if (svcPages.indexOf(path) !== -1) {
      var dropBtn = document.querySelector('.wb-dropdown-btn');
      if (dropBtn) dropBtn.classList.add('wb-active');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNav);
  } else {
    initNav();
  }
})();
