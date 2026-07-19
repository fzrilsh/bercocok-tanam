const { getConfig, SHARED_SELECTORS } = require("./config");
const axios = require("axios");
const {
    sleep,
    readAccounts,
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
const {
    completeGoogleLogin,
    clickSelector,
    clickFirstVisibleSelector,
} = require("./google-login");
const { STEPS, createProgressManager } = require("./progress");
const { printReport } = require("./reporter");

const QUEUE_RETRY_DELAY_MS = 500;

async function getCodebuddyDeviceCode(routerUrl, log) {
    const baseUrl = routerUrl.replace(/\/$/, "");
    const url = `${baseUrl}/api/oauth/codebuddy-int/device-code`;
    
    log(`[API] Requesting device code from ${url}`);
    
    try {
        const response = await axios.get(url, {
            headers: {
                'Accept': '*/*',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
            }
        });
        
        log(`[API] Device code received: ${response.data.device_code}`);
        return response.data;
    } catch (error) {
        log(`[API] Error getting device code: ${error.message}`);
        throw new Error(`Failed to get device code: ${error.message}`);
    }
}

async function pollCodebuddyCompletion(routerUrl, deviceCode, codeVerifier, log) {
    const baseUrl = routerUrl.replace(/\/$/, "");
    const url = `${baseUrl}/api/oauth/codebuddy-int/poll`;
    
    const startTime = Date.now();
    const timeout = 120000;
    const pollInterval = 500;
    
    log(`[API] Starting polling for device code: ${deviceCode}`);
    
    while (Date.now() - startTime < timeout) {
        try {
            const response = await axios.post(url, {
                deviceCode: deviceCode,
                codeVerifier: codeVerifier,
                extraData: null
            }, {
                headers: {
                    'Accept': '*/*',
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
                }
            });
            
            if (response.data.success === true) {
                log(`[API] Polling successful! Connection ID: ${response.data.connection.id}`);
                return response.data;
            }
            
            log(`[API] Polling... (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`);
        } catch (error) {
            log(`[API] Polling error: ${error.message}`);
        }
        
        await sleep(pollInterval);
    }
    
    throw new Error('Polling timeout after 120 seconds');
}

async function clickSelectorInAnyFrame(page, selector, timeout = 15000, delayBeforeClick = 2000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
        // First, try the "auth" iframe specifically (most common for Codebuddy))
        const authFrame = page.frames().find(f => f.name() === 'auth');
        if (authFrame) {
            try {
                // Wait for element to be VISIBLE (not just present in DOM)
                const element = await authFrame.waitForSelector(selector, { 
                    visible: true, 
                    timeout: 1000 
                });
                if (element) {
                    await sleep(delayBeforeClick);
                    await element.click();
                    return { clicked: true, frameName: 'auth' };
                }
            } catch (err) {
                // Element not visible in this frame, continue
            }
        }
        
        // Fallback: search all frames
        const frames = page.frames();
        for (const frame of frames) {
            try {
                // Wait for element to be VISIBLE (not just present in DOM)
                const element = await frame.waitForSelector(selector, { 
                    visible: true, 
                    timeout: 1000 
                });
                if (element) {
                    await sleep(delayBeforeClick);
                    await element.click();
                    return { clicked: true, frameName: frame.name() || 'unnamed' };
                }
            } catch (err) {
                // Element not visible in this frame, continue
            }
        }
        
        await sleep(500);
    }
    
    throw new Error(`Selector ${selector} not found (visible) in any frame after ${timeout}ms`);
}

async function handleCodebuddyLogin(codebuddyPage, log) {
    const config = getConfig();

    log("Waiting for Codebuddy login page to load...");
    await codebuddyPage.waitForFunction(
        () => window.location.href.includes("codebuddy.ai/login"),
        { timeout: config.timeouts.navigation },
    );

    const currentUrl = codebuddyPage.url();
    log(`Login page loaded. Current URL: ${currentUrl}`);
    
    // Wait for network to be idle (page fully loaded)
    log("Waiting for network idle...");
    try {
        await codebuddyPage.waitForNetworkIdle({ timeout: 10000 });
        log("Network is idle");
    } catch (err) {
        log("Network idle timeout, continuing...");
    }
    
    // Wait for loading overlay to disappear
    log("Waiting for loading overlay to disappear...");
    try {
        await codebuddyPage.waitForFunction(
            () => {
                const loading = document.querySelector('.auth-loading');
                return !loading || loading.style.display === 'none' || !loading.offsetParent;
            },
            { timeout: 10000 }
        );
        log("Loading overlay disappeared");
    } catch (err) {
        log("Loading overlay still present or timeout, continuing...");
    }
    
    log("Waiting 2 seconds for elements to be fully interactive...");
    await sleep(2000);

    // Debug: check frames and elements
    const debugInfo = await codebuddyPage.evaluate(() => {
        return {
            iframeCount: document.querySelectorAll('iframe').length,
            pageTitle: document.title,
            hasGoogleBtn: !!document.querySelector('a#social-google'),
            googleLinksCount: document.querySelectorAll('a[href*="google"]').length,
            hasLoading: !!document.querySelector('.auth-loading')
        };
    });
    
    log(`Debug info: ${JSON.stringify(debugInfo)}`);

    log("Searching for Sign in with Google button in iframe...");
    
    const selectors = [
        'a#social-google',
        'a[href*="google/login"]',
        'a.sp-button[href*="google"]',
        'a[href*="broker/google"]'
    ];
    
    let result = null;
    for (const selector of selectors) {
        try {
            log(`Searching for selector: ${selector}...`);
            result = await clickSelectorInAnyFrame(codebuddyPage, selector, 5000, 2000);
            log(`Found '${selector}' in frame '${result.frameName}', clicked successfully`);
            break;
        } catch (err) {
            log(`Selector '${selector}' not found, trying next...`);
        }
    }
    
    if (!result) {
        throw new Error('Google login button not found in any frame with any selector');
    }
}

