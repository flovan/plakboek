/**
 * The login modal at `/cms` on a production build, in three engines: it is a
 * real modal once hydrated (focus, pointer and Escape), and a correct sign-in
 * hands the blurred page over to the framed edit shell by animating the real
 * frame, ending where the shell's first paint puts it.
 */
import { expect, test, type Page } from '@playwright/test';
import { e2eUsers } from './helpers/host.ts';

const HOST = 'plakboek-editor';
const BACKDROP = `${HOST} iframe.pk-backdrop`;
const EDITOR_FLAG = 'plakboek:editor';

type FrameReport = {
  readonly href: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly transform: string;
  readonly inner: number | null;
};

/**
 * Reports the frame's rectangle on every animation frame, from a loop the
 * test installs in each document before its scripts run. The loop lives only
 * in the test: production code has no hook for it. The reports reach the test
 * through an exposed function, which survives the navigation.
 */
async function recordFrameRects(page: Page): Promise<FrameReport[]> {
  const reports: FrameReport[] = [];
  await page.exposeFunction('reportFrameRect', (report: FrameReport) => {
    reports.push(report);
  });
  await page.addInitScript(() => {
    const tick = (): void => {
      const frame = document
        .querySelector('plakboek-editor')
        ?.shadowRoot?.querySelector('iframe');
      if (frame) {
        const rect = frame.getBoundingClientRect();
        const report = {
          href: location.href,
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          transform: getComputedStyle(frame).transform,
          inner: frame.contentWindow?.innerWidth ?? null,
        };
        const sink = (window as unknown as Record<string, unknown>)
          .reportFrameRect;
        if (typeof sink === 'function') {
          Promise.resolve(sink(report)).catch(() => undefined);
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return reports;
}

/** The dialog's state, read inside the shadow root. */
async function dialogState(page: Page) {
  return await page.evaluate((tag) => {
    const dialog = document
      .querySelector(tag)
      ?.shadowRoot?.querySelector('dialog');
    return {
      open: dialog?.open ?? false,
      modal: dialog?.matches(':modal') ?? false,
    };
  }, HOST);
}

async function signInWith(
  page: Page,
  account: { email: string; password: string },
): Promise<void> {
  await page.getByLabel('Email address').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('the login modal once hydrated', () => {
  test('is a true modal: focus stays in the card, the site gets no pointer input and Escape does nothing', async ({
    page,
  }) => {
    await page.goto('/cms?next=/about');
    await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');
    expect(await dialogState(page)).toEqual({ open: true, modal: true });

    // Ten Tab presses never reach the site. Focus cycles through the card;
    // some engines hand it to the browser's own UI for one press after the
    // card's last control, as any modal does (the page's active element is
    // then the body) and bring it back on the next. It is never in the site.
    const seen = new Set<string>();
    for (let press = 0; press < 10; press += 1) {
      await page.keyboard.press('Tab');
      const focus = await page.evaluate((tag) => {
        const host = document.querySelector(tag);
        const active = host?.shadowRoot?.activeElement ?? null;
        if (document.activeElement === host) {
          return active?.closest('dialog') != null ? 'card' : 'elsewhere';
        }
        return document.activeElement === document.body ? 'browser' : 'site';
      }, HOST);
      seen.add(focus);
    }
    expect(seen.has('card')).toBe(true);
    expect(seen.has('site')).toBe(false);
    expect(seen.has('elsewhere')).toBe(false);

    // A click where the site's header link is lands on the dialog, not the site.
    const link = await page
      .frameLocator(BACKDROP)
      .locator('.site-name')
      .boundingBox();
    if (link === null) throw new Error('the backdrop has no site header link');
    await page.mouse.click(link.x + link.width / 2, link.y + link.height / 2);
    const backdropFrame = page
      .frames()
      .find((frame) => new URL(frame.url()).pathname === '/about');
    expect(backdropFrame).toBeDefined();
    expect(new URL(page.url()).pathname).toBe('/cms');

    // Escape, twice (a browser may close a dialog on the second), changes
    // nothing: the dialog is still open and still modal.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    expect(await dialogState(page)).toEqual({ open: true, modal: true });
  });
});

test.describe('signing in', () => {
  test('hands the blurred page over to the framed shell, ending where the shell paints', async ({
    page,
  }) => {
    const reports = await recordFrameRects(page);
    await page.goto('/cms?next=/about');
    await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');
    const viewport = page.viewportSize();
    if (viewport === null) throw new Error('the page has no viewport');

    await signInWith(page, e2eUsers().editor);
    await page.waitForURL(
      (url) => url.pathname === '/about' && url.search === '?_edit=1',
    );
    await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');

    // The editor flag is set, and the shell shows its framed iframe.
    expect(
      await page.evaluate((key) => localStorage.getItem(key), EDITOR_FLAG),
    ).toBe('1');
    await expect(page.locator(`${HOST} iframe`)).toHaveAttribute(
      'src',
      /_edit=frame$/,
    );

    const login = reports.filter((r) => new URL(r.href).pathname === '/cms');
    const shell = reports.filter((r) => new URL(r.href).search === '?_edit=1');
    expect(login.length).toBeGreaterThan(3);
    expect(shell.length).toBeGreaterThan(0);

    // The frame starts as the whole viewport and moves in more than one step.
    const first = login[0];
    expect(first).toMatchObject({
      left: 0,
      top: 0,
      width: viewport.width,
      height: viewport.height,
    });
    const steps = new Set(login.map((r) => Math.round(r.width)));
    expect(steps.size).toBeGreaterThan(3);

    // The site is never scaled: no transform, and the document inside the
    // frame is as wide as the frame (less a border) at every reported frame.
    for (const report of [...login, ...shell]) {
      expect(['none', '']).toContain(report.transform);
      if (report.inner !== null && report.width > 0) {
        expect(report.inner).toBeLessThanOrEqual(report.width);
        // A 1px border on each side, and a width that is fractional mid-way.
        expect(report.inner).toBeGreaterThanOrEqual(report.width - 3);
      }
    }

    // The last frame of the hand-over is the first paint of the shell, to the pixel.
    const last = login.at(-1);
    const painted = shell[0];
    if (last === undefined || painted === undefined) {
      throw new Error('no frame was reported');
    }
    for (const side of ['left', 'top', 'width', 'height'] as const) {
      expect(Math.abs(last[side] - painted[side])).toBeLessThanOrEqual(1);
    }
    expect(painted).toMatchObject({ left: 304, top: 24 });
  });
});

const WRONG_CREDENTIALS =
  'Email or password is incorrect. Check them and try again.';
const SIGN_IN_API = '**/api/auth/sign-in/email';

async function openModal(page: Page): Promise<void> {
  await page.goto('/cms?next=/about');
  await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');
}

test.describe('sign-in problems and errors', () => {
  test('shows what is missing under each field and sends nothing', async ({
    page,
  }) => {
    await openModal(page);
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/auth/')) requests.push(request.url());
    });

    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Enter your email address.')).toBeVisible();
    await expect(page.getByText('Enter your password.')).toBeVisible();
    await expect(page.getByLabel('Email address')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await expect(page.getByLabel('Password')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await expect(page.getByLabel('Email address')).toBeFocused();
    expect(requests).toEqual([]);
  });

  test('flags only the invalid field and keeps what was typed in the valid one', async ({
    page,
  }) => {
    await openModal(page);
    await page.getByLabel('Email address').fill('x@');
    await page.getByLabel('Password').fill('something typed');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(
      page.getByText('Enter an address like name@example.com.'),
    ).toBeVisible();
    await expect(page.getByText('Enter your password.')).toHaveCount(0);
    await expect(page.getByLabel('Password')).toHaveValue('something typed');
    await expect(page.getByLabel('Password')).not.toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  test('answers a wrong password with one focused alert, clears the password and keeps the address', async ({
    page,
  }) => {
    await openModal(page);
    const { email } = e2eUsers().editor;
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill('definitely the wrong one');
    await page.getByRole('button', { name: 'Sign in' }).click();

    const alert = page.getByRole('alert');
    await expect(alert).toHaveText(WRONG_CREDENTIALS);
    await expect(alert).toBeFocused();
    await expect(page.getByLabel('Password')).toHaveValue('');
    await expect(page.getByLabel('Email address')).toHaveValue(email);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    expect(await dialogState(page)).toEqual({ open: true, modal: true });
  });

  test('gives an address that has no account the very same alert', async ({
    page,
  }) => {
    await openModal(page);
    await page.getByLabel('Email address').fill('nobody-here@example.com');
    await page.getByLabel('Password').fill('definitely the wrong one');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText(WRONG_CREDENTIALS);
  });

  test('says so when the server cannot be reached, fails, or rate limits', async ({
    page,
  }) => {
    await openModal(page);
    const email = page.getByLabel('Email address');
    await email.fill(e2eUsers().editor.email);

    const attempt = async (): Promise<void> => {
      await page.getByLabel('Password').fill('whatever it is');
      await page.getByRole('button', { name: 'Sign in' }).click();
    };

    await page.route(SIGN_IN_API, (route) => route.abort('connectionrefused'));
    await attempt();
    await expect(page.getByRole('alert')).toHaveText(
      'Could not reach the server. Check your connection and try again.',
    );
    await page.unroute(SIGN_IN_API);

    await page.route(SIGN_IN_API, (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"message":"boom"}',
      }),
    );
    await attempt();
    await expect(page.getByRole('alert')).toHaveText(
      'Something went wrong on our side. Try again in a moment.',
    );
    await page.unroute(SIGN_IN_API);

    await page.route(SIGN_IN_API, (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: '{"message":"Too many requests. Please try again later."}',
      }),
    );
    await attempt();
    await expect(page.getByRole('alert')).toHaveText(
      'Too many attempts. Wait a few minutes, then try again.',
    );
    await expect(email).toHaveValue(e2eUsers().editor.email);
  });

  test('is in flight until the answer comes: read-only fields, a disabled button, one request', async ({
    page,
  }) => {
    await openModal(page);
    let requests = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(SIGN_IN_API, async (route) => {
      requests += 1;
      await held;
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: '{"code":"INVALID_EMAIL_OR_PASSWORD","message":"Invalid"}',
      });
    });

    await page.getByLabel('Email address').fill(e2eUsers().editor.email);
    await page.getByLabel('Password').fill('whatever it is');
    const button = page.getByRole('button', { name: 'Signing in' });
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByLabel('Email address')).toHaveAttribute(
      'readonly',
      '',
    );
    await expect(page.getByLabel('Password')).toHaveAttribute('readonly', '');

    // A second submit (Enter in a field) is ignored while the first is out.
    await page.getByLabel('Password').press('Enter');
    release();
    await expect(page.getByRole('alert')).toHaveText(WRONG_CREDENTIALS);
    expect(requests).toBe(1);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });
});

test.describe('a role that must set up two-step sign-in', () => {
  test('is sent to the set-up step after the password, not into edit mode', async ({
    page,
  }) => {
    await openModal(page);
    await signInWith(page, e2eUsers().superadmin);
    await page.waitForURL((url) => url.pathname === '/cms/two-factor/enrol');
    expect(new URL(page.url()).searchParams.get('next')).toBe('/about');
  });
});
