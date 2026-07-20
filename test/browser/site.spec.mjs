import { expect, test } from "@playwright/test";

const SITE_PAGES = [
  "index.html",
  "participate.html",
  "tasks-data.html",
  "evaluation.html",
  "rules-faq.html"
];

for (const path of SITE_PAGES) {
  test(`${path} renders shared chrome and flow canvas without page errors`, async ({ page }) => {
    const pageErrors = [];
    const consoleErrors = [];
    const failedRequests = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("requestfailed", (request) => {
      failedRequests.push(new URL(request.url()).pathname);
    });

    const response = await page.goto(`/${path}`);
    expect(response?.ok()).toBe(true);
    await expect(page.locator("header.site-header .brand")).toHaveText("RoCo-Spring");
    await expect(page.locator("footer.site-footer")).toContainText("NeurIPS 2026");
    await expect(page.locator("#flow-canvas")).toBeVisible();

    const canvasSize = await page.locator("#flow-canvas").evaluate((canvas) => ({
      width: canvas.width,
      height: canvas.height
    }));
    expect(canvasSize.width).toBeGreaterThan(0);
    expect(canvasSize.height).toBeGreaterThan(0);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });
}

test("registration portal starts with three slots, validates partial members, and switches tabs", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const response = await page.goto("/team-registration.html");
  expect(response?.ok()).toBe(true);
  await expect(page.locator("header.site-header .brand")).toHaveText("RoCo-Spring");
  await expect(page.locator("#public-auth")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#registration-members .member-slot")).toHaveCount(3);
  await expect(page.locator("#registration-members legend").first()).toContainText("Team member 1");
  await expect(page.locator("#registration-members legend").nth(2)).toContainText("Team member 3");
  for (const field of ["fullName", "email", "affiliation"]) {
    await expect(page.locator(`#register-member-1-${field}`)).toHaveAttribute("required", "");
    await expect(page.locator(`#register-member-2-${field}`)).not.toHaveAttribute("required", "");
    await expect(page.locator(`#register-member-3-${field}`)).not.toHaveAttribute("required", "");
  }

  await page.locator("#register-team-name").fill("Browser Validation Team");
  await page.locator("#register-primary-email").fill("member@example.org");
  await page.locator('#registration-form input[name="tracks"][value="optical-flow"]').check();
  await page.locator("#register-member-1-fullName").fill("Member One");
  await page.locator("#register-member-1-email").fill("member@example.org");
  await page.locator("#register-member-1-affiliation").fill("Example Institute");
  await page.locator("#register-member-2-fullName").fill("Partial Member");
  await page.locator("#submitter-is-member").check();
  await page.getByRole("button", { name: "Register team" }).click();

  await expect(page.locator("#register-member-2-email-error")).toContainText("required");
  await expect(page.locator("#register-member-2-affiliation-error")).toContainText("required");
  await expect(page.locator("#register-member-2-email")).toHaveAttribute("aria-invalid", "true");

  await page.getByRole("tab", { name: "Sign in to an existing team" }).click();
  await expect(page.locator("#login-tab-panel")).toBeVisible();
  await expect(page.locator("#register-tab-panel")).toBeHidden();
  expect(pageErrors).toEqual([]);
});

