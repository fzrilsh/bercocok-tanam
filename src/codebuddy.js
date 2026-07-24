const { getConfig } = require("./config");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const {
    sleep,
    removeAccount,
    appendErrorAccount,
    chunkAccounts,
    createFileLogger,
    formatDuration,
    acquireAccountLock,
    releaseAccountLock,
    tryAcquireAccountLock,
    acquireProxy,
    releaseProxy,
} = require("./utils");
const { launchBrowser, setupConditionalProxyInterception } = require("./browser");
const { clickSelector } = require("./google-login");
const { STEPS, createProgressManager } = require("./progress");
const { printReport } = require("./reporter");
const { waitForGitHubDeviceOTP } = require("./temp-email-helper");
const { createRouter } = require("./9router-helper");

const QUEUE_RETRY_DELAY_MS = 500;
const ROOT_DIR = path.resolve(__dirname, "..");
const GITHUB_KEYS_FILE = path.join(ROOT_DIR, "github_keys.txt");

/** Parse hostname safely — never match query params (e.g. redirect_uri=codebuddy.ai) */
function getHostname(url) {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch (_) {
        return "";
    }
}

function isGitHubHost(url) {
    const h = getHostname(url);
    return h === "github.com" || h.endsWith(".github.com");
}

function isCodebuddyHost(url) {
    const h = getHostname(url);
    return h === "codebuddy.ai" || h.endsWith(".codebuddy.ai") || h.includes("codebuddy");
}

function isGoogleHost(url) {
    const h = getHostname(url);
    return h.includes("google.com") || h.includes("googleusercontent.com");
}

function readCodebuddyAccounts() {
    const config = getConfig();
    const candidates = [GITHUB_KEYS_FILE, config.accountFile];
    const accounts = [];
    const seen = new Set();

    for (const filePath of candidates) {
        if (!fs.existsSync(filePath)) continue;

        const lines = fs
            .readFileSync(filePath, "utf-8")
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith("#"));

        for (const rawLine of lines) {
            let email;
            let password;
            let username;
            let proxy;

            if (rawLine.includes("|")) {
                const parts = rawLine.split("|").map((p) => p.trim());
                email = parts[0];
                password = parts[1];
                username = parts[2] || (email ? email.split("@")[0] : "");
                proxy = parts[3] || null;
            } else if (rawLine.includes(":")) {
                const parts = rawLine.split(":");
                email = parts[0]?.trim();
                password = parts[1]?.trim();
                username = parts[2]?.trim() || (email ? email.split("@")[0] : "");
                proxy = parts[3]?.trim() || null;
            } else {
                continue;
            }

            if (!email || !password || seen.has(email)) continue;
            seen.add(email);

            accounts.push({
                email,
                password,
                username,
                proxy: proxy || null,
                rawLine,
                sourceFile: filePath,
            });
        }
    }

    return accounts;
}

function removeCodebuddyAccount(account) {
    const filePath = account.sourceFile || GITHUB_KEYS_FILE;
    if (!fs.existsSync(filePath)) {
        removeAccount(account.rawLine);
        return;
    }

    const remaining = fs
        .readFileSync(filePath, "utf-8")
        .split(/\r?\n/)
        .filter((line) => line.trim() !== account.rawLine.trim());

    fs.writeFileSync(filePath, remaining.join("\n"));
}

async function getCodebuddyDeviceCode(log) {
    const { ok, router, error } = await createRouter("codebuddy-int", log);
    if (!ok) throw new Error(`Router ${error}`);

    log("[API] Requesting device code from router...");
    const data = await router.deviceCode();
    log(`[API] Device code received: ${data.device_code}`);
    return { ...data, _router: router };
}

async function pollCodebuddyCompletion(router, deviceCode, codeVerifier, log) {
    const startTime = Date.now();
    const timeout = 120000;
    const pollInterval = 500;

    log(`[API] Starting polling for device code: ${deviceCode}`);

    while (Date.now() - startTime < timeout) {
        const res = await router.poll(deviceCode, codeVerifier);
        if (res.success) {
            log(`[API] Polling successful!`);
            return res.data;
        }

        if (!res.pending) {
            log(`[API] Polling error: ${res.error}`);
        }

        await sleep(pollInterval);
    }

    throw new Error("Polling timeout after 120 seconds");
}

