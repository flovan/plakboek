/**
 * The interactive-block UAT matrix, in a real browser: an item-based
 * accordion, tabs and carousel, plus the site's own links, form and dialog
 * button. In Edit a click selects and does nothing else; in Interact the same
 * click behaves as on the site; the state the site was left in survives the
 * switch back; and the host's `*.edit.ts` hook modules cooperate with the
 * editor (reveal, pause, re-bind).
 */
import {
  expect,
  test,
  type Frame,
  type Locator,
  type Page,
} from '@playwright/test';
import {
  framedSite,
  FRAME,
  HOST,
  LIVE_REGION,
  MODE_GROUP,
  openEditor,
  SELECTED,
  tabToRegion,
} from './helpers/editing.ts';
import { e2eUsers } from './helpers/host.ts';
import {
  createEditablePage,
  paragraph,
  section,
  type EditablePage,
  type FactoryBlock,
} from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';

function mode(page: Page) {
  return page.locator(`${MODE_GROUP} [role="radio"][aria-checked="true"]`);
}

const SAVED = 'All changes saved';
const TOAST = `${HOST} [data-toast]`;

const TRIGGER = '[data-accordion-trigger]';
const TAB = '[data-tab-trigger]';
const SLIDE = '[data-slide]';

function entry(title: string, text?: string): FactoryBlock {
  return {
    type: 'accordionItem',
    props: { title },
    children: text === undefined ? [] : [paragraph(text)],
  };
}

function accordionBlock(): FactoryBlock {
  return {
    type: 'accordionList',
    children: [
      entry('First entry', 'First entry text'),
      entry('Second entry', 'Second entry text'),
    ],
  };
}

function tabsBlock(): FactoryBlock {
  return {
    type: 'tabs',
    children: [
      {
        type: 'tab',
        props: { label: 'First tab' },
        children: [paragraph('First tab text')],
      },
      {
        type: 'tab',
        props: { label: 'Second tab' },
        children: [paragraph('Second tab text')],
      },
    ],
  };
}

function slidesBlock(autoplay: boolean): FactoryBlock {
  return {
    type: 'slides',
    props: { autoplay },
    children: [
      { type: 'slide', children: [paragraph('First slide text')] },
      { type: 'slide', children: [paragraph('Second slide text')] },
    ],
  };
}

async function slidesPage(autoplay = false): Promise<EditablePage> {
  return await createEditablePage({
    blocks: [section(slidesBlock(autoplay))],
  });
}

/** Moves the selection with the keys only: section, column, then `steps`. */
async function walk(page: Page, ...steps: readonly string[]): Promise<void> {
  await tabToRegion(page);
  for (const step of ['ArrowDown', 'ArrowRight', ...steps]) {
    await page.keyboard.press(step);
  }
}

async function interact(page: Page): Promise<void> {
  // An open Properties sheet covers the mode toggle; Close brings it back.
  const close = page.getByRole('button', { name: 'Close properties' });
  if (await close.isVisible()) await close.click();
  await page.getByRole('radio', { name: 'Interact' }).click();
  await expect(mode(page)).toHaveText('Interact');
  await expect(page.locator(FRAME)).not.toHaveAttribute('tabindex');
}

async function edit(page: Page): Promise<void> {
  await page.getByRole('radio', { name: 'Edit' }).click();
  await expect(mode(page)).toHaveText('Edit');
  await expect(page.locator(FRAME)).toHaveAttribute('tabindex', '-1');
}

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