test("team members can be added beyond ten without losing entered values", async ({ page }) => {
  await page.goto("/team-registration.html");
  await expect(page.locator("#public-auth")).toBeVisible({ timeout: 15_000 });

  await page.locator("#register-member-1-fullName").fill("Persistent Member");
  await page.locator("#register-member-2-email").fill("second@example.org");
  const secondMemberClearButton = page.locator("#registration-members .member-slot").nth(1)
    .locator(".member-remove-button");
  await expect(secondMemberClearButton).toBeVisible();

  await page.locator('#registration-form button[type="submit"]').click();
  await expect(page.locator("#register-team-name")).toHaveAttribute("aria-invalid", "true");
  await secondMemberClearButton.click();
  await expect(page.locator("#register-member-2-email")).toHaveValue("");
  await expect(secondMemberClearButton).toBeHidden();
  await expect(page.locator("#register-team-name")).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.locator('#registration-form [aria-invalid="true"]')).toHaveCount(0);
  await expect(page.locator('#registration-form [data-field-error]:not(:empty)')).toHaveCount(0);

  await page.locator("#register-member-2-email").fill("second@example.org");
  await expect(secondMemberClearButton).toBeVisible();

  for (let expectedCount = 4; expectedCount <= 12; expectedCount += 1) {
    await page.locator("#add-registration-member").click();
    await expect(page.locator("#registration-members .member-slot")).toHaveCount(expectedCount);
    await expect(page.locator(`#register-member-${expectedCount}-fullName`)).toBeFocused();
  }

  await expect(page.locator("#add-registration-member")).toBeEnabled();
  await expect(page.locator("#register-member-1-fullName")).toHaveValue("Persistent Member");
  await expect(page.locator("#register-member-2-email")).toHaveValue("second@example.org");
  await expect(page.locator("#registration-members legend").nth(11)).toContainText("Team member 12");
  await expect(page.locator("#registration-members .member-slot").nth(1)
    .locator(".member-remove-button")).toBeVisible();
  await expect(page.locator("#registration-members .member-slot").nth(2)
    .locator(".member-remove-button")).toBeHidden();
  await expect(page.locator("#registration-members .member-slot").nth(3)
    .locator(".member-remove-button")).toBeVisible();

  await page.locator("#registration-members .member-slot").nth(1)
    .locator(".member-remove-button").click();
  await expect(page.locator("#registration-members .member-slot")).toHaveCount(12);
  await expect(page.locator("#register-member-2-email")).toHaveValue("");
  await expect(page.locator("#registration-members .member-slot").nth(1)
    .locator(".member-remove-button")).toBeHidden();

  await page.locator("#register-member-5-fullName").fill("Member That Moves Up");
  await page.locator("#register-member-12-email").fill("last-member@example.org");
  await page.locator("#registration-members .member-slot").nth(3)
    .locator(".member-remove-button").click();

  await expect(page.locator("#registration-members .member-slot")).toHaveCount(11);
  await expect(page.locator("#register-member-4-fullName")).toHaveValue("Member That Moves Up");
  await expect(page.locator("#register-member-11-email")).toHaveValue("last-member@example.org");
  await expect(page.locator("#registration-members legend").nth(10)).toContainText("Team member 11");
  await expect(page.locator("#add-registration-member")).toBeEnabled();

  await page.locator("#add-registration-member").click();
  await expect(page.locator("#registration-members .member-slot")).toHaveCount(12);
  await expect(page.locator("#register-member-12-fullName")).toBeFocused();
  await expect(page.locator("#add-registration-member")).toBeEnabled();
});

test("login query mode and keyboard tab behavior are accessible", async ({ page }) => {
  await page.goto("/team-registration.html?mode=login");
  await expect(page.locator("#public-auth")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#login-tab")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#login-tab-panel")).toBeVisible();

  await page.locator("#login-tab").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#register-tab")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#register-tab-panel")).toBeVisible();
});

for (const { label, viewport } of [
  { label: "mobile", viewport: { width: 390, height: 844 } },
  { label: "desktop", viewport: { width: 1280, height: 900 } }
]) {
  test(`registration page remains within the ${label} viewport`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/team-registration.html");
    await expect(page.locator("#public-auth")).toBeVisible({ timeout: 15_000 });
    for (let memberIndex = 4; memberIndex <= 12; memberIndex += 1) {
      await page.locator("#add-registration-member").click();
    }
    await expect(page.locator("#registration-members .member-slot")).toHaveCount(12);
    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  });
}

test("mobile navigation toggles with an accessible state", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/team-registration.html");
  const toggle = page.locator(".nav-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#site-nav")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("citation copy button copies the code block exactly", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "http://127.0.0.1:4173"
  });
  for (const [path, citationId] of [
    ["/participate.html", "citation-ptlflow"],
    ["/tasks-data.html", "citation-flowbench"]
  ]) {
    await page.goto(path);
    const citation = page.locator(`#${citationId}`);
    const expected = await citation.textContent();
    await page.locator(`[data-copy-target="${citationId}"]`).click();
    await expect(page.locator(`[data-copy-target="${citationId}"] + .copy-status`))
      .toHaveText("BibTeX copied.");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(expected);
  }
});

test("registration startup failure replaces the indefinite loading state", async ({ page }) => {
  await page.route("**/assets/team-registration.js", (route) => route.abort("failed"));
  await page.goto("/team-registration.html");
  await expect(page.locator("#portal-loading")).toHaveAttribute("role", "alert");
  await expect(page.locator("#portal-loading")).toContainText(
    "Secure team services could not be loaded"
  );
  await expect(page.locator("#registration-portal")).toHaveAttribute("aria-busy", "false");
});
