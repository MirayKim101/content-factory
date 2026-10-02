/* Browser-only acceptance: API writes are intercepted, never sent to the server.
 * Supply Playwright through NODE_PATH; no repository dependency installation.
 * Run against the local Nuxt UI (3100), not a production endpoint.
 */
const assert = require("node:assert/strict");
const { chromium } = require(process.env.CF_PLAYWRIGHT_MODULE || "playwright");

const origin = "http://127.0.0.1:3100";
const projectId = "00000000-0000-4000-8000-000000000001";
const intentId = "00000000-0000-4000-8000-000000000002";
const suggestionId = "00000000-0000-4000-8000-000000000003";
const jobId = "00000000-0000-4000-8000-000000000004";
const timestamp = "2026-10-02T00:00:00.000Z";
const intent = {
  id: intentId,
  projectId,
  state: "READY",
  provider: "LOCAL_FIXTURE",
  model: "browser-fixture",
  failureCode: null,
  failureMessage: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  suggestions: [
    {
      id: suggestionId,
      ordinal: 0,
      startMs: 1000,
      endMs: 20000,
      title: "Browser fixture moment",
      rationale: "Human selection required",
      confidenceBasisPoints: 0,
    },
  ],
};

async function selectors(browser) {
  let checked = 0;
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(10000);
    // Safety fence: future controls cannot turn this read-only smoke into writes.
    await page.route("**/api/v1/**", (route) => {
      if (!["GET", "HEAD"].includes(route.request().method()))
        return route.abort();
      return route.continue();
    });
    for (const path of [
      "/montage-assets",
      "/vertical",
      "/publications",
      "/sources",
      "/library",
      "/horizontal",
    ]) {
      await page.goto(origin + path);
      await page.locator("h1").waitFor();
      await page.waitForFunction(
        () => !document.querySelector('[aria-busy="true"]'),
      );
      const controls = page.getByRole("combobox");
      // Wait for page-specific async project controls to appear.
      await controls
        .first()
        .waitFor({ timeout: 3000 })
        .catch(() => {});
      let pageChecked = 0;
      for (let index = 0; index < (await controls.count()); index++) {
        const control = controls.nth(index);
        if (!(await control.isVisible()) || !(await control.isEnabled()))
          continue;
        await control.click();
        const list = page.getByRole("listbox");
        await list.waitFor();
        const geometry = await list.evaluate((element) => {
          const overlay = element.closest('[data-pc-section="overlay"]');
          const rect = overlay.getBoundingClientRect();
          const option = element.querySelector('[role="option"]');
          return {
            left: rect.left,
            right: rect.right,
            width: innerWidth,
            position: getComputedStyle(overlay).position,
            background: getComputedStyle(overlay).backgroundColor,
            optionHeight: option?.getBoundingClientRect().height ?? 0,
          };
        });
        assert.ok(
          ["absolute", "fixed"].includes(geometry.position),
          JSON.stringify(geometry),
        );
        assert.notEqual(geometry.background, "rgba(0, 0, 0, 0)");
        assert.ok(
          geometry.left >= -1 && geometry.right <= geometry.width + 1,
          `${path}: clipped overlay ${JSON.stringify(geometry)}`,
        );
        if (geometry.optionHeight) assert.ok(geometry.optionHeight >= 32);
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Escape");
        await list.waitFor({ state: "hidden" });
        assert.equal(await control.getAttribute("aria-expanded"), "false");
        checked++;
        pageChecked++;
      }
      const minimum =
        {
          "/montage-assets": 2,
          "/vertical": 1,
          "/publications": 1,
          "/library": 1,
        }[path] ?? 0;
      assert.ok(
        pageChecked >= minimum,
        `${path}: expected ${minimum} enabled selectors, checked ${pageChecked}`,
      );
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        `${path}: horizontal overflow at ${width}`,
      );
      console.log(`PASS ${path} selectors and page width: ${width}px`);
    }
    await page.close();
  }
  assert.ok(checked >= 10, `Insufficient selector coverage: ${checked}`);
  console.log(`PASS selectors: ${checked} desktop/mobile overlays`);
}

