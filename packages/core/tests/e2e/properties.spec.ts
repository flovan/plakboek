/**
 * Changing a block's properties from the side panel, in a real browser: the
 * panel opens by an explicit action, every widget edits its property and the
 * block re-renders in the frame as it does, the constraint states hold, an
 * invalid value is shown and not applied, and a change is saved after a pause
 * and undone as one step.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import {
  framedSite,
  HOST,
  LIVE_REGION,
  openEditor,
} from './helpers/editing.ts';
import { e2eUsers } from './helpers/host.ts';
import {
  createEditablePage,
  heading,
  paragraph,
  section,
  type EditablePage,
  type FactoryBlock,
} from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';

const SAVED = 'All changes saved';

/** The panel's tab for Properties. */
function propertiesTab(page: Page) {
  return page.getByRole('tab', { name: 'Properties' });
}

/** The Text control of the open Properties panel. */
function textControl(page: Page) {
  return page.getByRole('textbox', { name: 'Text' });
}

/** Double-click down to a block and once more on it: the ask for its Properties. */
async function openPropertiesOf(frame: Frame, selector: string): Promise<void> {
  const target = frame.locator(selector).first();
  await target.dblclick();
  await target.dblclick();
  await target.dblclick();
}

/** Double-click down to the `at`th heading of the first section and open its Properties. */
async function openPropertiesOfHeading(
  frame: Frame,
  at: number,
): Promise<void> {
  await openPropertiesOf(frame, `section.section >> h2 >> nth=${String(at)}`);
}

async function expectSaved(page: Page): Promise<void> {
  await expect(page.getByText(SAVED)).toBeVisible();
}

/** Opens a page holding a heading "Hello" and a paragraph in the editor. */
async function openPageWithHeading(page: Page): Promise<EditablePage> {
  const created = await createEditablePage({
    blocks: [section(heading('Hello'), paragraph('Below'))],
  });
  await openEditor(page, created.path);
  return created;
}

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

test.describe('changing a heading in the panel', () => {
  test('double-clicking a heading opens its text in the panel, typing shows live in the frame without losing the caret, and it is saved after the pause', async ({
    page,
  }) => {
    await openPageWithHeading(page);
    const frame = await framedSite(page);
    const first = frame
      .locator('section.section')
      .first()
      .locator('h2')
      .first();

    await openPropertiesOfHeading(frame, 0);
    await expect(propertiesTab(page)).toHaveAttribute('aria-selected', 'true');
    const control = textControl(page);
    await expect(control).toHaveValue('Hello');
    // the ask for Properties moves focus into the first control
    await expect(control).toBeFocused();

    await control.press('End');
    await control.pressSequentially(' there');
    await expect(first).toHaveText('Hello there', { timeout: 1000 });
    // the panel's own value and caret were never overwritten by the render
    await expect(control).toHaveValue('Hello there');
    await expect(control).toBeFocused();
    expect(
      await control.evaluate((el: HTMLInputElement) => el.selectionStart),
    ).toBe('Hello there'.length);

    // typing on after the render carries on from the caret
    await control.pressSequentially('!');
    await expect(first).toHaveText('Hello there!', { timeout: 1000 });
    await expectSaved(page);

    await page.reload();
    const reloaded = await framedSite(page);
    await expect(
      reloaded.locator('section.section').first().locator('h2').first(),
    ).toHaveText('Hello there!');
  });
});

test.describe('the panel and its tabs', () => {
  test('selecting a block never switches the tab or moves focus into the panel', async ({
    page,
  }) => {
    await openPageWithHeading(page);
    const frame = await framedSite(page);
    const blocks = page.getByRole('tab', { name: 'Blocks' });
    await expect(blocks).toHaveAttribute('aria-selected', 'true');

    // drill to a heading by clicks: it is selected, the tab stays on Blocks
    const target = frame
      .locator('section.section')
      .first()
      .locator('h2')
      .first();
    await target.dblclick();
    await target.dblclick();
    await expect(blocks).toHaveAttribute('aria-selected', 'true');
    expect(
      await page
        .locator(HOST)
        .evaluate((host) => host.shadowRoot?.activeElement?.tagName ?? ''),
    ).not.toBe('INPUT');
  });
});

const DEMO = 'section.section >> .props-demo >> p >> nth=0';

function demo(props: Readonly<Record<string, unknown>>): FactoryBlock {
  return { type: 'propsDemo', props };
}

/** Opens a page holding one props-demo block and its Properties; returns its frame. */
async function openDemo(
  page: Page,
  props: Readonly<Record<string, unknown>> = { title: 'Demo', count: 5 },
): Promise<Frame> {
  const created = await createEditablePage({
    blocks: [section(demo(props))],
  });
  await openEditor(page, created.path);
  const frame = await framedSite(page);
  await openPropertiesOf(frame, DEMO);
  await expect(propertiesTab(page)).toHaveAttribute('aria-selected', 'true');
  return frame;
}