test.describe('a host hook module and the editor', () => {
  test('selecting the second slide’s text shows that slide, Edit holds the autoplay, and in Interact the site’s own Next button still works', async ({
    page,
  }) => {
    const created = await slidesPage();
    await openEditor(page, created.path);
    const frame: Frame = await framedSite(page);
    const root = frame.locator('[data-slides]');
    const first = frame.getByText('First slide text');
    const second = frame.getByText('Second slide text');

    // Edit mode paused the autoplay, and only the first slide shows
    await expect(root).toHaveAttribute('data-paused', '');
    await expect(first).toBeVisible();
    await expect(second).toBeHidden();

    // slides, first slide, second slide, then its text
    await walk(page, 'ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowRight');

    await expect(second).toBeVisible();
    await expect(first).toBeHidden();
    await expect(page.locator(SELECTED)).toHaveCount(1);
    await expect(page.locator(LIVE_REGION)).toContainText('Selected Text');

    await interact(page);
    await expect(root).not.toHaveAttribute('data-paused');
    await frame.getByRole('button', { name: 'Next slide' }).click();
    await expect(first).toBeVisible();
    await expect(second).toBeHidden();
  });
});

/** Section A fills the window; section B holds every interactive block and a form. */
async function matrixPage(): Promise<EditablePage> {
  return await createEditablePage({
    blocks: [
      section(paragraph('Top of the page')),
      section(accordionBlock(), tabsBlock(), slidesBlock(false), {
        type: 'siteForm',
        props: { label: 'Submit form' },
      }),
    ],
  });
}

async function expectSaved(page: Page): Promise<void> {
  await expect(page.getByText(SAVED)).toBeVisible();
}

/** Climbs with Escape until nothing is selected. */
async function clearSelection(page: Page): Promise<void> {
  for (let climbs = 0; climbs < 8; climbs += 1) {
    if ((await page.locator(SELECTED).count()) === 0) return;
    await page.keyboard.press('Escape');
  }
  await expect(page.locator(SELECTED)).toHaveCount(0);
}

/**
 * Double-clicks `target` once per level: the column, the container, its item,
 * then the text itself. The next double-click would ask for its Properties.
 */
async function drillOnto(page: Page, target: Locator): Promise<void> {
  for (let level = 0; level < 4; level += 1) await target.dblclick();
  await expect(page.locator(SELECTED)).toHaveCount(1);
  await expect
    .poll(async () => {
      const selected = await page.locator(SELECTED).first().boundingBox();
      const box = await target.boundingBox();
      if (selected === null || box === null) return Number.POSITIVE_INFINITY;
      return Math.max(
        Math.abs(selected.x - box.x),
        Math.abs(selected.y - box.y),
        Math.abs(selected.width - box.width),
        Math.abs(selected.height - box.height),
      );
    })
    .toBeLessThanOrEqual(1);
}

/** What the site would have changed had it seen the click. */
async function siteState(frame: Frame) {
  return {
    expanded: await frame
      .locator(TRIGGER)
      .first()
      .getAttribute('aria-expanded'),
    secondTab: await frame.locator(TAB).nth(1).getAttribute('aria-selected'),
    secondSlideHidden: await frame.locator(SLIDE).nth(1).isHidden(),
    handled: await frame.evaluate(() => document.body.dataset.handled),
    dialogOpen: await frame
      .locator('#site-dialog')
      .evaluate((dialog) => (dialog as HTMLDialogElement).open),
    url: frame.url(),
  };
}

