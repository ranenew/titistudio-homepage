(() => {
  const header = document.querySelector('header.header');
  const toggle = header?.querySelector('button.menu-toggle');
  const nav = header?.querySelector('nav#primary-nav.primary-nav');
  const label = toggle?.querySelector('.menu-toggle__label');
  if (!header || !toggle || !nav || !label) return;

  const desktop = window.matchMedia('(min-width: 43.75em)');
  let isOpen = false;

  const focusWithoutScrolling = element => element?.focus({ preventScroll: true });

  function setOpen(open, returnFocus = false) {
    isOpen = !desktop.matches && open;
    nav.hidden = !desktop.matches && !isOpen;
    toggle.setAttribute('aria-expanded', String(isOpen));
    toggle.setAttribute('aria-label', isOpen ? '메뉴 닫기' : '메뉴 열기');
    label.textContent = isOpen ? '닫기' : '메뉴';
    if (returnFocus && !toggle.hidden) focusWithoutScrolling(toggle);
  }

  function syncLayout() {
    const active = document.activeElement;
    toggle.hidden = desktop.matches;
    setOpen(false);

    // A breakpoint change must not leave keyboard focus inside hidden controls.
    if (!desktop.matches && nav.contains(active)) {
      focusWithoutScrolling(toggle);
    } else if (desktop.matches && toggle.contains(active)) {
      focusWithoutScrolling(nav.querySelector('a[href]'));
    }
  }

  function focusSection(target) {
    const needsTabIndex = !target.hasAttribute('tabindex') && target.tabIndex < 0;
    if (needsTabIndex) {
      target.setAttribute('tabindex', '-1');
      target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true });
    }
    focusWithoutScrolling(target);
  }

  toggle.addEventListener('click', () => setOpen(!isOpen));

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !isOpen) return;
    event.preventDefault();
    setOpen(false, true);
  });

  document.addEventListener('click', event => {
    if (isOpen && !header.contains(event.target)) setOpen(false);
  });

  document.addEventListener('focusin', event => {
    if (isOpen && !nav.contains(event.target) && !toggle.contains(event.target)) setOpen(false);
  });

  nav.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (!link || !nav.contains(link) || event.defaultPrevented || event.button !== 0 ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const destination = new URL(link.href, location.href);
    setOpen(false);
    if (link.target && link.target !== '_self') return;
    if (destination.origin !== location.origin || destination.pathname !== location.pathname ||
        destination.search !== location.search || !destination.hash) return;

    let target;
    try {
      target = document.getElementById(decodeURIComponent(destination.hash.slice(1)));
    } catch {
      return;
    }
    // Keep the browser's native anchor scrolling while moving keyboard focus to its destination.
    if (target) focusSection(target);
  });

  desktop.addEventListener('change', syncLayout);
  syncLayout();
})();