async function clickInFrames(page, selectors, timeout = 15000, delayBeforeClick = 2000, log = () => {}) {
    const startTime = Date.now();
    const list = Array.isArray(selectors) ? selectors : [selectors];

    while (Date.now() - startTime < timeout) {
        // Prefer auth iframe first (same as Python)
        const ordered = [
            ...page.frames().filter((f) => f.name() === "auth"),
            ...page.frames().filter((f) => f.name() !== "auth"),
        ];

        for (const frame of ordered) {
            for (const selector of list) {
                try {
                    // CSS only for waitForSelector (no ::-p-text in frames)
                    if (selector.includes("::-p-text") || selector.includes(":contains")) continue;

                    const element = await frame.waitForSelector(selector, {
                        visible: true,
                        timeout: 800,
                    });
                    if (!element) continue;

                    await sleep(delayBeforeClick);
                    // JS click more reliable inside iframe
                    await frame.evaluate((el) => el.click(), element);
                    return {
                        clicked: true,
                        frameName: frame.name() || "unnamed",
                        selector,
                    };
                } catch (_) {}
            }
        }

        // Text-based fallback across frames
        for (const frame of ordered) {
            try {
                const clicked = await frame.evaluate((needles) => {
                    const els = Array.from(
                        document.querySelectorAll("a, button, input[type='submit'], div[role='button']"),
                    );
                    for (const el of els) {
                        const text = (el.textContent || el.value || "").trim().toLowerCase();
                        const href = (el.getAttribute && el.getAttribute("href")) || "";
                        for (const n of needles) {
                            if (text.includes(n) || href.includes(n)) {
                                el.click();
                                return n;
                            }
                        }
                    }
                    return null;
                }, list.map((s) => {
                    // extract plain text hints from selector names
                    if (s.includes("github")) return "github";
                    if (s.toLowerCase().includes("confirm")) return "confirm";
                    if (s.toLowerCase().includes("continue")) return "continue";
                    return null;
                }).filter(Boolean));

                if (clicked) {
                    await sleep(delayBeforeClick);
                    return {
                        clicked: true,
                        frameName: frame.name() || "unnamed",
                        selector: `text:${clicked}`,
                    };
                }
            } catch (_) {}
        }

        await sleep(400);
    }

    throw new Error(`Selectors not found in any frame after ${timeout}ms: ${list.join(", ")}`);
}

async function prepareAuthIframe(page, log) {
    const frames = page.frames();
    const authFrame =
        frames.find((f) => f.name() === "auth") ||
        frames.find((f) => f !== page.mainFrame());
    if (!authFrame) {
        log("No auth iframe found for prep");
        return;
    }

    log(`Preparing auth iframe: ${authFrame.name() || "unnamed"}`);

    // 1) Click "Sign up" tab if present (reveals SSO buttons)
    try {
        const tabClicked = await authFrame.evaluate(() => {
            const candidates = Array.from(document.querySelectorAll("a, button, div, span"));
            const tab = candidates.find((el) => {
                const t = (el.textContent || "").trim().toLowerCase();
                const href = el.getAttribute && (el.getAttribute("href") || "");
                return (
                    t === "sign up" ||
                    t === "signup" ||
                    href.includes("#signup") ||
                    href.includes("signup")
                );
            });
            if (tab) {
                tab.click();
                return true;
            }
            return false;
        });
        if (tabClicked) {
            log("Clicked Sign up tab in iframe");
            await sleep(1000);
        }
    } catch (err) {
        log(`Sign up tab: ${err.message}`);
    }

    // 2) Check ToS checkboxes (SSO policy)
    try {
        const tosIds = ["agree-policy-sso", "agree-policy", "agree-policy-account"];
        for (const id of tosIds) {
            try {
                const checkbox = await authFrame.$(`#${id}`);
                if (!checkbox) continue;

                const isChecked = await authFrame.evaluate((el) => el.checked, checkbox);
                if (!isChecked) {
                    await authFrame.evaluate((el) => el.click(), checkbox);
                    log(`Checked ToS: #${id}`);
                    await sleep(800);
                    break;
                } else {
                    log(`ToS already checked: #${id}`);
                    break;
                }
            } catch (_) {}
        }
    } catch (err) {
        log(`ToS prep error: ${err.message}`);
    }
}

async function handleConfirmButton(page, log) {
    log("Waiting for Confirm button in Codebuddy iframe...");

    // Already navigated to GitHub host? skip confirm
    try {
        if (isGitHubHost(page.url())) {
            log("Already on GitHub host, skip Confirm");
            return false;
        }
    } catch (_) {}

    const start = Date.now();
    const timeout = 12000;

    while (Date.now() - start < timeout) {
        // Only search Codebuddy/auth frames — never GitHub frames
        const frames = page.frames().filter((f) => {
            try {
                const u = f.url() || "";
                if (u.includes("github.com") || u.includes("google.com")) return false;
                return (
                    f.name() === "auth" ||
                    u.includes("codebuddy") ||
                    u.includes("broker") ||
                    u === "" ||
                    u === "about:blank" ||
                    f !== page.mainFrame()
                );
            } catch (_) {
                return f.name() === "auth";
            }
        });

        // Prefer auth iframe first
        const ordered = [
            ...frames.filter((f) => f.name() === "auth"),
            ...frames.filter((f) => f.name() !== "auth"),
        ];

        for (const frame of ordered) {
            try {
                const clicked = await frame.evaluate(() => {
                    const buttons = Array.from(
                        document.querySelectorAll("button, input[type='submit'], a.ui-button"),
                    );
                    // ONLY exact "Confirm" — never "Continue" (matches Continue with Google on GitHub)
                    const btn = buttons.find((el) => {
                        const text = (el.textContent || el.value || "").trim().toLowerCase();
                        const type = el.getAttribute("data-type") || "";
                        if (text.includes("google") || text.includes("apple") || text.includes("github")) {
                            return false;
                        }
                        return text === "confirm" || (type === "success" && text.length < 20);
                    });
                    if (btn) {
                        btn.click();
                        return (btn.textContent || btn.value || "confirm").trim();
                    }
                    return null;
                });

                if (clicked) {
                    log(`Clicked Confirm in frame '${frame.name() || "unnamed"}': ${clicked}`);
                    await sleep(2000);
                    return true;
                }
            } catch (_) {}
        }

        // If main page already on github host, stop looking for confirm
        try {
            if (isGitHubHost(page.url())) {
                log("Navigated to GitHub host during Confirm wait, skip");
                return false;
            }
        } catch (_) {}

        await sleep(400);
    }

    log("No Confirm button found, continuing...");
    return false;
}