/** What the props-demo block shows for a property, as text. */
function shown(frame: Frame, key: string) {
  return frame.locator(`.props-demo [data-prop="${key}"]`);
}

test.describe('every widget edits its property and the block re-renders live', () => {
  test('text-like controls', async ({ page }) => {
    const frame = await openDemo(page);

    await page.getByRole('textbox', { name: 'Title' }).fill('New title');
    await expect(shown(frame, 'title')).toHaveText('New title');

    await page
      .getByRole('textbox', { name: 'Link' })
      .fill('https://example.com/x');
    await expect(shown(frame, 'link')).toHaveText('https://example.com/x');

    const handle = page.getByRole('textbox', { name: 'Handle' });
    await handle.fill('my-handle');
    await expect(shown(frame, 'handle')).toHaveText('my-handle');
    await expect(
      page.getByText('Lowercase letters, numbers and hyphens.'),
    ).toBeVisible();

    await page.getByRole('textbox', { name: 'Notes' }).fill('Some notes');
    await expect(shown(frame, 'notes')).toHaveText('Some notes');

    await page.getByRole('spinbutton', { name: 'Count' }).fill('42');
    await expect(shown(frame, 'count')).toHaveText('42');

    await page.getByRole('textbox', { name: 'Data' }).fill('{"a":1}');
    await expect(shown(frame, 'data')).toHaveText('{"a":1}');
  });

  test('pickers, switches, selects and sliders apply at once', async ({
    page,
  }) => {
    const frame = await openDemo(page);

    await page.getByRole('slider', { name: 'Level' }).fill('7');
    await expect(shown(frame, 'level')).toHaveText('7');
    // the slider's current value sits beside its label
    await expect(page.locator(`${HOST} [data-range-value]`)).toHaveText('7');

    await page.getByRole('checkbox', { name: 'Agree' }).check();
    await expect(shown(frame, 'agree')).toHaveText('true');

    await page.getByRole('switch', { name: 'Active' }).check();
    await expect(shown(frame, 'active')).toHaveText('true');

    await page.getByRole('combobox', { name: 'Size' }).selectOption('medium');
    await expect(shown(frame, 'size')).toHaveText('medium');

    await page.getByRole('radio', { name: 'Lively' }).check();
    await expect(shown(frame, 'mood')).toHaveText('lively');

    // the stored order is the choices' order, whatever order they were ticked in
    await page.getByRole('checkbox', { name: 'Blue' }).check();
    await page.getByRole('checkbox', { name: 'Red' }).check();
    await expect(shown(frame, 'tags')).toHaveText('["red","blue"]');

    await page.getByRole('checkbox', { name: 'Two' }).check();
    await expect(shown(frame, 'extras')).toHaveText('["two"]');

    await page.getByLabel('Publish at').fill('2026-10-14T10:30');
    await expect(shown(frame, 'publishAt')).toHaveText(
      new Date('2026-10-14T10:30').toISOString(),
    );

    await page.getByLabel('Day', { exact: true }).fill('2026-10-14');
    await expect(shown(frame, 'day')).toHaveText('2026-10-14');
  });

  test('a half-filled date is not sent, so it neither clears the value nor wipes what was typed', async ({
    page,
  }) => {
    const frame = await openDemo(page, { title: 'Demo', day: '2026-10-14' });
    const day = page.getByLabel('Day', { exact: true });
    await expect(shown(frame, 'day')).toHaveText('2026-10-14');

    // clearing one segment leaves the entry half-filled
    await day.focus();
    await page.keyboard.press('Backspace');
    expect(
      await day.evaluate((el: HTMLInputElement) => el.validity.badInput),
    ).toBe(true);
    // the preview and the save would have taken the value away by now
    await page.waitForTimeout(400);
    await expect(shown(frame, 'day')).toHaveText('2026-10-14');
    expect(
      await day.evaluate((el: HTMLInputElement) => el.validity.badInput),
    ).toBe(true);

    // a whole date goes through, and so does a deliberate clear
    await day.fill('2026-10-20');
    await expect(shown(frame, 'day')).toHaveText('2026-10-20');
    await day.fill('');
    await expect(shown(frame, 'day')).toHaveCount(0);
  });

  test('a repeater adds, edits, moves and removes its items', async ({
    page,
  }) => {
    const frame = await openDemo(page);
    const add = page.locator(`${HOST} [data-repeater-action="add"]`);
    const row = (at: number) =>
      page.locator(`${HOST} [data-repeater-row="${String(at)}"]`);

    // what the block shows is read as data: the order of an item's keys is not the editor's
    const expectItems = async (items: readonly unknown[]): Promise<void> => {
      await expect
        .poll(async () =>
          JSON.parse((await shown(frame, 'items').textContent()) ?? 'null'),
        )
        .toEqual(items);
    };

    // an empty list shows only the Add item button
    await expect(page.locator(`${HOST} [data-repeater-row]`)).toHaveCount(0);

    await add.click();
    await row(0).getByRole('textbox', { name: 'Item label' }).fill('First');
    await expectItems([{ label: 'First' }]);

    await add.click();
    await row(1).getByRole('textbox', { name: 'Item label' }).fill('Second');
    await row(1).getByRole('checkbox', { name: 'Done' }).check();
    await expectItems([{ label: 'First' }, { label: 'Second', done: true }]);

    await row(0).locator('[data-repeater-action="later"]').click();
    await expectItems([{ label: 'Second', done: true }, { label: 'First' }]);

    await row(0).locator('[data-repeater-action="remove"]').click();
    await expectItems([{ label: 'First' }]);
  });

  test('what cannot be chosen yet is shown read-only with a note on where it will be edited', async ({
    page,
  }) => {
    await openDemo(page);
    const notes = page.locator(`${HOST} [data-note]`);
    await expect(
      page.locator(`${HOST} [data-note="note-rich-text"]`),
    ).toContainText('Formatted text is edited on the page.');
    await expect(page.locator(`${HOST} [data-note="note-media"]`)).toHaveCount(
      2,
    );
    await expect(
      page.locator(`${HOST} [data-note="note-media"]`).first(),
    ).toContainText('None');
    await expect(
      page.locator(`${HOST} [data-note="note-media"]`).first(),
    ).toContainText(
      'Choosing a file is available once the media library ships.',
    );
    await expect(
      page.locator(`${HOST} [data-note="note-entry"]`),
    ).toContainText('Choosing an entry is available once entry editing ships.');
    await expect(notes).toHaveCount(4);
  });
});

