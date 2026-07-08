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

    // ── Dropdown — hover (desktop) + click (touch/keyboard) ──────────────────
    // The dropdown is wider than the button and may overflow the parent div,
    // so we listen for mouseenter/mouseleave on BOTH the wrapper AND the panel,
    // with a 150ms close delay so the cursor can travel across the gap safely.
    document.querySelectorAll('.wb-has-dropdown').forEach(function (wrap) {
      var dropdown = wrap.querySelector('.wb-dropdown');
      var btn      = wrap.querySelector('.wb-dropdown-btn');
      var timer    = null;

      function openDrop() {
        clearTimeout(timer);
        wrap.classList.add('wb-dd-open');
        if (btn) btn.setAttribute('aria-expanded', 'true');
      }

      function scheduledClose() {
        clearTimeout(timer);
        timer = setTimeout(function () {
          wrap.classList.remove('wb-dd-open');
          if (btn) btn.setAttribute('aria-expanded', 'false');
        }, 150);
      }

      wrap.addEventListener('mouseenter', openDrop);
      wrap.addEventListener('mouseleave', scheduledClose);

      // Also listen on the dropdown panel itself — its overflow may sit outside
      // the wrapper div's bounding box, causing mouseleave to fire too early.
      if (dropdown) {
        dropdown.addEventListener('mouseenter', openDrop);
        dropdown.addEventListener('mouseleave', scheduledClose);
      }

      // Click/keyboard toggle (works for touch devices and keyboard nav)
      if (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          clearTimeout(timer);
          var isOpen = wrap.classList.toggle('wb-dd-open');
          btn.setAttribute('aria-expanded', String(isOpen));
        });
      }
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

    // ── Mobile "Our Services" accordion ───────────────────────────────────────
    // The mobile menu lists every service link flat. Group them under a
    // collapsible "Our Services" toggle so the menu stays short and scannable.
    // Built in JS so all pages get it from this one shared file; if JS fails,
    // the links simply stay visible (the original flat behavior).
    (function buildMobileServicesAccordion() {
      if (!mobileMenu) return;
      var inner = mobileMenu.querySelector('.wb-mob-inner');
      if (!inner) return;
      var subs = inner.querySelectorAll('.wb-mob-sub');
      if (!subs.length) return;

      // The "All Services" link sits just before the first sub-item.
      var group = [];
      var allServices = subs[0].previousElementSibling;
      if (allServices && allServices.classList.contains('wb-mob-link') &&
          !allServices.classList.contains('wb-mob-sub')) {
        group.push(allServices);
      }
      Array.prototype.forEach.call(subs, function (s) { group.push(s); });
      if (!group.length) return;

      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'wb-mob-accordion';
      toggle.setAttribute('aria-controls', 'wb-mob-services');
      toggle.innerHTML =
        '<span><i class="fas fa-th-large"></i> Our Services</span>' +
        '<i class="fas fa-chevron-down wb-mob-acc-chevron"></i>';

      var panel = document.createElement('div');
      panel.className = 'wb-mob-submenu';
      panel.id = 'wb-mob-services';

      // Drop the toggle + panel where the group currently starts, then move
      // each service link inside the panel.
      group[0].parentNode.insertBefore(toggle, group[0]);
      group[0].parentNode.insertBefore(panel, group[0]);
      group.forEach(function (el) { panel.appendChild(el); });

      // If the visitor is on a service page, start expanded so the active
      // item is visible right away.
      var startOpen = svcPages.indexOf(path) !== -1;
      panel.classList.toggle('wb-open', startOpen);
      toggle.classList.toggle('wb-open', startOpen);
      toggle.setAttribute('aria-expanded', String(startOpen));

      toggle.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = panel.classList.toggle('wb-open');
        toggle.classList.toggle('wb-open', open);
        toggle.setAttribute('aria-expanded', String(open));
      });
    })();

    // ── Mobile menu backdrop ──────────────────────────────────────────────────
    // A blurred, dimmed scrim behind the open menu so it reads as its own layer
    // instead of blending into the page. Synced to the menu via a class observer
    // so it tracks every open/close path (hamburger, outside-click, Escape,
    // scroll-hide) without touching each handler.
    if (mobileMenu) {
      var backdrop = document.createElement('div');
      backdrop.className = 'wb-mob-backdrop';
      backdrop.setAttribute('aria-hidden', 'true');
      document.body.appendChild(backdrop);

      var syncBackdrop = function () {
        var open = mobileMenu.classList.contains('wb-open');
        backdrop.classList.toggle('wb-show', open);
        // Keep aria-hidden + inert in sync with the menu state. `inert` removes
        // the closed menu's links from the tab order AND the accessibility tree,
        // so an aria-hidden container never holds focusable children (fixes the
        // "accessibility tree is not well-formed" / aria-hidden-focus audit).
        mobileMenu.setAttribute('aria-hidden', String(!open));
        if (open) { mobileMenu.removeAttribute('inert'); }
        else { mobileMenu.setAttribute('inert', ''); }
      };

      if (window.MutationObserver) {
        new MutationObserver(syncBackdrop).observe(mobileMenu, {
          attributes: true, attributeFilter: ['class']
        });
      }

      // Tapping the scrim closes the menu.
      backdrop.addEventListener('click', function () {
        mobileMenu.classList.remove('wb-open');
        mobileMenu.setAttribute('aria-hidden', 'true');
        if (hamburger) {
          hamburger.setAttribute('aria-expanded', 'false');
          hamburger.setAttribute('aria-label', 'Open menu');
        }
        document.dispatchEvent(new CustomEvent('wbMobileMenu', { detail: { open: false } }));
      });

      syncBackdrop();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNav);
  } else {
    initNav();
  }
})();