async function waitForGitHubPage(browser, currentPage, log, timeout = 45000) {
    const start = Date.now();

    while (Date.now() - start < timeout) {
        const pages = await browser.pages();

        // Prefer newest page with github.com
        for (let i = pages.length - 1; i >= 0; i--) {
            const p = pages[i];
            try {
                const url = p.url();
                if (url.includes("github.com")) {
                    if (p !== currentPage) {
                        log(`Switched to GitHub page/popup: ${url}`);
                    } else {
                        log(`GitHub opened in same tab: ${url}`);
                    }
                    return p;
                }
            } catch (_) {}
        }

        // Same tab navigated?
        try {
            const url = currentPage.url();
            if (url.includes("github.com")) {
                log(`GitHub URL on current page: ${url}`);
                return currentPage;
            }
        } catch (_) {}

        await sleep(500);
    }

    throw new Error("GitHub page not opened after Codebuddy GitHub/Confirm click");
}

async function handleCodebuddyGitHubButton(page, log) {
    const config = getConfig();
    const browser = page.browser();

    log("Waiting for Codebuddy login page...");
    await page.waitForFunction(() => window.location.href.includes("codebuddy.ai/login"), {
        timeout: config.timeouts.navigation,
    });
    log(`Login page loaded: ${page.url()}`);

    try {
        await page.waitForNetworkIdle({ timeout: 10000 });
        log("Network idle");
    } catch (_) {
        log("Network idle timeout, continuing...");
    }

    try {
        await page.waitForFunction(
            () => {
                const loading = document.querySelector(".auth-loading");
                return !loading || loading.style.display === "none" || !loading.offsetParent;
            },
            { timeout: 10000 },
        );
        log("Loading overlay gone");
    } catch (_) {
        log("Loading overlay still present, continuing...");
    }

    log("Waiting 4s for iframe interactive...");
    await sleep(4000);

    // iframe prep: Sign up tab + ToS (same as Python)
    await prepareAuthIframe(page, log);

    // Click GitHub SSO button in iframe
    log("Searching Sign up/login with GitHub button...");
    const githubSelectors = [
        "a#social-github",
        'a[href*="github/login"]',
        'a[href*="broker/github"]',
        'a.sp-button[href*="github"]',
        'a[href*="github"]',
    ];

    let githubClicked = false;
    try {
        const result = await clickInFrames(page, githubSelectors, 15000, 2000, log);
        log(`Clicked GitHub button in frame '${result.frameName}' (${result.selector})`);
        githubClicked = true;
    } catch (err) {
        // text fallback
        for (const frame of page.frames()) {
            try {
                const ok = await frame.evaluate(() => {
                    const els = Array.from(document.querySelectorAll("a, button"));
                    const el = els.find((e) => {
                        const t = (e.textContent || "").toLowerCase();
                        const h = e.getAttribute("href") || "";
                        return h.includes("github") || t.includes("github");
                    });
                    if (el) {
                        el.click();
                        return true;
                    }
                    return false;
                });
                if (ok) {
                    log(`Clicked GitHub via text in frame '${frame.name() || "unnamed"}'`);
                    githubClicked = true;
                    break;
                }
            } catch (_) {}
        }
    }

    if (!githubClicked) {
        throw new Error("GitHub signup button not found in any iframe");
    }

    // Confirm dialog in iframe after GitHub click
    await sleep(2000);
    await handleConfirmButton(page, log);

    // Wait for GitHub login/authorize (same tab or popup)
    log("Waiting for GitHub page after Confirm...");
    const githubPage = await waitForGitHubPage(browser, page, log, 45000);
    return githubPage;
}