test.describe('constraints', () => {
  test('a hidden property has no control, a fixed one is disabled with its hint, a narrowed one offers only the allowed choices', async ({
    page,
  }) => {
    await openDemo(page);

    await expect(page.getByLabel('Hidden', { exact: true })).toHaveCount(0);
    await expect(page.locator(`${HOST} [data-field="hiddenProp"]`)).toHaveCount(
      0,
    );

    const fixed = page.getByRole('textbox', { name: 'Fixed' });
    await expect(fixed).toBeDisabled();
    await expect(fixed).toHaveValue('fixed value');
    await expect(
      page.getByText("Set by the site. It can't be changed here."),
    ).toBeVisible();

    const options = page
      .getByRole('combobox', { name: 'Narrowed' })
      .locator('option');
    expect(
      await options.evaluateAll((all) =>
        all.map((option) => (option as HTMLOptionElement).value),
      ),
    ).toEqual(['', 'alpha', 'beta']);
  });
});

test.describe('invalid input and needs input', () => {
  test('a value above its maximum shows an error under the field and leaves the frame on the last valid render', async ({
    page,
  }) => {
    const frame = await openDemo(page);
    const count = page.getByRole('spinbutton', { name: 'Count' });
    await expect(shown(frame, 'count')).toHaveText('5');

    await count.fill('500');
    await expect(count).toHaveAttribute('aria-invalid', 'true');
    await expect(
      page.locator(`${HOST} [data-field="count"] [data-field-error]`),
    ).toHaveText('This value is not valid.');
    // what is typed stays where it is, and the frame did not take it
    await expect(count).toHaveValue('500');
    await expect(shown(frame, 'count')).toHaveText('5');

    await count.fill('50');
    await expect(shown(frame, 'count')).toHaveText('50');
    await expect(count).not.toHaveAttribute('aria-invalid', 'true');
    await expect(
      page.locator(`${HOST} [data-field="count"] [data-field-error]`),
    ).toHaveCount(0);
  });

  test('a preview request that fails marks the field not valid instead of leaving it looking saved', async ({
    page,
  }) => {
    const frame = await openDemo(page);
    const count = page.getByRole('spinbutton', { name: 'Count' });
    await expect(shown(frame, 'count')).toHaveText('5');

    await page.route('**/cms/api/pages/*/preview', (route) => route.abort());
    await count.fill('7');
    await expect(count).toHaveAttribute('aria-invalid', 'true');
    // what is typed stays, the frame did not take it and nothing was queued to save
    await expect(count).toHaveValue('7');
    await expect(shown(frame, 'count')).toHaveText('5');

    await page.unroute('**/cms/api/pages/*/preview');
    await count.fill('8');
    await expect(shown(frame, 'count')).toHaveText('8');
    await expect(count).not.toHaveAttribute('aria-invalid', 'true');
  });

  test('a required value emptied again shows Needs input and the marker in the frame, and no error', async ({
    page,
  }) => {
    const frame = await openDemo(page);
    const title = page.getByRole('textbox', { name: 'Title' });
    await expect(page.locator(`${HOST} [data-needs-input-tag]`)).toHaveCount(0);

    await title.fill('');
    const field = page.locator(`${HOST} [data-field="title"]`);
    await expect(field.locator('[data-needs-input-tag]')).toHaveText(
      'Needs input',
    );
    await expect(field.locator('[data-field-error]')).toHaveCount(0);
    await expect(title).not.toHaveAttribute('aria-invalid', 'true');
    await expect(shown(frame, 'title')).toHaveCount(0);
    // the marker on the page follows once the empty value is saved
    await expect(page.locator(`${HOST} [data-marker]`)).toHaveCount(1);

    // filling it again clears both, live
    await title.fill('Back again');
    await expect(field.locator('[data-needs-input-tag]')).toHaveCount(0);
    await expect(shown(frame, 'title')).toHaveText('Back again');
    await expect(page.locator(`${HOST} [data-marker]`)).toHaveCount(0);
  });
});

