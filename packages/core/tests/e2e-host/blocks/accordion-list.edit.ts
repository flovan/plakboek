import { defineBlockEdit } from '@plakboek/render';

type Site = {
  initAccordionList(element: Element): void;
  openEntry(entry: Element): void;
};

function siteOf(window: Window): Site | undefined {
  return Reflect.get(window, '__plakboekSite') as Site | undefined;
}

/**
 * Test-only: the accordion list opens the entry that holds the selected block
 * and re-binds its script when the editor replaces its element.
 */
export default defineBlockEdit({
  blockType: 'accordionList',
  hooks: {
    reveal: ({ element, targetId, window }) => {
      const target = element.querySelector(`[data-pk-block="${targetId}"]`);
      const entry = target?.closest('[data-accordion-item]');
      if (entry !== null && entry !== undefined)
        siteOf(window)?.openEntry(entry);
    },
    rendered: ({ element, window }) => {
      siteOf(window)?.initAccordionList(element);
    },
  },
});