async function handleConfirmButton(codebuddyPage, log) {
    try {
        log("Searching for Confirm button in iframe...");
        
        const selectors = [
            'button.ui-button[data-type="success"]',
            'button:has-text("Confirm")',
            'button[type="submit"]'
        ];
        
        let found = false;
        for (const selector of selectors) {
            try {
                const result = await clickSelectorInAnyFrame(codebuddyPage, selector, 5000, 1000);
                log(`Found and clicked Confirm button in frame '${result.frameName}'`);
                found = true;
                break;
            } catch (err) {
                // Try next selector
            }
        }
        
        if (!found) {
            log("No Confirm button found, continuing...");
        }
    } catch (err) {
        log("No Confirm button found, continuing...");
    }
}

async function handlePostLogin(codebuddyPage, log) {
    const config = getConfig();

    try {
        log("Clicking I Understand...");
        await clickSelector(codebuddyPage, SHARED_SELECTORS.iUnderstand, {
            timeout: config.timeouts.short,
            delayBeforeClick: config.delays.beforeNextClick,
        });
    } catch (_) {
        log("No I Understand button found");
    }

    try {
        log("Clicking Login/Allow/Continue...");

        // Scroll to bottom to ensure button is in viewport for headless mode
        await codebuddyPage.keyboard.press('End');

        await clickFirstVisibleSelector(
            codebuddyPage,
            SHARED_SELECTORS.loginOptions,
            config.timeouts.short,
        );
    } catch (_) {
        log("No Login button found");
    }
}

