/**
 * Links in rich text on the real page, in a real browser: the toolbar's Link
 * button opens a popover that links the selection to a web address, the link
 * is stored with exactly the target that was chosen and is rendered on the
 * page after a reload, and an address the href policy refuses cannot become a
 * link. Assertions are on what is stored and rendered, never on how the
 * editor builds its marks.
 */
import { expect, test, type Frame, type Locator } from '@playwright/test';
import { chrome, framedSite, HOST, openEditor } from './helpers/editing.ts';
import { e2eUsers } from './helpers/host.ts';
import {
  createEditablePage,
  paragraph,
  readBlockProps,
  renamePageSlug,
  section,
  trashPageById,
} from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';

const TOOLBAR = '[data-text-toolbar]';
const POPOVER = '[data-link-popover]';

function paragraphDoc(text: string) {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

/** Opens a page with a prose block under an intro that gives the toolbar room above. */
async function openProse(
  page: Parameters<typeof openEditor>[0],
  text = 'Read our story today',
): Promise<{ frame: Frame; field: Locator; pageId: string }> {
  const created = await createEditablePage({
    blocks: [
      section(paragraph('Intro '.repeat(60)), {
        type: 'prose',
        props: { body: paragraphDoc(text) },
      }),
    ],
  });
  await openEditor(page, created.path);
  const frame = await framedSite(page);
  return {
    frame,
    field: frame.locator('.prose-flow').first(),
    pageId: created.pageId,
  };
}

/** The stored document of the prose block, as text. */
async function storedBody(pageId: string): Promise<string> {
  return JSON.stringify((await readBlockProps(pageId, 'prose'))['body']);
}

/** Selects the words "our story" of the opened field, the way a drag over them would. */
async function selectOurStory(
  page: Parameters<typeof openEditor>[0],
  field: Locator,
): Promise<void> {
  await field.click();
  await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
  await expect(field).toBeFocused();
  const frame = await framedSite(page);
  await frame.evaluate(() => {
    const text = document.querySelector('.prose-flow p')?.firstChild;
    if (text === null || text === undefined) throw new Error('No text');
    window.getSelection()?.setBaseAndExtent(text, 5, text, 14);
  });
  // the editor learns of the selection from the browser's own event, a task
  // later: wait until the page holds it before pressing a link key
  await expect
    .poll(() => frame.evaluate(() => String(window.getSelection())))
    .toBe('our story');
}

test('select two words, link them to a web address: stored with that address, rendered as an anchor after a reload', async ({
  page,
}) => {
  const { field, pageId } = await openProse(page);
  await selectOurStory(page, field);

  const toolbar = chrome(page).locator(TOOLBAR);
  const linkButton = toolbar.getByRole('button', { name: 'Link' });
  await expect(linkButton).toHaveAttribute('aria-pressed', 'false');
  await linkButton.click();

  const popover = chrome(page).locator(POPOVER);
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAttribute('role', 'dialog');
  await expect(popover).toHaveAccessibleName('Link');
  expect((await popover.boundingBox())?.width).toBe(320);

  // a new link opens on Page; the web address is the other segment
  await expect(popover.getByRole('radio', { name: 'Page' })).toBeChecked();
  await popover.getByRole('radio', { name: 'Web address' }).click();
  const address = popover.getByLabel('Web address');
  await expect(address).toBeFocused();
  await address.fill('https://example.com');
  await popover.getByRole('button', { name: 'Apply link' }).click();

  // the popover is gone, the field kept its focus, the words are linked
  await expect(popover).toHaveCount(0);
  await expect(field.locator('a')).toHaveText('our story');
  await expect(page.locator(`${HOST} [role="status"].sr-only`)).toHaveText(
    'Link added.',
  );
  // the selection still covers the link, so the button reads as in a link
  await expect(linkButton).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  await expect(linkButton).toHaveAttribute('aria-pressed', 'true');

  await page.keyboard.press('Escape');
  await expect.poll(() => storedBody(pageId)).toContain('"link"');
  const stored = JSON.parse(await storedBody(pageId)) as {
    content: { content: { text: string; marks?: unknown[] }[] }[];
  };
  const linked = stored.content[0]?.content.find((run) => run.marks?.length);
  expect(linked?.text).toBe('our story');
  expect(linked?.marks).toEqual([
    {
      type: 'link',
      attrs: { href: 'https://example.com', pageId: null, target: null },
    },
  ]);

  await page.reload();
  const reloaded = await framedSite(page);
  const anchor = reloaded.locator('.prose-flow a');
  await expect(anchor).toHaveText('our story');
  await expect(anchor).toHaveAttribute('href', 'https://example.com');
});

test('a script address shows the web address error and cannot be applied', async ({
  page,
}) => {
  const { field, pageId } = await openProse(page);
  await selectOurStory(page, field);
  await chrome(page)
    .locator(TOOLBAR)
    .getByRole('button', { name: 'Link' })
    .click();

  const popover = chrome(page).locator(POPOVER);
  await popover.getByRole('radio', { name: 'Web address' }).click();
  const address = popover.getByLabel('Web address');
  await address.fill('javascript:alert(1)');
  await address.blur();
  await expect(popover.getByRole('alert')).toHaveText(
    'Enter a web address like https://example.com, or an email or phone link.',
  );

  const apply = popover.getByRole('button', { name: 'Apply link' });
  await expect(apply).toHaveAttribute('aria-disabled', 'true');
  // an aria-disabled button is still pressable, and a press does nothing
  await apply.click({ force: true });
  // nothing was linked and the popover is still open for another try
  await expect(field.locator('a')).toHaveCount(0);
  await expect(popover).toBeVisible();

  // Escape closes without a change and returns to the field
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
  await expect(field.locator('a')).toHaveCount(0);
  expect(await storedBody(pageId)).not.toContain('"link"');
});

/** A unique word, so a search finds one page of the shared database. */
function tag(): string {
  return `zq${Math.random().toString(36).slice(2, 8)}`;
}

/** The marks of the first linked run of a stored document. */
function linkedRun(
  stored: string,
): { text: string; attrs: Record<string, unknown> } | undefined {
  const doc = JSON.parse(stored) as {
    content: {
      content: {
        text: string;
        marks?: { type: string; attrs: Record<string, unknown> }[];
      }[];
    }[];
  };
  for (const paragraphNode of doc.content) {
    for (const run of paragraphNode.content) {
      const mark = run.marks?.find((candidate) => candidate.type === 'link');
      if (mark !== undefined) return { text: run.text, attrs: mark.attrs };
    }
  }
  return undefined;
}

test('link to a page by searching its title: the id is stored, and the link follows the page when its slug changes', async ({
  page,
}) => {
  const word = tag();
  const target = await createEditablePage({
    title: `Team ${word}`,
    blocks: [],
  });
  const { field, pageId } = await openProse(page);
  await selectOurStory(page, field);
  await chrome(page)
    .locator(TOOLBAR)
    .getByRole('button', { name: 'Link' })
    .click();

  const popover = chrome(page).locator(POPOVER);
  const search = popover.getByLabel('Search pages');
  await expect(search).toBeFocused();
  // an empty query lists pages by title, and a draft says so
  const row = popover.getByRole('option', { name: `Team ${word}` });
  await expect(row).toHaveCount(0);
  await search.fill(word);
  await expect(row).toBeVisible();
  await expect(row).toContainText(target.slug);
  await expect(row).toContainText('Not published');
  await expect(row).toHaveAttribute('aria-selected', 'false');
  // arrows name the active row, Enter picks it
  await expect(search).toHaveAttribute('aria-activedescendant', /.+/);
  await row.click();
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await popover.getByRole('button', { name: 'Apply link' }).click();
  await expect(popover).toHaveCount(0);
  await expect(page.locator(`${HOST} [role="status"].sr-only`)).toHaveText(
    'Link added.',
  );

  await page.keyboard.press('Escape');
  await expect
    .poll(async () => linkedRun(await storedBody(pageId))?.attrs)
    .toEqual({ href: null, pageId: target.pageId, target: null });
  expect(linkedRun(await storedBody(pageId))?.text).toBe('our story');

  await page.reload();
  const anchor = (await framedSite(page)).locator('.prose-flow a');
  await expect(anchor).toHaveText('our story');
  await expect(anchor).toHaveAttribute('href', target.path);

  // another editor renames the page; the stored id still finds it
  const renamed = `renamed-${word}`;
  await renamePageSlug(target.pageId, renamed);
  await page.reload();
  const after = (await framedSite(page)).locator('.prose-flow a');
  await expect(after).toHaveAttribute('href', `/${renamed}`);
  expect(linkedRun(await storedBody(pageId))?.attrs['pageId']).toBe(
    target.pageId,
  );
});

test('a mailto and a tel address are accepted, Ctrl+K edits the link at the caret, and Remove link unlinks', async ({
  page,
}) => {
  const { field, pageId } = await openProse(page);
  await selectOurStory(page, field);
  const popover = chrome(page).locator(POPOVER);
  const status = page.locator(`${HOST} [role="status"].sr-only`);

  await page.keyboard.press('ControlOrMeta+k');
  await expect(popover).toBeVisible();
  await popover.getByRole('radio', { name: 'Web address' }).click();
  await popover.getByLabel('Web address').fill('mailto:hello@example.com');
  await page.keyboard.press('Enter');
  await expect(popover).toHaveCount(0);
  await expect(status).toHaveText('Link added.');
  await expect(field.locator('a')).toHaveText('our story');

  // the caret inside the link: the popover opens on that link, on its own segment
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ControlOrMeta+k');
  await expect(
    popover.getByRole('radio', { name: 'Web address' }),
  ).toBeChecked();
  const address = popover.getByLabel('Web address');
  await expect(address).toHaveValue('mailto:hello@example.com');
  await address.fill('tel:+3212345678');
  await popover.getByRole('button', { name: 'Apply link' }).click();
  await expect(status).toHaveText('Link updated.');
  await expect(field.locator('a')).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect
    .poll(async () => linkedRun(await storedBody(pageId))?.attrs)
    .toEqual({ href: 'tel:+3212345678', pageId: null, target: null });

  // back in the field: a click on the link opens its popover and never navigates
  const frame = await framedSite(page);
  await field.click();
  await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
  await field.locator('a').click();
  await expect(popover).toBeVisible();
  expect(frame.url()).not.toContain('tel:');
  await popover.getByRole('button', { name: 'Remove link' }).click();
  await expect(status).toHaveText('Link removed.');
  await expect(field.locator('a')).toHaveCount(0);
  await expect(field).toContainText('Read our story today');

  await page.keyboard.press('Escape');
  await expect.poll(() => storedBody(pageId)).not.toContain('"link"');
});

test('a click on a web link in the active field opens its popover and opens no tab', async ({
  context,
  page,
}) => {
  const created = await createEditablePage({
    blocks: [
      section(paragraph('Intro '.repeat(60)), {
        type: 'prose',
        props: {
          body: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: 'Plain words, then ' },
                  {
                    type: 'text',
                    text: 'a web link',
                    marks: [
                      {
                        type: 'link',
                        attrs: {
                          href: 'https://example.com/away',
                          pageId: null,
                          target: null,
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      }),
    ],
  });
  await openEditor(page, created.path);
  const frame = await framedSite(page);
  const field = frame.locator('.prose-flow').first();
  const opened: string[] = [];
  context.on('page', (opener) => {
    opened.push(opener.url());
  });

  await field.click({ position: { x: 4, y: 4 } });
  await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
  // the shell's link handling skips a click that is already cancelled when it
  // reaches the window, so what matters is the state at the document
  await frame.evaluate(() => {
    const seen: boolean[] = [];
    Reflect.set(window, '__clickCancelled', seen);
    document.addEventListener('click', (event) => {
      seen.push(event.defaultPrevented);
    });
  });
  await field.locator('a').click();
  await expect(chrome(page).locator(POPOVER)).toBeVisible();
  expect(
    await frame.evaluate(() => Reflect.get(window, '__clickCancelled')),
  ).toEqual([true]);
  expect(opened).toEqual([]);
  expect(frame.url()).not.toContain('example.com');
});

test('Open in new tab is off by default and stored as _blank when switched on', async ({
  page,
}) => {
  const { field, pageId } = await openProse(page);
  await selectOurStory(page, field);
  await page.keyboard.press('ControlOrMeta+k');
  const popover = chrome(page).locator(POPOVER);
  await popover.getByRole('radio', { name: 'Web address' }).click();
  await popover.getByLabel('Web address').fill('https://example.com/new');
  const newTab = popover.getByRole('switch', { name: 'Open in new tab' });
  await expect(newTab).not.toBeChecked();
  await newTab.check();
  await popover.getByRole('button', { name: 'Apply link' }).click();
  await page.keyboard.press('Escape');
  await expect
    .poll(async () => linkedRun(await storedBody(pageId))?.attrs)
    .toEqual({
      href: 'https://example.com/new',
      pageId: null,
      target: '_blank',
    });
  await page.reload();
  const anchor = (await framedSite(page)).locator('.prose-flow a');
  await expect(anchor).toHaveAttribute('target', '_blank');
  await expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
});

test('at a bare caret Apply inserts the page title as the link text', async ({
  page,
}) => {
  const word = tag();
  const target = await createEditablePage({
    title: `Contact ${word}`,
    blocks: [],
  });
  const { field, pageId } = await openProse(page);
  await field.click();
  await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
  await expect(field).toBeFocused();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' See ');
  await page.keyboard.press('ControlOrMeta+k');
  const popover = chrome(page).locator(POPOVER);
  await popover.getByLabel('Search pages').fill(word);
  await popover.getByRole('option', { name: `Contact ${word}` }).click();
  await popover.getByRole('button', { name: 'Apply link' }).click();
  await expect(field.locator('a')).toHaveText(`Contact ${word}`);
  // typing goes on after the link, not inside it
  await page.keyboard.type(' now');
  await expect(field.locator('a')).toHaveText(`Contact ${word}`);
  await page.keyboard.press('Escape');
  await expect
    .poll(async () => linkedRun(await storedBody(pageId))?.text)
    .toBe(`Contact ${word}`);
  expect(linkedRun(await storedBody(pageId))?.attrs['pageId']).toBe(
    target.pageId,
  );
});

test('the picker says when nothing matches and when pages could not be loaded, and Retry asks again', async ({
  page,
}) => {
  const { field } = await openProse(page);
  await selectOurStory(page, field);
  await page.keyboard.press('ControlOrMeta+k');
  const popover = chrome(page).locator(POPOVER);
  const search = popover.getByLabel('Search pages');
  await search.fill('nothing-has-this-title');
  await expect(popover).toContainText(
    'No pages match "nothing-has-this-title".',
  );

  // the next search fails
  await page.route('**/cms/api/pages/search*', (route) => route.abort());
  await search.fill('another');
  await expect(popover.getByRole('alert')).toHaveText(
    'Pages could not be loaded. Try again.',
  );
  await page.unroute('**/cms/api/pages/search*');
  await popover.getByRole('button', { name: 'Retry' }).click();
  await expect(popover).toContainText('No pages match "another".');

  // the list of an empty query is the first pages by title, scrolling inside the popover
  await search.fill('');
  await expect(popover.getByRole('listbox')).toBeVisible();
  const box = await popover.boundingBox();
  const frameBox = await page.locator('plakboek-editor iframe').boundingBox();
  if (box === null || frameBox === null) throw new Error('No boxes');
  expect(box.x).toBeGreaterThanOrEqual(frameBox.x + 8 - 1);
  expect(box.x + box.width).toBeLessThanOrEqual(frameBox.x + frameBox.width);
  expect(await popover.getByRole('option').count()).toBeLessThanOrEqual(20);
  expect(box.y).toBeGreaterThanOrEqual(frameBox.y);
  expect(box.y + box.height).toBeLessThanOrEqual(frameBox.y + frameBox.height);

  // a press in the field closes the popover without a change
  await (await framedSite(page)).locator('.prose-flow').first().click();
  await expect(popover).toHaveCount(0);
  await expect(field.locator('a')).toHaveCount(0);
});

test('a link to a page that no longer exists opens on Page and says so', async ({
  page,
}) => {
  const word = tag();
  const target = await createEditablePage({
    title: `Gone ${word}`,
    blocks: [],
  });
  const stored = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Read ' },
          {
            type: 'text',
            text: 'our story',
            marks: [
              {
                type: 'link',
                attrs: { href: null, pageId: target.pageId, target: null },
              },
            ],
          },
        ],
      },
    ],
  };
  const created = await createEditablePage({
    blocks: [
      section(paragraph('Intro '.repeat(60)), {
        type: 'prose',
        props: { body: stored },
      }),
    ],
  });
  await trashPageById(target.pageId);
  await openEditor(page, created.path);
  const frame = await framedSite(page);
  const field = frame.locator('.prose-flow').first();
  await field.click();
  await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
  await expect(field).toBeFocused();
  await page.keyboard.press('Home');
  for (let i = 0; i < 8; i += 1) await page.keyboard.press('ArrowRight');
  // the caret is in the link once the toolbar says so
  await expect(
    chrome(page).locator(TOOLBAR).getByRole('button', { name: 'Link' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ControlOrMeta+k');

  const popover = chrome(page).locator(POPOVER);
  await expect(popover.getByRole('radio', { name: 'Page' })).toBeChecked();
  await expect(popover.getByRole('alert')).toHaveText(
    'This page no longer exists. Choose another page or a web address.',
  );
  // the link can still be removed
  await popover.getByRole('button', { name: 'Remove link' }).click();
  await expect(frame.locator('.prose-flow a')).toHaveCount(0);
});
