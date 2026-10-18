import { defineBlockEdit } from '@plakboek/render';

type Site = {
  initSlides(element: Element): void;
  showSlide(slides: Element, slide: Element): void;
};

function siteOf(window: Window): Site | undefined {
  return Reflect.get(window, '__plakboekSite') as Site | undefined;
}

/**
 * Test-only reference module for an interactive block: Edit mode pauses the
 * autoplay, selecting a slide's content shows that slide, and a replaced
 * element gets its script bound again.
 */
export default defineBlockEdit({
  blockType: 'slides',
  hooks: {
    enter: ({ element }) => {
      element.setAttribute('data-paused', '');
    },
    leave: ({ element }) => {
      element.removeAttribute('data-paused');
    },
    reveal: ({ element, targetId, window }) => {
      const target = element.querySelector(`[data-pk-block="${targetId}"]`);
      const slide = target?.closest('[data-slide]');
      if (slide !== null && slide !== undefined) {
        siteOf(window)?.showSlide(element, slide);
      }
    },
    rendered: ({ element, window }) => {
      siteOf(window)?.initSlides(element);
    },
  },
});
