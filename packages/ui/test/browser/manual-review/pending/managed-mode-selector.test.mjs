import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

// 企业受管策略下模式菜单的表现（改造点 T2）。规格与验收见 docs/ui/managed-mode-selector.md。
const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/managed-mode-selector.fixture.tsx";
let server, browser, origin;
const artifacts = join(root, "packages/desktop/.e2e-artifacts/managed-mode-selector-browser");
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    cacheDir: join(root, "node_modules/.vite-managed-mode-selector"),
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "managed-mode-selector-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: {
      host: "127.0.0.1",
      port: 0,
      hmr: false,
      watch: { ignored: ["**/packages/desktop/out/**", "**/.e2e-artifacts/**"] },
    },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : { channel: "chrome" },
  );
});
after(async () => {
  await browser?.close();
  await server?.close();
});

const LABELS = {
  "zh-CN": "由组织管理",
  "en-US": "Managed by your organization",
  "ja-JP": "組織により管理されています",
  "ko-KR": "조직에서 관리함",
  "ru-RU": "Управляется организацией",
};
const MODES = ["plan", "build", "guarded", "yolo"];
const item = (page, mode) => page.getByTestId(`chat-mode-select-item-${mode}`);
const menu = (page) => page.locator('[data-slot="dropdown-menu-content"]');
const dialog = (page) => page.getByTestId("yolo-confirmation-dialog");
const state = async (page) => JSON.parse(await page.getByTestId("state").textContent());

