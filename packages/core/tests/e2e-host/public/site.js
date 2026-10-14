// Stands in for a host theme's own scripts. Plain browser JavaScript, no build.
(function () {
  window.__siteScrollEvents = 0;

  document.querySelectorAll('[data-accordion]').forEach(function (accordion) {
    var button = accordion.querySelector('button');
    var panel = accordion.querySelector('[role="region"]');
    if (!button || !panel) return;
    button.addEventListener('click', function (event) {
      // The site owns this click and says so: the shell must leave it alone.
      event.preventDefault();
      var open = button.getAttribute('aria-expanded') === 'true';
      button.setAttribute('aria-expanded', String(!open));
      panel.hidden = open;
    });
  });

  document.querySelectorAll('[data-carousel]').forEach(function (carousel) {
    var track = carousel.querySelector('[data-carousel-track]');
    var count = track ? track.children.length : 0;
    if (!track || count === 0) return;
    function go(step) {
      var index = (Number(track.dataset.index) + step + count) % count;
      track.dataset.index = String(index);
      track.style.transform =
        'translateX(-' + index * track.children[0].offsetWidth + 'px)';
    }
    var previous = carousel.querySelector('[data-carousel-prev]');
    var next = carousel.querySelector('[data-carousel-next]');
    if (previous)
      previous.addEventListener('click', function () {
        go(-1);
      });
    if (next)
      next.addEventListener('click', function () {
        go(1);
      });
  });

  // The item-based blocks. Each init is idempotent per element: the editor's
  // block edit modules call it again through `rendered` when it replaces an
  // element, and the page calls it once for every element at load.
  var BOUND = 'siteBound';

  function setEntryOpen(entry, open) {
    var trigger = entry.querySelector('[data-accordion-trigger]');
    var panel = entry.querySelector('[data-accordion-panel]');
    if (!trigger || !panel) return;
    trigger.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
  }

  function initAccordionList(list) {
    if (list.dataset[BOUND] === 'true') return;
    list.dataset[BOUND] = 'true';
    list.addEventListener('click', function (event) {
      var trigger = event.target.closest('[data-accordion-trigger]');
      if (!trigger || !list.contains(trigger)) return;
      event.preventDefault();
      var entry = trigger.closest('[data-accordion-item]');
      setEntryOpen(entry, trigger.getAttribute('aria-expanded') !== 'true');
    });
  }

  function showTab(tabs, tab) {
    tabs.querySelectorAll('[data-tab]').forEach(function (other) {
      var active = other === tab;
      var trigger = other.querySelector('[data-tab-trigger]');
      var panel = other.querySelector('[data-tab-panel]');
      if (trigger) trigger.setAttribute('aria-selected', String(active));
      if (panel) panel.hidden = !active;
    });
  }

  function initTabs(tabs) {
    if (tabs.dataset[BOUND] === 'true') return;
    tabs.dataset[BOUND] = 'true';
    var first = tabs.querySelector('[data-tab]');
    if (first) showTab(tabs, first);
    tabs.addEventListener('click', function (event) {
      var trigger = event.target.closest('[data-tab-trigger]');
      if (!trigger || !tabs.contains(trigger)) return;
      event.preventDefault();
      showTab(tabs, trigger.closest('[data-tab]'));
    });
  }

  function slidesOf(root) {
    return Array.prototype.slice.call(root.querySelectorAll('[data-slide]'));
  }

  function showSlide(root, slide) {
    slidesOf(root).forEach(function (other) {
      other.hidden = other !== slide;
    });
  }

  function stepSlides(root, step) {
    var all = slidesOf(root);
    if (all.length === 0) return;
    var current = all.findIndex(function (slide) {
      return !slide.hidden;
    });
    showSlide(
      root,
      all[(Math.max(current, 0) + step + all.length) % all.length],
    );
  }

  function initSlides(root) {
    if (root.dataset[BOUND] === 'true') return;
    root.dataset[BOUND] = 'true';
    var all = slidesOf(root);
    if (all.length > 0) showSlide(root, all[0]);
    root.addEventListener('click', function (event) {
      var button = event.target.closest(
        '[data-slides-prev], [data-slides-next]',
      );
      if (!button || !root.contains(button)) return;
      stepSlides(root, button.hasAttribute('data-slides-next') ? 1 : -1);
    });
    if (root.dataset.autoplay === 'true') {
      var timer = window.setInterval(function () {
        if (!root.isConnected) {
          window.clearInterval(timer);
          return;
        }
        if (root.hasAttribute('data-paused')) return;
        stepSlides(root, 1);
      }, 3000);
    }
  }

  window.__plakboekSite = {
    initAccordionList,
    initTabs,
    initSlides,
    openEntry(entry) {
      setEntryOpen(entry, true);
    },
    showTab,
    showSlide,
  };

  document.querySelectorAll('[data-accordion-list]').forEach(initAccordionList);
  document.querySelectorAll('[data-tabs]').forEach(initTabs);
  document.querySelectorAll('[data-slides]').forEach(initSlides);

  var handled = document.getElementById('handled-link');
  if (handled) {
    handled.addEventListener('click', function (event) {
      event.preventDefault();
      document.body.dataset.handled = 'true';
    });
  }

  window.addEventListener('scroll', function () {
    document.body.dataset.scrolled = String(window.scrollY > 100);
    window.__siteScrollEvents += 1;
  });

  var dialog = document.getElementById('site-dialog');
  var openButton = document.getElementById('open-site-dialog');
  var closeButton = document.getElementById('close-site-dialog');
  if (dialog && openButton) {
    openButton.addEventListener('click', function () {
      dialog.showModal();
    });
  }
  if (dialog && closeButton) {
    closeButton.addEventListener('click', function () {
      dialog.close();
    });
  }

  window.__siteScriptsReady = true;
})();
