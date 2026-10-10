// Stands in for a host theme's own scripts. Plain browser JavaScript, no build.
(function () {
  window.__siteScrollEvents = 0;

  document.querySelectorAll('[data-accordion]').forEach(function (accordion) {
    var button = accordion.querySelector('button');
    var panel = accordion.querySelector('[role="region"]');
    if (!button || !panel) return;
    button.addEventListener('click', function () {
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