async function handleGitHubLogin(page, account, log) {
    const config = getConfig();

    log("Waiting for GitHub login/authorize page...");
    await page.waitForFunction(
        () => {
            try {
                const h = window.location.hostname.toLowerCase();
                return (
                    h === "github.com" ||
                    h.endsWith(".github.com") ||
                    h.includes("codebuddy")
                );
            } catch (_) {
                return false;
            }
        },
        { timeout: config.timeouts.navigation },
    );

    let currentUrl = page.url();
    log(`GitHub page: ${currentUrl}`);
    log(`Hostname: ${getHostname(currentUrl)}`);

    // Use HOSTNAME only — query string often contains codebuddy.ai in redirect_uri
    if (isCodebuddyHost(currentUrl)) {
        log("Already authorized, back on Codebuddy host");
        return;
    }

    if (isGitHubHost(currentUrl) && currentUrl.includes("/login/oauth/authorize")) {
        log("Already logged in, on authorize page");
        return;
    }

    if (!isGitHubHost(currentUrl)) {
        throw new Error(`Expected GitHub host, got: ${getHostname(currentUrl)} (${currentUrl})`);
    }

    await sleep(2000);
    currentUrl = page.url();
    log(`GitHub login form page: ${currentUrl}`);

    // Must fill email/password — never Google
    log(`Filling GitHub username/email: ${account.email}`);
    let loginInput;
    try {
        loginInput = await page.waitForSelector("input#login_field", {
            timeout: config.timeouts.default,
            visible: true,
        });
    } catch (err) {
        throw new Error(
            `GitHub login form not found (#login_field). URL: ${page.url()}. Hostname: ${getHostname(page.url())}`,
        );
    }

    await page.evaluate((el) => {
        el.focus();
        el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
    }, loginInput);
    await loginInput.type(account.email, { delay: 30 });
    await sleep(600);

    log("Filling GitHub password...");
    const passwordInput = await page.waitForSelector("input#password", {
        timeout: config.timeouts.default,
        visible: true,
    });
    await page.evaluate((el) => {
        el.focus();
        el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
    }, passwordInput);
    await passwordInput.type(account.password, { delay: 30 });
    await sleep(800);

    log("Clicking GitHub Sign in (password form only)...");
    const signedIn = await page.evaluate(() => {
        const byValue = document.querySelector('input[type="submit"][value="Sign in"]');
        if (byValue) {
            byValue.click();
            return "input[value=Sign in]";
        }
        const byName = document.querySelector('input[name="commit"][type="submit"]');
        if (byName) {
            byName.click();
            return "input[name=commit]";
        }
        const form = document.querySelector("form");
        if (form && form.querySelector("#login_field")) {
            form.submit();
            return "form.submit";
        }
        return null;
    });

    if (!signedIn) {
        throw new Error("GitHub Sign in button not found on password form");
    }
    log(`Submitted via: ${signedIn}`);

    await sleep(5000);
    currentUrl = page.url();
    log(`URL after login: ${currentUrl}`);

    if (isGoogleHost(currentUrl)) {
        throw new Error("Landed on Google OAuth — should use GitHub email/password only");
    }

    if (isGitHubHost(currentUrl) && currentUrl.includes("/login")) {
        try {
            const errText = await page.evaluate(() => {
                const els = document.querySelectorAll(".flash-error, .error, [role='alert']");
                return Array.from(els)
                    .map((e) => (e.textContent || "").trim())
                    .filter(Boolean)
                    .join(" | ");
            });
            if (errText) log(`GitHub login error UI: ${errText}`);
        } catch (_) {}
    }

    await handleDeviceVerificationIfNeeded(page, account, log);
}