test.describe('undo and focus', () => {
  test('a burst of keystrokes in one field is one undo step, and undoing it restores the panel, the frame and storage', async ({
    page,
  }) => {
    await openPageWithHeading(page);
    const frame = await framedSite(page);
    const first = frame
      .locator('section.section')
      .first()
      .locator('h2')
      .first();
    await openPropertiesOfHeading(frame, 0);
    const control = textControl(page);
    await expect(control).toBeFocused();

    await control.press('End');
    // slow enough that every keystroke is rendered and queued on its own
    await control.pressSequentially(' world', { delay: 200 });
    await expect(first).toHaveText('Hello world', { timeout: 1000 });
    // leaving the field sends the save and ends the burst
    await control.blur();
    await expectSaved(page);

    await page.keyboard.press('Control+z');
    await expect(first).toHaveText('Hello');
    await expect(control).toHaveValue('Hello');
    await expect(page.locator(LIVE_REGION)).toContainText(
      'Undone: Changed Text of Heading.',
    );
    await expectSaved(page);

    await page.reload();
    const reloaded = await framedSite(page);
    await expect(
      reloaded.locator('section.section').first().locator('h2').first(),
    ).toHaveText('Hello');
  });

  test('the toolbar Properties button opens the panel on its tab and focuses the first control', async ({
    page,
  }) => {
    await openPageWithHeading(page);
    const frame = await framedSite(page);
    const target = frame
      .locator('section.section')
      .first()
      .locator('h2')
      .first();
    // two double-clicks leave the heading selected without asking for Properties
    await target.dblclick();
    await target.dblclick();
    await expect(page.getByRole('tab', { name: 'Blocks' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await page.getByRole('button', { name: 'Properties of Heading' }).click();
    await expect(propertiesTab(page)).toHaveAttribute('aria-selected', 'true');
    await expect(textControl(page)).toBeFocused();
  });

  test('adding a heading opens Properties with focus in its empty Text control, and selecting another block afterwards leaves focus alone', async ({
    page,
  }) => {
    await openPageWithHeading(page);
    const frame = await framedSite(page);
    const target = frame
      .locator('section.section')
      .first()
      .locator('h2')
      .first();
    await target.dblclick();
    await target.dblclick();

    await page.getByRole('button', { name: 'Add after Heading' }).click();
    const picker = page.getByRole('dialog', { name: 'Add a block' });
    await picker.getByRole('combobox').fill('head');
    await page.keyboard.press('Enter');

    await expect(propertiesTab(page)).toHaveAttribute('aria-selected', 'true');
    const control = textControl(page);
    await expect(control).toHaveValue('');
    await expect(control).toBeFocused();
    await expect(
      page.locator(`${HOST} [data-field="text"] [data-needs-input-tag]`),
    ).toHaveText('Needs input');

    // clicking another block in the frame selects it; the panel does not take focus
    await frame
      .locator('section.section')
      .first()
      .locator('h2')
      .first()
      .click();
    await expect(control).not.toBeFocused();
    expect(
      await page
        .locator(HOST)
        .evaluate((host) => host.shadowRoot?.activeElement?.tagName ?? ''),
    ).not.toBe('INPUT');
    await expect(propertiesTab(page)).toHaveAttribute('aria-selected', 'true');
  });
});