async function openPage(url, width = 1200, waitFor = "chat-mode-select-trigger") {
  const page = await browser.newPage({ viewport: { width, height: 800 }, hasTouch: width < 600 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.getByTestId(waitFor).waitFor();
  return { page, errors };
}
async function openMenu(page) {
  await page.getByTestId("chat-mode-select-trigger").click();
  await item(page, "yolo").waitFor();
}
async function closeMenu(page) {
  await page.keyboard.press("Escape");
  await item(page, "yolo").waitFor({ state: "hidden" });
}
async function choose(page, mode) {
  if (!(await item(page, "yolo").isVisible())) await openMenu(page);
  await item(page, mode).click();
  await item(page, "yolo").waitFor({ state: "hidden" });
}
/** 禁用的项收不到指针事件，按坐标模拟一次真实的鼠标点击。 */
async function rawClick(page, target) {
  const box = await target.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(150);
}
async function run(page, name, errors, body) {
  try {
    await body();
    assert.deepEqual(errors, [], "页面不该有未捕获的异常");
  } catch (error) {
    await page.screenshot({ path: join(artifacts, `failure-${name}.png`) });
    throw new Error(`${page.url()}: ${String(error)}`, { cause: error });
  } finally {
    await page.close();
  }
}

test("不受限：四个候选都能选，菜单里没有“由组织管理”", async () => {
  const { page, errors } = await openPage(`${origin}fixture?`);
  await run(page, "unrestricted", errors, async () => {
    await openMenu(page);
    for (const mode of MODES) {
      assert.equal(await item(page, mode).getAttribute("aria-disabled"), null, `${mode} 不该被禁`);
      assert.equal(await item(page, mode).getAttribute("data-policy-locked"), null);
    }
    assert.equal((await menu(page).innerText()).includes(LABELS["zh-CN"]), false);
    await choose(page, "plan");
    assert.equal((await state(page)).planEnabled, true);
    await choose(page, "yolo");
    await dialog(page).waitFor();
    await dialog(page).getByRole("checkbox").check();
    await page.getByTestId("yolo-confirmation-confirm").click();
    assert.equal((await state(page)).mode, "yolo");
  });
});

test("只允许 build 与 plan：另外两项置灰并标注，鼠标点不动，也不弹确认框", async () => {
  const { page, errors } = await openPage(`${origin}fixture?allowed=build,plan`);
  await run(page, "build-plan", errors, async () => {
    await openMenu(page);
    for (const mode of ["guarded", "yolo"]) {
      const disabled = item(page, mode);
      assert.equal(await disabled.getAttribute("aria-disabled"), "true", `${mode} 应当被禁`);
      assert.equal(await disabled.getAttribute("data-policy-locked"), "true");
      assert.ok(
        (await disabled.innerText()).includes(LABELS["zh-CN"]),
        `${mode} 应当写着“由组织管理”`,
      );
      await rawClick(page, disabled);
    }
    // 被禁的项原本是什么就还是什么：没有草稿提交，没有风险确认框，菜单仍然开着。
    assert.deepEqual(await state(page), { mode: "build", planEnabled: false, commits: 0 });
    assert.equal(await dialog(page).count(), 0);
    assert.equal(await item(page, "yolo").isVisible(), true);
    await closeMenu(page);
    // 允许的候选照常可选。
    await choose(page, "plan");
    assert.equal((await state(page)).planEnabled, true);
    assert.equal((await state(page)).mode, "build");
    assert.equal((await state(page)).commits, 1);
  });
});

test("Plan 被禁：勾选项置灰并标注，点不动", async () => {
  const { page, errors } = await openPage(`${origin}fixture?allowed=build,guarded&plan=on`);
  await run(page, "plan-disabled", errors, async () => {
    await openMenu(page);
    const plan = item(page, "plan");
    assert.equal(await plan.getAttribute("aria-disabled"), "true");
    assert.equal(await plan.getAttribute("data-policy-locked"), "true");
    assert.ok((await plan.innerText()).includes(LABELS["zh-CN"]));
    await rawClick(page, plan);
    // 草稿里残留的 Plan 不会被点掉：把草稿归正是上层（useManagedModePolicy）的事。
    assert.deepEqual(await state(page), { mode: "build", planEnabled: true, commits: 0 });
    for (const mode of ["build", "guarded"]) assert.equal(await item(page, mode).isEnabled(), true);
  });
});

test("循环快捷键只在允许的权限之间循环", async () => {
  const first = await openPage(`${origin}fixture?allowed=build,guarded`);
  await run(first.page, "cycle-two", first.errors, async () => {
    await openMenu(first.page);
    await closeMenu(first.page);
    for (const expected of ["guarded", "build", "guarded"]) {
      await first.page.keyboard.press("Control+Shift+M");
      await first.page.waitForFunction(
        (value) =>
          JSON.parse(document.querySelector('[data-testid="state"]').textContent).mode === value,
        expected,
      );
    }
  });
  const second = await openPage(`${origin}fixture?allowed=build,plan`);
  await run(second.page, "cycle-one", second.errors, async () => {
    await openMenu(second.page);
    await closeMenu(second.page);
    for (let attempt = 0; attempt < 2; attempt++) {
      await second.page.keyboard.press("Control+Shift+M");
      await second.page.waitForTimeout(200);
    }
    assert.equal((await state(second.page)).mode, "build", "只有一种权限可选时不切到被禁的模式");
    assert.equal(await dialog(second.page).count(), 0);
  });
});

test("面板块：得知策略后归正草稿里被禁的模式，并拦住对被禁模式的切换", async () => {
  const { page, errors } = await openPage(
    `${origin}fixture?surface=policy&mode=yolo&plan=on`,
    1200,
    "state",
  );
  const publish = (sessionId, mode, allowed) =>
    page.evaluate(
      ([owner, sessionMode, modes]) => window.publishPolicy(owner, sessionMode, modes),
      [sessionId, mode, allowed],
    );
  const request = (mode) => page.evaluate((value) => window.requestSwitch(value), mode);
  const waitDraft = (expected) =>
    page.waitForFunction(
      (wanted) =>
        Object.entries(wanted).every(
          ([key, value]) =>
            JSON.parse(document.querySelector('[data-testid="state"]').textContent)[key] === value,
        ),
      expected,
    );
  await run(page, "policy-hook", errors, async () => {
    // 还不知道策略：草稿一个字都不动。
    assert.deepEqual(await state(page), { mode: "yolo", planEnabled: true });
    // 不受限的快照（没有 managedAllowedModes）：不归正，切换照常放行，与改动前相同。
    await publish("sess_1", "build");
    await page.waitForTimeout(100);
    assert.deepEqual(await state(page), { mode: "yolo", planEnabled: true });
    for (const mode of ["guarded", "yolo"]) {
      await request(mode);
      await waitDraft({ mode });
    }
    // 策略只允许 build 与 plan：草稿里的 yolo 归正成会话当前的模式，Plan 不动。
    await publish("sess_1", "build", ["build", "plan"]);
    await waitDraft({ mode: "build", planEnabled: true });
    // 被禁的切换被放弃，允许的照常；plan-off 永远允许。
    for (const mode of ["yolo", "guarded", "edit"]) await request(mode);
    await page.waitForTimeout(150);
    assert.deepEqual(await state(page), { mode: "build", planEnabled: true });
    await request("plan-off");
    await waitDraft({ planEnabled: false });
    await request("plan");
    await waitDraft({ planEnabled: true });
    // Plan 被禁：开着的 Plan 会被关掉。
    await publish("sess_1", "build", ["build", "guarded"]);
    await waitDraft({ planEnabled: false });
    // 策略不允许 build：草稿里的 build 归正成会话当前的 guarded，而不是硬写 build。
    await publish("sess_1", "guarded", ["guarded"]);
    await waitDraft({ mode: "guarded" });
    // 别的会话的快照不说明这份草稿受什么限制：不据此改动草稿。
    await publish("sess_other", "build", ["build"]);
    await page.waitForTimeout(150);
    assert.deepEqual(await state(page), { mode: "guarded", planEnabled: false });
  });
});

for (const width of [390, 1200])
  for (const theme of ["light", "dark"]) {
    test(`标注在 ${width}/${theme} 下五种语言都可见且不溢出`, async () => {
      for (const [locale, label] of Object.entries(LABELS)) {
        const { page, errors } = await openPage(
          `${origin}fixture?theme=${theme}&locale=${locale}&allowed=build,plan`,
          width,
        );
        await run(page, `${width}-${theme}-${locale}`, errors, async () => {
          await openMenu(page);
          const overflow = await page.evaluate((names) => {
            const elements = names.map((name) =>
              document.querySelector(`[data-testid="chat-mode-select-item-${name}"]`),
            );
            const content = document.querySelector('[data-slot="dropdown-menu-content"]');
            if (elements.some((element) => !element) || !content) return "菜单不完整";
            const wide = elements.filter((element) => element.scrollWidth > element.clientWidth + 1);
            if (wide.length > 0 || content.scrollWidth > content.clientWidth + 1) return "横向溢出";
            return null;
          }, MODES);
          assert.equal(overflow, null, `${locale} 的菜单不该溢出`);
          for (const mode of ["guarded", "yolo"]) {
            const marker = item(page, mode).getByText(label, { exact: true });
            assert.ok(await marker.isVisible(), `${locale}：被禁的 ${mode} 应当写着标注`);
            const [markerBox, menuBox] = await Promise.all([marker.boundingBox(), menu(page).boundingBox()]);
            assert.ok(
              markerBox.x >= menuBox.x - 1 && markerBox.x + markerBox.width <= menuBox.x + menuBox.width + 1,
              `${locale}：标注不该伸出菜单`,
            );
          }
          const colors = await page.evaluate(() => {
            const read = (id) =>
              getComputedStyle(
                document.querySelector(`[data-testid="chat-mode-select-item-${id}"] span span`),
              ).color;
            return { disabled: read("yolo"), enabled: read("build") };
          });
          assert.notEqual(
            colors.disabled,
            colors.enabled,
            `${theme} 主题下置灰项的文字应当弱于可用项`,
          );
          if (width === 1200 && ["zh-CN", "en-US", "ru-RU"].includes(locale))
            await page.screenshot({
              path: join(artifacts, `menu-${width}-${theme}-${locale}.png`),
            });
        });
      }
    });
  }