test.describe('the site’s own controls', () => {
  test('in Edit a click selects and changes nothing: no toggle, tab or slide change, scroll, navigation, submit or dialog', async ({
    page,
  }) => {
    const created = await matrixPage();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    const shellUrl = page.url();
    const before = await siteState(frame);
    expect(before).toEqual({
      expanded: 'false',
      secondTab: 'false',
      secondSlideHidden: true,
      handled: undefined,
      dialogOpen: false,
      url: frame.url(),
    });

    const inBlocks = [
      frame.locator(TRIGGER).first(),
      frame.locator(TAB).nth(1),
      frame.getByRole('button', { name: 'Next slide' }),
      frame.locator('#site-form-submit'),
    ];
    for (const control of inBlocks) {
      await control.click();
      await expect(page.locator(SELECTED)).toHaveCount(1);
      await page.keyboard.press('Escape');
      await expect(page.locator(SELECTED)).toHaveCount(0);
    }

    // the site's own header is outside every block: its controls are claimed too
    await frame.evaluate(() => window.scrollTo(0, 0));
    for (const selector of [
      '#hash-link',
      '#handled-link',
      '#open-site-dialog',
    ]) {
      await frame.locator(selector).click();
      await expect(page.locator(SELECTED)).toHaveCount(0);
    }
    expect(await frame.evaluate(() => window.scrollY)).toBe(0);

    expect(await siteState(frame)).toEqual(before);
    expect(page.url()).toBe(shellUrl);
  });

  test('in Interact the same clicks behave as on the site', async ({
    page,
  }) => {
    const created = await matrixPage();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await interact(page);

    await frame.locator(TRIGGER).first().click();
    await expect(frame.locator(TRIGGER).first()).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await frame.locator(TAB).nth(1).click();
    await expect(frame.locator(TAB).nth(1)).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(frame.getByText('Second tab text')).toBeVisible();
    await frame.getByRole('button', { name: 'Next slide' }).click();
    await expect(frame.getByText('Second slide text')).toBeVisible();

    await frame.evaluate(() => window.scrollTo(0, 0));
    await frame.locator('#hash-link').click();
    await expect
      .poll(() => frame.evaluate(() => window.scrollY))
      .toBeGreaterThan(0);
    await frame.locator('#handled-link').click();
    expect(await frame.evaluate(() => document.body.dataset.handled)).toBe(
      'true',
    );
    await frame.locator('#open-site-dialog').click();
    await expect
      .poll(() =>
        frame
          .locator('#site-dialog')
          .evaluate((dialog) => dialog.matches(':modal')),
      )
      .toBe(true);
    await frame.locator('#close-site-dialog').click();

    // the form leaves for another page, and the whole page follows
    await frame.locator('#site-form-submit').click();
    await expect(page).toHaveURL(/\/about/);
  });

  test('Edit, Interact and Edit again keeps the opened entry and tab, and the content they revealed can be selected', async ({
    page,
  }) => {
    const created = await matrixPage();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await interact(page);
    await frame.locator(TRIGGER).nth(1).click();
    await frame.locator(TAB).nth(1).click();
    await expect(frame.getByText('Second entry text')).toBeVisible();
    await expect(frame.getByText('Second tab text')).toBeVisible();

    await edit(page);

    await expect(frame.locator(TRIGGER).nth(1)).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(frame.locator(TAB).nth(1)).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await drillOnto(page, frame.getByText('Second entry text'));
    await expect(page.locator(LIVE_REGION)).toContainText('Selected Text');
    await clearSelection(page);
    await drillOnto(page, frame.getByText('Second tab text'));
    await expect(page.locator(LIVE_REGION)).toContainText('Selected Text');
  });
});