async function clips(browser) {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const source = {
      id: suggestionId,
      status: "READY",
      sourceVersion: 1,
      originalFilename: "fixture.mp4",
      contentType: "video/mp4",
      sizeBytes: "24",
      sha256: "a".repeat(64),
      durationMs: 30000,
      authorization: {
        sourceVersion: 1,
        status: "CLEARED",
        usable: true,
        revision: 1,
      },
    };
    let created = false;
    let accepted = 0;
    await page.route("**/api/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const json = (body) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      if (path === `/api/v1/projects/${projectId}`)
        return json({
          id: projectId,
          name: "Browser smoke source",
          status: "SOURCE_READY",
          rights: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          source,
          artifact: {
            id: intentId,
            role: "SOURCE",
            status: "READY",
            sizeBytes: "24",
            sha256: "a".repeat(64),
            contentType: "video/mp4",
            lineageSourceId: source.id,
            lineageSourceVersion: 1,
            recipeVersion: "fixture",
          },
        });
      if (path.endsWith("/clip-generations")) {
        if (request.method() === "GET")
          return json({ items: created ? [intent] : [] });
        assert.equal(request.method(), "POST");
        const body = request.postDataJSON();
        assert.equal(body.externalProviderTransferAllowed, true);
        assert.equal(body.transcript.length, 1);
        assert.ok(request.headers()["idempotency-key"]);
        created = true;
        return json(intent);
      }
      if (path === `/api/v1/clip-generations/${intentId}/accept`) {
        assert.equal(request.method(), "POST");
        assert.deepEqual(request.postDataJSON().suggestionIds, [suggestionId]);
        assert.ok(request.headers()["idempotency-key"]);
        accepted++;
        return json({ requestId: intentId, projectId, jobs: [{ id: jobId }] });
      }
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "BROWSER_FIXTURE",
            message: "No real media in browser fixture",
          },
        }),
      });
    });
    await page.goto(`${origin}/cuts?projectId=${projectId}`);
    const panel = page.locator(".ai-panel");
    await panel.waitFor();
    const create = panel.getByRole("button", {
      name: "Найти моменты",
      exact: true,
    });
    assert.equal(await create.isEnabled(), false);
    await page
      .locator("#clip-transcript")
      .fill("1\n00:00:01,000 --> 00:00:20,000\nFixture transcript.");
    assert.equal(await create.isEnabled(), false);
    await page.locator("#clip-transfer-consent").check();
    await create.click();
    await panel.getByText("Рекомендации готовы", { exact: true }).waitFor();
    assert.ok((await panel.innerText()).includes("без оценки качества"));
    assert.ok(!(await panel.innerText()).includes("0%"));
    assert.equal(
      await page.locator("#clip-transfer-consent").isChecked(),
      false,
    );
    const accept = panel.getByRole("button", {
      name: "Нарезать выбранное (0)",
      exact: true,
    });
    assert.equal(await accept.isEnabled(), false);
    await panel
      .getByRole("button", { name: "Выбрать все", exact: true })
      .click();
    await panel
      .getByRole("button", { name: "Нарезать выбранное (1)", exact: true })
      .click();
    await page.waitForURL((url) => url.searchParams.get("jobs") === jobId);
    assert.equal(accepted, 1);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      `clip panel overflow at ${width}`,
    );
    await page.close();
    console.log(
      `PASS clip consent, human selection, exact acceptance and job navigation: ${width}px (mocked API)`,
    );
  }
}

(async () => {
  const browser = await chromium.launch({
    channel: process.env.CF_BROWSER_CHANNEL || "msedge",
    headless: true,
  });
  try {
    await selectors(browser);
    await clips(browser);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
