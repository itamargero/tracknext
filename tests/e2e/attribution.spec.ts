import { expect, test } from '@playwright/test';

test('captures first, intermediate and last marketing touch for a real signup Server Action', async ({ page, context }) => {
  await page.goto('/?utm_source=Google&utm_medium=organic');
  await page.goto('/?utm_source=Newsletter&utm_medium=email&utm_campaign=Launch');
  await page.goto('/?utm_source=LinkedIn&utm_medium=paid_social');
  await page.getByRole('link', { name: 'Visit pricing' }).click();
  await page.getByRole('link', { name: 'Sign up' }).click();
  await page.getByLabel('Email').fill('developer@example.com');
  await page.getByRole('button', { name: 'Create example lead' }).click();
  await expect(page).toHaveURL('/result');
  await expect(page.getByTestId('conversion')).toContainText('"first":"google"');
  await expect(page.getByTestId('conversion')).toContainText('"middle":["newsletter"]');
  await expect(page.getByTestId('conversion')).toContainText('"last":"linkedin"');
  await expect(page.getByTestId('conversion')).toContainText('"count":3');
  const cookie = (await context.cookies()).find((candidate) => candidate.name === 'tracknext');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Lax');
});

test('captures attribution and submits the Server Action with browser JavaScript disabled', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3187/signup?utm_source=NoScript&utm_medium=email');
    await page.getByLabel('Email').fill('noscript@example.com');
    await page.getByRole('button', { name: 'Create example lead' }).click();
    await expect(page.getByTestId('conversion')).toContainText('"first":"noscript"');
    await expect(page.getByTestId('conversion')).toContainText('"count":1');
  } finally {
    await context.close();
  }
});

test('reloads, internal campaign links and API calls cannot overwrite the acquisition source', async ({ page, request }) => {
  await page.goto('/?utm_source=newsletter&utm_medium=email');
  await page.reload();
  await page.goto('/pricing?utm_source=internal_banner', { referer: 'http://127.0.0.1:3187/' });
  const response = await page.request.get('/api/attribution');
  const snapshot: unknown = await response.json();
  expect(snapshot).toMatchObject({ totalTouchCount: 1, firstTouch: { source: 'newsletter' }, lastTouch: { source: 'newsletter' } });
  const apiArrival = await request.get('/api/attribution?utm_source=background');
  expect(apiArrival.headers()['set-cookie']).toBeUndefined();
});
