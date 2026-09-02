import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  await request.post("http://127.0.0.1:4173/api/reset");
});

test("reserves the only free test ticket", async ({ page }) => {
  await page.goto("http://127.0.0.1:4173/event");
  await expect(page.getByText("AUTOBOT Classroom Test Drop", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reserve free ticket" }).click();
  await expect(page.getByText("Reservation confirmed", { exact: true })).toBeVisible();
});

test("server prevents a second reservation", async ({ request }) => {
  const first = await request.post("http://127.0.0.1:4173/api/reservations");
  const second = await request.post("http://127.0.0.1:4173/api/reservations");
  expect(first.status()).toBe(201);
  expect(second.status()).toBe(409);
});