async function handleDeviceVerificationIfNeeded(page, account, log) {
    const currentUrl = page.url();

    let needsOtp = currentUrl.includes("/sessions/verified-device");
    if (!needsOtp) {
        try {
            const otpInput = await page.$("input#otp");
            if (otpInput) {
                const visible = await page.evaluate(
                    (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
                    otpInput,
                );
                needsOtp = visible;
            }
        } catch (_) {}
    }

    if (!needsOtp) {
        log("No device verification required");
        return;
    }

    log("GitHub device verification detected");
    try {
        const otpCode = await waitForGitHubDeviceOTP(account.email, 15, log);
        log(`Entering device OTP: ${otpCode}`);

        const otpInput = await page.waitForSelector("input#otp", {
            timeout: 10000,
            visible: true,
        });
        await otpInput.click({ clickCount: 3 });
        await page.keyboard.type(otpCode, { delay: 50 });
        await sleep(5000);
    } catch (err) {
        log(`Device OTP error: ${err.message}`);
        log("Waiting 60s for manual OTP entry...");
        await sleep(60000);
    }
}

async function handleGitHubAuthorize(page, log) {
    const config = getConfig();

    log("Waiting for GitHub authorization page...");

    try {
        await page.waitForFunction(
            () => {
                try {
                    const h = window.location.hostname.toLowerCase();
                    const p = window.location.pathname || "";
                    // On codebuddy host = already done
                    if (h.includes("codebuddy")) return true;
                    // On github authorize path
                    return h.includes("github.com") && p.includes("/login/oauth/authorize");
                } catch (_) {
                    return false;
                }
            },
            { timeout: 30000 },
        );
    } catch (_) {
        const url = page.url();
        if (isCodebuddyHost(url)) {
            log("Already authorized, redirected to Codebuddy host");
            return;
        }
        throw new Error(`Expected authorize page, got host=${getHostname(url)} url=${url}`);
    }

    // If already on Codebuddy host, skip authorize
    if (isCodebuddyHost(page.url())) {
        log("Already on Codebuddy after login, skip authorize");
        return;
    }

    log(`Authorization page: ${page.url()}`);
    await sleep(2000);

    const authorizeBtn = await page.waitForSelector('button[name="authorize"][value="1"]', {
        timeout: config.timeouts.default,
        visible: true,
    });

    await page.evaluate((el) => {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.focus();
    }, authorizeBtn);
    await sleep(1000);

    log("Waiting for authorize button to be enabled...");
    try {
        await page.waitForFunction(
            (el) => !el.disabled && !el.getAttribute("disabled"),
            { timeout: 60000 },
            authorizeBtn,
        );
        log("Authorize button enabled");
    } catch (_) {
        log("Authorize button still disabled after 60s, trying click anyway");
    }

    try {
        await authorizeBtn.click();
        log("Clicked Authorize");
    } catch (_) {
        await page.evaluate((el) => el.click(), authorizeBtn);
        log("Clicked Authorize (JS)");
    }

    await sleep(3000);
}

async function handleRegionSelectionAndWaitForSuccess(page, log) {
    const config = getConfig();

    log("Waiting for redirect after GitHub OAuth...");
    await sleep(3000);

    let currentUrl = page.url();
    log(`Current URL: ${currentUrl}`);
    log(`Hostname: ${getHostname(currentUrl)}`);

    // Check for domain restriction (first-broker-login page)
    if (currentUrl.includes("/login-actions/first-broker-login")) {
        log("Domain restriction detected - GitHub domain is blocked by Codebuddy");
        throw new Error("Domain restricted: GitHub email domain is not allowed on Codebuddy");
    }

    if (isGitHubHost(currentUrl)) {
        log("Still on GitHub host, waiting redirect to codebuddy host...");
        await page.waitForFunction(
            () => {
                try {
                    const h = window.location.hostname.toLowerCase();
                    return h.includes("codebuddy");
                } catch (_) {
                    return false;
                }
            },
            { timeout: 30000 },
        );
        currentUrl = page.url();
        log(`Redirected to: ${currentUrl}`);
        
        // Check again after redirect
        if (currentUrl.includes("/login-actions/first-broker-login")) {
            log("Domain restriction detected after redirect");
            throw new Error("Domain restricted: GitHub email domain is not allowed on Codebuddy");
        }
    }

    const isIntermediatePage = (url) => {
        // first-broker-login is domain restriction, not intermediate
        if (url.includes("/login-actions/first-broker-login")) {
            return false;
        }
        return url.includes("/login/select") || url.includes("/login-actions/");
    };

    if (isIntermediatePage(currentUrl)) {
        log("On intermediate page, waiting final redirect...");
        await page.waitForFunction(
            () => {
                const url = window.location.href;
                const intermediate =
                    url.includes("/login/select") ||
                    url.includes("/login-actions/first-broker-login") ||
                    url.includes("/login-actions/first-broker-lo");
                return (
                    !intermediate &&
                    (url.includes("/register/user/complete") || url.includes("/started"))
                );
            },
            { timeout: config.timeouts.navigation },
        );
        currentUrl = page.url();
        log(`Redirected to: ${currentUrl}`);
    }

    if (currentUrl.includes("/started")) {
        log("On /started, checking region redirect...");
        const start = Date.now();
        while (Date.now() - start < 10000) {
            await sleep(1000);
            currentUrl = page.url();
            if (currentUrl.includes("/register/user/complete")) {
                log("Redirected to region selection");
                break;
            }
            if (!currentUrl.includes("/started")) break;
        }
        currentUrl = page.url();
        log(`After wait URL: ${currentUrl}`);
    }

    if (currentUrl.includes("/register/user/complete")) {
        log("Region selection page, selecting Singapore...");

        try {
            await page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
            await sleep(2000);

            log("Clicking region input...");
            await clickSelector(
                page,
                'input.t-input__inner[placeholder="Registration location"], input[placeholder="Registration location"]',
                { timeout: config.timeouts.default },
            );
            await sleep(1500);

            log("Selecting Singapore...");
            try {
                await clickSelector(
                    page,
                    "li::-p-text(Singapore), div::-p-text(Singapore), span::-p-text(Singapore)",
                    { timeout: config.timeouts.short },
                );
                log("Selected Singapore");
            } catch (_) {
                log("Could not find Singapore option");
            }

            await sleep(1000);

            log("Looking for submit button...");
            try {
                await clickSelector(
                    page,
                    'button[type="submit"], button::-p-text(Submit), button::-p-text(Continue), button::-p-text(Next), div::-p-text(Submit), div.cursor-pointer::-p-text(Submit)',
                    {
                        timeout: config.timeouts.short,
                        delayBeforeClick: 1000,
                    },
                );
                log("Clicked submit");
            } catch (_) {
                log("No submit button, may auto-submit");
            }

            log("Waiting redirect to /started...");
            await page.waitForFunction(
                () => {
                    const url = window.location.href;
                    const intermediate =
                        url.includes("/login/select") ||
                        url.includes("/login-actions/first-broker-login") ||
                        url.includes("/login-actions/first-broker-lo");
                    return !intermediate && url.includes("codebuddy.ai/started");
                },
                { timeout: config.timeouts.navigation },
            );
            log("On /started page");
        } catch (err) {
            log(`Region selection error: ${err.message}`);
            currentUrl = page.url();
            if (currentUrl.includes("/started") && !isIntermediatePage(currentUrl)) {
                log("Despite error, on /started, continuing...");
            } else {
                throw err;
            }
        }
    } else if (currentUrl.includes("/started") && !isIntermediatePage(currentUrl)) {
        log("Already on /started, no region selection needed");
    } else {
        throw new Error(`Expected /started or /register/user/complete, got: ${currentUrl}`);
    }
}

async function processCodebuddyAccount(
    account,
    browserArgsIndex,
    workerIndex,
    log,
    updateProgress,
    useProxy = true,
) {
    const config = getConfig();
    let poolProxy = null;
    let proxy = account.proxy || null;

    if (!proxy && config.proxyPoolFile && useProxy) {
        poolProxy = await acquireProxy(log, updateProgress);
        proxy = poolProxy;
    }

    updateProgress({ step: STEPS.LAUNCHING, email: account.email });

    log(`Getting device code from router API...`);
    const deviceCodeData = await getCodebuddyDeviceCode(log);
    const { device_code, verification_uri, codeVerifier, _router: router } = deviceCodeData;

    log(`Launching browser for ${account.email}`);
    const { browser, page, proxy: conditionalProxy } = await launchBrowser(
        browserArgsIndex,
        workerIndex,
        proxy,
        { conditionalProxy: true },
    );

    if (conditionalProxy) {
        await setupConditionalProxyInterception(page, conditionalProxy, log);

        browser.on("targetcreated", async (target) => {
            try {
                const newPage = await target.page();
                if (newPage) {
                    await setupConditionalProxyInterception(newPage, conditionalProxy, log);
                }
            } catch (err) {
                log(`[Proxy] Could not setup interception on new target: ${err.message}`);
            }
        });
    }

    try {
        // Start poll early (same as previous working flow)
        const pollingPromise = pollCodebuddyCompletion(
            router,
            device_code,
            codeVerifier,
            log,
        ).catch((err) => {
            log(`[API] Polling failed: ${err.message}`);
            return { success: false, error: err.message };
        });
        log(`[API] Polling started in background`);

        // 1) Open Codebuddy verification URI
        updateProgress({ step: STEPS.NAVIGATING, email: "Open verification URI..." });
        log(`Navigating to verification URI: ${verification_uri}`);
        await page.goto(verification_uri, {
            waitUntil: "networkidle2",
            timeout: config.timeouts.navigation,
        });

        // 2) iframe: Sign up tab + ToS + GitHub button + Confirm
        updateProgress({ step: STEPS.NAVIGATING, email: "Codebuddy GitHub button..." });
        let activePage = await handleCodebuddyGitHubButton(page, log);

        // 3) GitHub login (email/password + device OTP if needed)
        updateProgress({ step: STEPS.WAITING, email: "GitHub login..." });
        await handleGitHubLogin(activePage, account, log);

        // After login, page might navigate; re-resolve active github/codebuddy page
        try {
            const pages = await browser.pages();
            const gh = [...pages].reverse().find((p) => {
                try {
                    const u = p.url();
                    return u.includes("github.com") || u.includes("codebuddy.ai");
                } catch (_) {
                    return false;
                }
            });
            if (gh) activePage = gh;
        } catch (_) {}

        // 4) GitHub authorize app
        updateProgress({ step: STEPS.WAITING, email: "GitHub authorize..." });
        await handleGitHubAuthorize(activePage, log);

        // Re-resolve page after authorize redirect
        try {
            const pages = await browser.pages();
            const cb = [...pages].reverse().find((p) => {
                try {
                    return p.url().includes("codebuddy.ai");
                } catch (_) {
                    return false;
                }
            });
            if (cb) activePage = cb;
            else if (pages.length) activePage = pages[pages.length - 1];
        } catch (_) {}

        // 5) Region selection /started
        updateProgress({ step: STEPS.WAITING, email: "Region / started..." });
        await handleRegionSelectionAndWaitForSuccess(activePage, log);

        // 6) Wait poll success
        updateProgress({ step: STEPS.IMPORTING, email: "Polling OAuth..." });
        log(`Waiting for polling to complete...`);

        const pollResult = await pollingPromise;
        if (!pollResult || pollResult.success !== true) {
            throw new Error(pollResult?.error || "Polling failed");
        }

        removeCodebuddyAccount(account);
        log(`Account OAuth successful! Removed: ${account.email}`);

        await sleep(config.delays.beforeBrowserClose);
    } finally {
        await browser.close();
        log("Browser closed.");
        if (poolProxy) {
            releaseProxy(poolProxy);
            log(`[Proxy] Released: ${poolProxy.split(":")[0]}`);
        }
    }
}

async function runCodebuddyWorker(
    workerAccounts,
    workerId,
    browserArgsIndex,
    workerIndex,
    total,
    progress,
    log,
    useProxy = true,
) {
    const config = getConfig();

    let successCount = 0;
    let failedCount = 0;
    let processedCount = 0;

    const accountStats = [];
    const queue = [...workerAccounts];

    while (queue.length > 0) {
        const account = queue[0];
        let hasLock = false;

        if (queue.length > 1) {
            if (!tryAcquireAccountLock(account.email)) {
                log(`[${workerId}] ${account.email} is locked, moving to back of queue.`);
                queue.push(queue.shift());
                await sleep(QUEUE_RETRY_DELAY_MS);
                continue;
            }
            hasLock = true;
        }

        const updateProgress = (payload) => {
            progress.updateWorker(workerId, {
                ...payload,
                email: account.email,
                success: successCount,
                failed: failedCount,
                current: processedCount,
            });
        };

        const startTime = Date.now();
        let accountSuccess = false;
        let accountError = null;

        try {
            if (!hasLock) {
                await acquireAccountLock(account.email, log, updateProgress);
                hasLock = true;
            }

            queue.shift();

            await processCodebuddyAccount(
                account,
                browserArgsIndex,
                workerIndex,
                log,
                updateProgress,
                useProxy,
            );

            accountSuccess = true;
            successCount += 1;
            processedCount += 1;

            progress.updateWorker(workerId, {
                step: STEPS.DONE,
                email: account.email,
                success: successCount,
                failed: failedCount,
                current: processedCount,
            });
        } catch (error) {
            accountSuccess = false;
            accountError = error.message;
            failedCount += 1;
            processedCount += 1;

            appendErrorAccount(account, error.message, "Codebuddy");
            browserArgsIndex = (browserArgsIndex + 1) % config.browserArgsSets.length;

            log(`[${workerId}] Error: ${error.message}`);

            progress.updateWorker(workerId, {
                step: STEPS.ERROR,
                email: account.email,
                success: successCount,
                failed: failedCount,
                current: processedCount,
            });
        } finally {
            const duration = Date.now() - startTime;

            accountStats.push({
                email: account.email,
                rawLine: account.rawLine,
                success: accountSuccess,
                duration,
                error: accountError,
            });

            if (hasLock) {
                releaseAccountLock(account.email);
            }
        }

        if (queue.length > 0) {
            progress.updateWorker(workerId, { step: STEPS.WAITING });
            await sleep(config.delays.betweenAccounts);
        }
    }

    progress.updateWorker(workerId, {
        step: STEPS.DONE,
        email: "Done",
        success: successCount,
        failed: failedCount,
        current: workerAccounts.length,
    });

    return {
        successCount,
        failedCount,
        accounts: accountStats,
        label: `Codebuddy W${workerIndex + 1}`,
    };
}

async function runCodebuddyAutomation(sharedProgress = null, useProxy = true) {
    const config = getConfig();
    const logger = createFileLogger();
    const accounts = readCodebuddyAccounts();

    if (accounts.length === 0) {
        if (!sharedProgress) {
            console.log("No GitHub accounts found.");
            console.log("Format (github_keys.txt): email:password:username");
            console.log("Or accounts.txt: email|password|username");
        }
        logger.close();
        return null;
    }

    if (!sharedProgress) {
        console.log("");
        console.log("Codebuddy Automation (GitHub OAuth)");
        console.log(`   Accounts: ${accounts.length}`);
        console.log("   Residential proxy recommended.");
        console.log("");
    }

    const startedAt = Date.now();
    const chunks = chunkAccounts(accounts, config.browserCount);

    const progress =
        sharedProgress ||
        createProgressManager(
            `Codebuddy Automation — ${accounts.length} accounts, ${chunks.length} workers`,
        );

    chunks.forEach((chunk, i) => {
        progress.addWorker(`codebuddy-${i}`, chunk.length, `Codebuddy W${i + 1}`);
    });

    const results = await Promise.all(
        chunks.map((chunk, i) => {
            const browserArgsIndex = i % config.browserArgsSets.length;

            return runCodebuddyWorker(
                chunk,
                `codebuddy-${i}`,
                browserArgsIndex,
                i,
                accounts.length,
                progress,
                logger.log,
                useProxy,
            );
        }),
    );

    if (!sharedProgress) {
        progress.stop();
    }

    const successCount = results.reduce((sum, r) => sum + r.successCount, 0);
    const failedCount = results.reduce((sum, r) => sum + r.failedCount, 0);
    const totalDuration = Date.now() - startedAt;

    if (!sharedProgress) {
        printReport("CODEBUDDY AUTOMATION REPORT", results, totalDuration);
        console.log(`Log: ${logger.logFile}`);
        console.log("");
    } else {
        const duration = formatDuration(totalDuration);
        logger.log(
            `Codebuddy finished. Success: ${successCount}, Failed: ${failedCount}, Duration: ${duration}`,
        );
    }

    logger.close();

    return { successCount, failedCount, results };
}

/**
 * Create GitHub accounts one-by-one, immediately run Codebuddy OAuth after each success.
 * Flow: create GitHub → login Codebuddy → next account
 */
async function runCodebuddyCreateAndImport(
    createCount = 1,
    sharedProgress = null,
    useProxy = true,
    tempEmailProvider = null,
) {
    const config = getConfig();
    const logger = createFileLogger();
    const { createGitHubAccountViaPython } = require("./github-signup-python");

    if (createCount <= 0) {
        if (!sharedProgress) console.log("Create count must be > 0");
        logger.close();
        return null;
    }

    if (!sharedProgress) {
        console.log("");
        console.log("Codebuddy Pipeline: Create GitHub → Codebuddy OAuth");
        console.log(`   Count: ${createCount}`);
        console.log("   Each success GitHub account immediately logs into Codebuddy.");
        console.log("");
    }

    const startedAt = Date.now();
    const progress =
        sharedProgress ||
        createProgressManager(
            `Codebuddy Create+Import — ${createCount} accounts`,
        );

    const workerId = "codebuddy-pipeline-0";
    progress.addWorker(workerId, createCount, "Codebuddy Pipeline");

    let successCount = 0;
    let failedCount = 0;
    let processedCount = 0;
    const accountStats = [];

    for (let i = 0; i < createCount; i++) {
        const updateProgress = (payload) => {
            progress.updateWorker(workerId, {
                ...payload,
                success: successCount,
                failed: failedCount,
                current: processedCount,
            });
        };

        const startTime = Date.now();
        let accountEmail = `account-${i + 1}`;
        let accountSuccess = false;
        let accountError = null;
        let rawLine = `failed-${i + 1}`;

        try {
            // Step 1: create GitHub account
            updateProgress({
                step: STEPS.LAUNCHING,
                email: `Creating GitHub ${i + 1}/${createCount}...`,
            });
            logger.log(`[Pipeline] Creating GitHub account ${i + 1}/${createCount}...`);

            const createResult = await createGitHubAccountViaPython(
                i,
                useProxy,
                logger.log,
                updateProgress,
                tempEmailProvider,
            );

            if (!createResult?.success || !createResult.account) {
                throw new Error("GitHub account creation failed");
            }

            const account = {
                email: createResult.account.email,
                password: createResult.account.password,
                username: createResult.account.username,
                proxy: null,
                rawLine: `${createResult.account.email}:${createResult.account.password}:${createResult.account.username}`,
                sourceFile: GITHUB_KEYS_FILE,
            };
            accountEmail = account.email;
            rawLine = account.rawLine;

            logger.log(`[Pipeline] GitHub created: ${account.email} — starting Codebuddy OAuth...`);

            // Step 2: immediately Codebuddy OAuth with this account
            updateProgress({
                step: STEPS.NAVIGATING,
                email: `Codebuddy login: ${account.email}`,
            });

            await processCodebuddyAccount(
                account,
                i % config.browserArgsSets.length,
                0,
                logger.log,
                updateProgress,
                useProxy,
            );

            accountSuccess = true;
            successCount += 1;
            processedCount += 1;

            progress.updateWorker(workerId, {
                step: STEPS.DONE,
                email: account.email,
                success: successCount,
                failed: failedCount,
                current: processedCount,
            });

            logger.log(`[Pipeline] SUCCESS: ${account.email} GitHub + Codebuddy`);
        } catch (error) {
            accountSuccess = false;
            accountError = error.message;
            failedCount += 1;
            processedCount += 1;

            logger.log(`[Pipeline] FAILED: ${accountEmail} — ${error.message}`);

            progress.updateWorker(workerId, {
                step: STEPS.ERROR,
                email: accountEmail,
                success: successCount,
                failed: failedCount,
                current: processedCount,
            });
        } finally {
            accountStats.push({
                email: accountEmail,
                rawLine,
                success: accountSuccess,
                duration: Date.now() - startTime,
                error: accountError,
            });
        }

        if (i < createCount - 1) {
            progress.updateWorker(workerId, { step: STEPS.WAITING });
            await sleep(config.delays.betweenAccounts || 10000);
        }
    }

    progress.updateWorker(workerId, {
        step: STEPS.DONE,
        email: "Done",
        success: successCount,
        failed: failedCount,
        current: createCount,
    });

    if (!sharedProgress) {
        progress.stop();
    }

    const results = [
        {
            successCount,
            failedCount,
            accounts: accountStats,
            label: "Codebuddy Pipeline",
        },
    ];
    const totalDuration = Date.now() - startedAt;

    if (!sharedProgress) {
        printReport("CODEBUDDY CREATE+IMPORT REPORT", results, totalDuration);
        console.log(`Log: ${logger.logFile}`);
        console.log("");
    } else {
        logger.log(
            `Codebuddy pipeline finished. Success: ${successCount}, Failed: ${failedCount}, Duration: ${formatDuration(totalDuration)}`,
        );
    }

    logger.close();
    return { successCount, failedCount, results };
}

module.exports = {
    runCodebuddyAutomation,
    runCodebuddyCreateAndImport,
    processCodebuddyAccount,
};