test.describe('hook modules reveal what is selected', () => {
  test('selecting an entry’s or a tab’s text opens that entry and shows that tab', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [section(accordionBlock(), tabsBlock())],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await expect(frame.getByText('Second entry text')).toBeHidden();
    await expect(frame.getByText('Second tab text')).toBeHidden();

    // list, first entry, second entry, its text
    await walk(page, 'ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowRight');
    await expect(frame.locator(TRIGGER).nth(1)).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(frame.getByText('Second entry text')).toBeVisible();

    // back to the column's children: the tabs, first tab, second tab, its text
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await expect(frame.locator(TAB).nth(1)).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(frame.getByText('Second tab text')).toBeVisible();
    await expect(frame.getByText('First tab text')).toBeHidden();
  });

  test('an entry’s title edited in the panel renders in place and the entry still toggles in Interact', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [section(accordionBlock())],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);

    // list, first entry
    await walk(page, 'ArrowRight', 'ArrowRight');
    await page.getByRole('button', { name: /^Properties of / }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill('Renamed entry');
    await expect(frame.locator(TRIGGER).first()).toHaveText('Renamed entry');
    await expectSaved(page);

    await interact(page);
    const trigger = frame.locator(TRIGGER).first();
    const was = await trigger.getAttribute('aria-expanded');
    await trigger.click();
    await expect(trigger).not.toHaveAttribute('aria-expanded', was ?? '');
  });

  test('turning Autoplay on replaces the carousel and its script is bound again, so in Interact it plays on its own', async ({
    page,
  }) => {
    const created = await slidesPage();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await expect(frame.getByText('Second slide text')).toBeHidden();

    await walk(page, 'ArrowRight');
    await page.getByRole('button', { name: /^Properties of Slides/ }).click();
    await page.getByRole('checkbox', { name: 'Autoplay' }).check();
    await expect(frame.locator('[data-slides]')).toHaveAttribute(
      'data-autoplay',
      'true',
    );
    await expectSaved(page);
    // the script ran on the new element: one slide shows again, not all
    await expect(frame.getByText('First slide text')).toBeVisible();
    await expect(frame.getByText('Second slide text')).toBeHidden();
    // Edit mode holds the new element's autoplay too
    await expect(frame.locator('[data-slides]')).toHaveAttribute(
      'data-paused',
      '',
    );

    await interact(page);
    await expect(frame.locator('[data-slides]')).not.toHaveAttribute(
      'data-paused',
    );
    await expect(frame.getByText('Second slide text')).toBeVisible({
      timeout: 8000,
    });
  });
});

test.describe('items are blocks like any other', () => {
  test('Add after on a slide adds a third slide, saved and still there after a reload', async ({
    page,
  }) => {
    const created = await slidesPage();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await expect(frame.locator(SLIDE)).toHaveCount(2);

    await walk(page, 'ArrowRight', 'ArrowRight');
    await page.getByRole('button', { name: 'Add after Slide' }).click();
    const picker = page.getByRole('dialog', { name: 'Add a block' });
    await expect(picker.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Enter');

    await expect(frame.locator(SLIDE)).toHaveCount(3);
    await expect(page.locator(LIVE_REGION)).toContainText('Added Slide.');
    await expectSaved(page);

    await page.reload();
    const reloaded = await framedSite(page);
    await expect(reloaded.locator(SLIDE)).toHaveCount(3);
  });

  test('the second tab moves earlier and the order is kept after a reload', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [section(tabsBlock())],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);

    // tabs, first tab, second tab
    await walk(page, 'ArrowRight', 'ArrowRight', 'ArrowDown');
    await page.getByRole('button', { name: /^Move Tab (left|up)$/ }).click();

    await expect
      .poll(() => frame.locator(TAB).allTextContents())
      .toEqual(['Second tab', 'First tab']);
    await expectSaved(page);

    await page.reload();
    const reloaded = await framedSite(page);
    await expect
      .poll(() => reloaded.locator(TAB).allTextContents())
      .toEqual(['Second tab', 'First tab']);
  });

  test('an empty entry is deleted at once, Undo brings it back, and it is still there after a reload', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [
        section({
          type: 'accordionList',
          children: [
            entry('First entry', 'First entry text'),
            entry('Second entry', 'Second entry text'),
            entry('Empty entry'),
          ],
        }),
      ],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);

    // list, first entry, second, third
    await walk(page, 'ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowDown');
    await page.getByRole('button', { name: 'Delete Accordion entry' }).click();

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(frame.locator(TRIGGER)).toHaveCount(2);
    await expect(page.locator(TOAST)).toContainText('Accordion entry deleted');
    await page.locator(TOAST).getByRole('button', { name: 'Undo' }).click();
    await expect(frame.locator(TRIGGER)).toHaveCount(3);
    await expect(frame.locator(TRIGGER).nth(2)).toHaveText('Empty entry');
    await expectSaved(page);

    await page.reload();
    const reloaded = await framedSite(page);
    await expect(reloaded.locator(TRIGGER)).toHaveText([
      'First entry',
      'Second entry',
      'Empty entry',
    ]);
  });
});
