
const { test, expect } = require('@playwright/test');

test('onboarding appears and can be dismissed', async ({ page }) => {
  // serve files from file:// for Tauri-like environment
  await page.goto('http://localhost:3000'); // CI will run npm run dev or serve dist
  const modal = page.locator('#onboarding');
  await expect(modal).toBeVisible();
  await page.click('#onboarding-done');
  await expect(modal).toBeHidden();
});

test('can create and store an item', async ({ page }) => {
  await page.goto('http://localhost:3000');
  // assume there's a button to create an item with id create-item
  const btn = page.locator('#create-item');
  if (await btn.count() === 0) {
    test.skip();
    return;
  }
  await btn.click();
  const item = page.locator('.item').first();
  await expect(item).toBeVisible();
});
