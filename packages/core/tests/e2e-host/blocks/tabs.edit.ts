import { defineBlockEdit } from '@plakboek/render';

type Site = {
  initTabs(element: Element): void;
  showTab(tabs: Element, tab: Element): void;
};

function siteOf(window: Window): Site | undefined {
  return Reflect.get(window, '__plakboekSite') as Site | undefined;
}

/**
 * Test-only: the tabs block activates the tab that holds the selected block
 * and re-binds its script when the editor replaces its element.
 */
export default defineBlockEdit({
  blockType: 'tabs',
  hooks: {
    reveal: ({ element, targetId, window }) => {
      const target = element.querySelector(`[data-pk-block="${targetId}"]`);
      const tab = target?.closest('[data-tab]');
      if (tab !== null && tab !== undefined)
        siteOf(window)?.showTab(element, tab);
    },
    rendered: ({ element, window }) => {
      siteOf(window)?.initTabs(element);
    },
  },
});