async function handleRegionSelectionAndWaitForSuccess(codebuddyPage, log) {
    const config = getConfig();

    log("Waiting for redirect after Google login...");
    
    // Wait for page to navigate through intermediate states
    // Flow: /auth/.../first-broker-login → /started (brief) → /login/select → /register/user/complete OR /started (final)
    await sleep(3000);
    
    let currentUrl = codebuddyPage.url();
    log(`Current URL: ${currentUrl}`);
    
    // If on intermediate/transition pages, wait for redirect to final destination
    const isIntermediatePage = (url) => {
        return url.includes("/login/select") || 
               url.includes("/login-actions/first-broker-login") ||
               url.includes("/login-actions/first-broker-lo"); // Truncated version
    };
    
    if (isIntermediatePage(currentUrl)) {
        log("On intermediate/transition page, waiting for redirect to final destination...");
        await codebuddyPage.waitForFunction(
            () => {
                const url = window.location.href;
                const isIntermediatePage = url.includes("/login/select") || 
                                          url.includes("/login-actions/first-broker-login") ||
                                          url.includes("/login-actions/first-broker-lo");
                return !isIntermediatePage && 
                       (url.includes("/register/user/complete") || url.includes("/started"));
            },
            { timeout: config.timeouts.navigation }
        );
        currentUrl = codebuddyPage.url();
        log(`Redirected to: ${currentUrl}`);
    }
    
    // If we're on /started but might redirect to region selection, wait a bit more
    if (currentUrl.includes("/started")) {
        log("On /started page, checking if it redirects to region selection...");
        await sleep(3000);
        currentUrl = codebuddyPage.url();
        log(`After waiting, URL: ${currentUrl}`);
    }

    // Handle region selection if on that page
    if (currentUrl.includes("/register/user/complete")) {
        log("Region selection page detected, selecting Singapore...");
        
        try {
            // Wait for page to be fully loaded
            await codebuddyPage.waitForNetworkIdle({ timeout: 5000 }).catch(() => {
                log("Network idle timeout, continuing...");
            });
            
            await sleep(2000);

            // Click on the region input/dropdown (NOT in iframe, on main page)
            log("Clicking region input...");
            await clickSelector(
                codebuddyPage,
                'input.t-input__inner[placeholder="Registration location"], input[placeholder="Registration location"]',
                {
                    timeout: config.timeouts.default,
                },
            );

            await sleep(1500);

            // Try to select Singapore from dropdown
            log("Selecting Singapore...");
            try {
                await clickSelector(
                    codebuddyPage,
                    'li::-p-text(Singapore), div::-p-text(Singapore), span::-p-text(Singapore)',
                    {
                        timeout: config.timeouts.short,
                    },
                );
                log("Selected Singapore");
            } catch (_) {
                log("Could not find Singapore option in dropdown");
            }

            await sleep(1000);

            // Look for and click submit/continue button (can be button or div element)
            log("Looking for submit button...");
            try {
                await clickSelector(
                    codebuddyPage,
                    'button[type="submit"], button::-p-text(Submit), button::-p-text(Continue), button::-p-text(Next), div::-p-text(Submit), div.cursor-pointer::-p-text(Submit)',
                    {
                        timeout: config.timeouts.short,
                        delayBeforeClick: 1000,
                    },
                );
                log("Clicked submit button");
            } catch (_) {
                log("No submit button found, may auto-submit");
            }

            // Wait for redirect to /started after region selection
            log("Waiting for redirect to /started after region selection...");
            await codebuddyPage.waitForFunction(
                () => {
                    const url = window.location.href;
                    const isIntermediatePage = url.includes("/login/select") || 
                                              url.includes("/login-actions/first-broker-login") ||
                                              url.includes("/login-actions/first-broker-lo");
                    return !isIntermediatePage && url.includes("codebuddy.ai/started");
                },
                { timeout: config.timeouts.navigation }
            );
            log("Redirected to /started page!");
        } catch (err) {
            log(`Region selection error: ${err.message}`);
            // Try to continue anyway - check if we're on /started
            currentUrl = codebuddyPage.url();
            if (currentUrl.includes("/started") && !isIntermediatePage(currentUrl)) {
                log("Despite error, we're on /started page, continuing...");
            } else {
                throw err;
            }
        }
    } else if (currentUrl.includes("/started") && !isIntermediatePage(currentUrl)) {
        log("Already on /started page, no region selection needed");
    } else {
        log(`Unexpected URL: ${currentUrl}`);
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
    const deviceCodeData = await getCodebuddyDeviceCode(config.routerUrl, log);
    const { device_code, verification_uri, codeVerifier } = deviceCodeData;

    log(`Launching browser for ${account.email}`);
    const { browser, page, proxy: conditionalProxy } = await launchBrowser(
        browserArgsIndex,
        workerIndex,
        proxy,
        { conditionalProxy: true }
    );

    if (conditionalProxy) {
        await setupConditionalProxyInterception(page, conditionalProxy, log);
        
        browser.on('targetcreated', async (target) => {
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
        updateProgress({ step: STEPS.NAVIGATING });
        log(`Navigating to verification URI: ${verification_uri}`);
        await page.goto(verification_uri, {
            waitUntil: "networkidle2",
            timeout: config.timeouts.navigation,
        });

        let pollingPromise = null;
        let pollingStarted = false;

        await handleCodebuddyLogin(page, log);
        await handleConfirmButton(page, log);

        updateProgress({ step: STEPS.GOOGLE_LOGIN });
        
        pollingPromise = pollCodebuddyCompletion(
            config.routerUrl,
            device_code,
            codeVerifier,
            log
        );
        pollingStarted = true;
        log(`[API] Polling started in background`);

        await completeGoogleLogin(page, account, log);
        await handlePostLogin(page, log);

        updateProgress({ step: STEPS.WAITING });
        await handleRegionSelectionAndWaitForSuccess(page, log);

        updateProgress({ step: STEPS.IMPORTING });
        log(`Waiting for polling to complete...`);
        
        if (pollingStarted) {
            await pollingPromise;
        } else {
            throw new Error('Polling was not started');
        }

        removeAccount(account.rawLine);
        log(
            `Account OAuth successful! Removed from accounts file: ${account.email}`,
        );

        await sleep(config.delays.beforeBrowserClose);
    } finally {
        await browser.close();
        log("Browser closed.");
        if (poolProxy) {
            releaseProxy(poolProxy);
            log(`[Proxy] Released: ${poolProxy.split(':')[0]}`);
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
                log(
                    `[${workerId}] ${account.email} is locked, moving to back of queue.`,
                );
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
    const accounts = readAccounts();

    if (accounts.length === 0) {
        if (!sharedProgress) { console.log("No accounts found. Format: email|password"); }
        logger.close();

        return null;
    }

    if (!sharedProgress) {
        console.log("");
        console.log("⚠️  IMPORTANT: Codebuddy automation is in BETA testing.");
        console.log("   This automation requires residential proxies to function properly.");
        console.log("   Datacenter proxies will likely result in 'Account Access Restricted' errors.");
        console.log("   Ensure your proxy pool contains residential IPs for best results.");
        console.log("");
    }

    const startedAt = Date.now();
    const chunks = chunkAccounts(accounts, config.browserCount);

    const progress =
        sharedProgress ||
        createProgressManager(
            `🤖 Codebuddy Automation — ${accounts.length} accounts, ${chunks.length} workers`,
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
        printReport("🤖 CODEBUDDY AUTOMATION REPORT", results, totalDuration);
        console.log(`📄 Log: ${logger.logFile}`);
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

module.exports = {
    runCodebuddyAutomation,
};
