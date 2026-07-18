const axios = require("axios");
const { getConfig, SHARED_SELECTORS } = require("./config");
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
    randomUA,
} = require("./utils");
const { launchBrowser } = require("./browser");
const { clickSelector } = require("./google-login");
const { STEPS, createProgressManager } = require("./progress");
const { printReport } = require("./reporter");

const QUEUE_RETRY_DELAY_MS = 500;

async function createTempEmail(log) {
    
    log("Creating temporary email...");
    
    const userAgent = randomUA();
    
    const headers = {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.5',
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
        'referer': 'https://www.google.com/',
        'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Brave";v="150"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-user': '?1',
        'sec-gpc': '1',
        'upgrade-insecure-requests': '1',
        'user-agent': userAgent
    };
    
    const htmlResponse = await axios({
        method: 'GET',
        url: 'https://www.1secemail.com/',
        headers
    });
    
    const html = htmlResponse.data;
    
    const csrfMatch = html.match(/<meta name="csrf-token" content="([^"]+)">/);
    if (!csrfMatch) {
        throw new Error("Failed to extract CSRF token from 1secemail.com");
    }
    
    const csrfToken = csrfMatch[1];
    log(`CSRF token extracted: ${csrfToken.substring(0, 10)}...`);
    
    const messageHeaders = {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.5',
        'cache-control': 'no-cache',
        'content-type': 'application/json',
        'origin': 'https://www.1secemail.com',
        'pragma': 'no-cache',
        'referer': 'https://www.1secemail.com/',
        'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Brave";v="150"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'sec-gpc': '1',
        'user-agent': userAgent
    };
    
    log("Creating email account...");
    const createResponse = await axios({
        method: 'POST',
        url: 'https://www.1secemail.com/get_messages',
        headers: messageHeaders,
        data: { _token: csrfToken }
    });
    
    const setCookieHeaders = createResponse.headers['set-cookie'];
    if (!setCookieHeaders || setCookieHeaders.length === 0) {
        throw new Error("Failed to get cookies from email creation");
    }
    
    const cookies = setCookieHeaders.map(cookie => cookie.split(';')[0]).join('; ');
    
    const createData = createResponse.data;
    if (!createData.status || !createData.mailbox) {
        throw new Error("Failed to create temporary email");
    }
    
    const email = createData.mailbox;
    log(`Temporary email created: ${email}`);
    
    return { email, csrfToken, cookies, userAgent };
}

async function waitForOTP(csrfToken, cookies, userAgent, log, maxAttempts = 30) {
    log("Waiting for OTP email...");
    
    const headers = {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.5',
        'cache-control': 'no-cache',
        'content-type': 'application/json',
        'cookie': cookies,
        'origin': 'https://www.1secemail.com',
        'pragma': 'no-cache',
        'referer': 'https://www.1secemail.com/',
        'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Brave";v="150"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'sec-gpc': '1',
        'user-agent': userAgent
    };
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        log(`Checking for OTP (attempt ${attempt}/${maxAttempts})...`);
        
        const response = await axios({
            method: 'POST',
            url: 'https://www.1secemail.com/get_messages',
            headers,
            data: { _token: csrfToken }
        });
        
        const data = response.data;
        
        if (data.messages && data.messages.length > 0) {
            const otpMessage = data.messages.find(msg => 
                msg.subject && msg.subject.includes('confirmation code')
            );
            
            if (otpMessage) {
                const subjectMatch = otpMessage.subject.match(/code:\s*([A-Z0-9-]+)/i);
                if (subjectMatch) {
                    const otpCode = subjectMatch[1];
                    log(`OTP code received: ${otpCode}`);
                    return otpCode;
                }
            }
        }
        
        await sleep(5000);
    }
    
    throw new Error("OTP code not received within timeout");
}

async function openGrokCLIOAuthAndGetNewPage(browser, page, log) {
    const config = getConfig();
    const baseUrl = config.routerUrl.replace(/\/$/, "");
    const targetUrl = `${baseUrl}/dashboard/providers/grok-cli`;

    log(`Navigating to ${targetUrl}`);
    await page.goto(targetUrl, {
        waitUntil: "networkidle2",
        timeout: config.timeouts.navigation,
    });

    log("Setting up new page listener...");
    
    const newPagePromise = new Promise(resolve => {
        browser.once('targetcreated', async target => {
            const newPage = await target.page();
            resolve(newPage);
        });
    });

    log("Clicking Add button...");
    await clickSelector(page, 'button::-p-text(Add)', {
        timeout: config.timeouts.default,
    });

    log("Waiting for new tab to be created...");
    const newPage = await newPagePromise;
    
    log(`New tab created: ${newPage.url()}`);
    
    return newPage;
}

async function acceptCookies(page, log) {
    log("Checking for cookie consent popup...");
    
    try {
        // Common cookie consent button selectors
        const cookieSelectors = [
            'button::-p-text(Accept All)',
            'button::-p-text(Accept all)',
            'button::-p-text(Accept All Cookies)',
            'button::-p-text(Allow All)',
            'button::-p-text(I Accept)',
            'button::-p-text(Accept)',
            'button::-p-text(Agree)',
            'button[id*="accept"]',
            'button[class*="accept"]',
            'button[id*="cookie"]',
            'button[class*="cookie"]',
            'button[id*="consent"]',
            'button[class*="consent"]',
            'a::-p-text(Accept All)',
            'a::-p-text(Accept)',
        ];
        
        for (const selector of cookieSelectors) {
            try {
                const button = await page.waitForSelector(selector, { 
                    timeout: 2000,
                    visible: true 
                });
                
                if (button) {
                    log(`Found cookie consent button: ${selector}`);
                    await sleep(500);
                    await button.click();
                    log("Clicked cookie consent button");
                    await sleep(1000);
                    return true;
                }
            } catch (e) {
                // Try next selector
            }
        }
        
        log("No cookie consent popup found");
        return false;
    } catch (e) {
        log(`Cookie consent handling error: ${e.message}`);
        return false;
    }
}

async function addHumanBehavior(page, log) {
    log("Adding human-like behavior...");
    
    await page.evaluate(() => {
        window.scrollBy(0, Math.random() * 100);
    });
    await sleep(500 + Math.random() * 1000);
    
    const randomX = Math.floor(Math.random() * 200) + 100;
    const randomY = Math.floor(Math.random() * 200) + 100;
    await page.mouse.move(randomX, randomY, { steps: 10 });
    await sleep(300 + Math.random() * 700);
}

async function handleGrokSignUp(grokPage, tempEmail, log) {
    const config = getConfig();
    
    log("Waiting for Grok login page...");
    await grokPage.waitForFunction(
        () => window.location.href.includes("accounts.x.ai"),
        { timeout: config.timeouts.navigation }
    );
    
    await sleep(2000);
    
    // Accept cookies first before any interaction
    await acceptCookies(grokPage, log);
    
    await addHumanBehavior(grokPage, log);
    await sleep(2000);
    
    log("Clicking Continue button...");
    await clickSelector(grokPage, 'button[type="submit"]::-p-text(Continue)', {
        timeout: config.timeouts.default,
    });
    
    await sleep(2000);
    
    log("Clicking Sign up link...");
    await clickSelector(grokPage, 'a::-p-text(Sign up)', {
        timeout: config.timeouts.default,
    });
    
    await sleep(2000);
    
    log("Clicking Sign up with email button...");
    await clickSelector(grokPage, 'button::-p-text(Sign up with email)', {
        timeout: config.timeouts.default,
    });
    
    await sleep(2000);
    
    log(`Typing email: ${tempEmail.email}`);
    await clickSelector(grokPage, 'input[type="email"][name="email"]', {
        timeout: config.timeouts.default,
    });
    await grokPage.keyboard.type(tempEmail.email);
    
    log("Waiting 5 seconds before clicking Sign up...");
    await sleep(5000);
    
    log("Clicking Sign up button...");
    await clickSelector(grokPage, 'button[type="submit"]::-p-text(Sign up)', {
        timeout: config.timeouts.default,
    });
    
    return tempEmail;
}

async function waitForCloudflareChallenge(page, log, maxWaitTime = 30000) {
    log("Checking for Cloudflare challenge...");
    
    const startTime = Date.now();
    let manualSolveWarningShown = false;
    
    while (Date.now() - startTime < maxWaitTime) {
        const hasChallengeOrError = await page.evaluate(() => {
            const bodyText = document.body.innerText.toLowerCase();
            const pageUrl = window.location.href;
            
            const hasCloudflareText = bodyText.includes('cloudflare') || 
                                     bodyText.includes('just a moment') ||
                                     bodyText.includes('checking your browser') ||
                                     bodyText.includes('ddos protection') ||
                                     bodyText.includes('verifying you are human') ||
                                     bodyText.includes('verify you are human');
            
            const hasChallengeUrl = pageUrl.includes('challenges.cloudflare.com');
            
            const hasChallengeElements = document.querySelector('[id*="cf-"]') || 
                                        document.querySelector('[class*="cf-"]') ||
                                        document.querySelector('[id*="challenge"]') ||
                                        document.querySelector('[class*="challenge"]') ||
                                        document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
                                        document.querySelector('iframe[src*="turnstile"]');
            
            const hasErrorIndicators = bodyText.includes('error 1020') ||
                                       bodyText.includes('access denied') ||
                                       bodyText.includes('ray id');
            
            return {
                hasChallenge: hasCloudflareText || hasChallengeUrl || hasChallengeElements !== null,
                hasError: hasErrorIndicators
            };
        });
        
        if (hasChallengeOrError.hasError) {
            throw new Error('Cloudflare blocked access - Error 1020 or Access Denied detected. Try using residential proxy or different IP.');
        }
        
        if (!hasChallengeOrError.hasChallenge) {
            log("Cloudflare challenge cleared or not present");
            return true;
        }
        
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        
        // Show manual solve warning after 15 seconds
        if (elapsed >= 15 && !manualSolveWarningShown) {
            log("⚠️  Cloudflare challenge persisting - if running in headed mode, you can manually solve the challenge");
            log("⚠️  If challenge fails even manually, the IP/proxy is likely blocklisted by Cloudflare");
            log("⚠️  Consider using residential proxy instead of datacenter proxy");
            manualSolveWarningShown = true;
        }
        
        log(`Cloudflare challenge detected, waiting... (${elapsed}s/${maxWaitTime/1000}s)`);
        await sleep(2000);
    }
    
    // Extended wait for manual solving
    log("⏰ Cloudflare challenge timeout reached. Extending wait for manual solving...");
    log("💡 TIP: If you're in headed mode, please manually solve the Cloudflare challenge now");
    
    // Wait additional 60 seconds for manual solving
    const extendedStart = Date.now();
    const extendedWait = 60000;
    
    while (Date.now() - extendedStart < extendedWait) {
        const stillHasChallenge = await page.evaluate(() => {
            const bodyText = document.body.innerText.toLowerCase();
            return bodyText.includes('cloudflare') || 
                   bodyText.includes('verify you are human') ||
                   bodyText.includes('checking your browser');
        });
        
        if (!stillHasChallenge) {
            log("✅ Cloudflare challenge manually solved!");
            return true;
        }
        
        const extendedElapsed = Math.floor((Date.now() - extendedStart) / 1000);
        if (extendedElapsed % 10 === 0) {
            log(`Waiting for manual solve... (${extendedElapsed}s/${extendedWait/1000}s)`);
        }
        await sleep(2000);
    }
    
    log("❌ Cloudflare challenge still present after extended timeout");
    throw new Error('Cloudflare challenge could not be solved. IP/proxy likely blocklisted. Use residential proxy or try different IP.');
}

async function enterOTPAndCompleteSignUp(grokPage, otpCode, log) {
    const config = getConfig();
    
    log("Waiting for OTP input...");
    await sleep(3000);
    
    log(`Typing OTP code: ${otpCode}`);
    const otpInput = await grokPage.waitForSelector('input[name="code"]', {
        timeout: config.timeouts.default,
    });
    await otpInput.click();
    await grokPage.keyboard.type(otpCode.replace('-', ''));
    
    log("Waiting for auto-submit...");
    await sleep(3000);
    
    await addHumanBehavior(grokPage, log);
    
    await waitForCloudflareChallenge(grokPage, log, 30000);
    
    // Accept cookies after Cloudflare challenge (popup might appear after challenge)
    await acceptCookies(grokPage, log);
    
    await sleep(2000);
    await addHumanBehavior(grokPage, log);
    
    const firstName = 'John' + Math.floor(Math.random() * 10000);
    const lastName = 'Doe' + Math.floor(Math.random() * 10000);
    const password = 'Pass@' + Math.floor(Math.random() * 100000) + 'word!';
    
    log(`Typing first name: ${firstName}`);
    await clickSelector(grokPage, 'input[name="givenName"]', {
        timeout: config.timeouts.default,
    });
    await grokPage.keyboard.type(firstName);
    
    log(`Typing last name: ${lastName}`);
    await clickSelector(grokPage, 'input[name="familyName"]', {
        timeout: config.timeouts.default,
    });
    await grokPage.keyboard.type(lastName);
    
    log("Typing password...");
    await clickSelector(grokPage, 'input[type="password"][name="password"]', {
        timeout: config.timeouts.default,
    });
    await grokPage.keyboard.type(password);
    
    log("Waiting 3 seconds for Cloudflare captcha...");
    await sleep(3000);
    
    log("Clicking Complete sign up button...");
    await clickSelector(grokPage, 'button[type="submit"]::-p-text(Complete sign up)', {
        timeout: config.timeouts.default,
    });
    
    await sleep(3000);
    
    log("Clicking Continue button...");
    await clickSelector(grokPage, 'button[type="submit"]::-p-text(Continue)', {
        timeout: config.timeouts.default,
    });
    
    await sleep(2000);
    
    log("Clicking Allow button...");
    await clickSelector(grokPage, 'button[type="submit"]::-p-text(Allow)', {
        timeout: config.timeouts.default,
    });
}

async function waitForDeviceAuthorized(grokPage, log) {
    const config = getConfig();
    
    log("Waiting for Device Authorized...");
    await grokPage.waitForFunction(
        () => {
            const hasSuccessMessage = document.body.innerText.includes("Device Authorized");
            const hasSuccessUrl = window.location.href.includes("/oauth2/device/done");
            return hasSuccessMessage || hasSuccessUrl;
        },
        { timeout: config.timeouts.navigation }
    );
    
    log("Device authorized successfully!");
}

async function waitForOAuthComplete(routerPage, log) {
    const config = getConfig();
    const maxWaitTime = 60000;
    const checkInterval = 2000;
    const startTime = Date.now();

    log("Waiting for OAuth modal to disappear in 9router...");
    
    while (Date.now() - startTime < maxWaitTime) {
        const modalExists = await routerPage.evaluate(() => {
            const modalText = document.body.innerText;
            return modalText.includes("Waiting for authorization") || 
                   modalText.includes("Connect Grok CLI");
        });

        if (!modalExists) {
            log("OAuth modal disappeared - import successful!");
            return true;
        }

        log(`OAuth modal still present, waiting ${checkInterval/1000}s...`);
        await sleep(checkInterval);
    }

    throw new Error("OAuth modal still present after 60s - import may have failed");
}

async function processGrokCLIAccount(
    browserArgsIndex,
    workerIndex,
    log,
    updateProgress,
    useProxy = true,
) {
    const config = getConfig();
    const path = require('path');
    const os = require('os');
    const fs = require('fs');
    
    let poolProxy = null;
    let proxy = null;

    if (config.proxyPoolFile && useProxy) {
        poolProxy = await acquireProxy(log, updateProgress);
        proxy = poolProxy;
    }

    updateProgress({ step: STEPS.LAUNCHING, email: "Creating temp email..." });
    log("Creating temporary email...");
    
    const tempEmail = await createTempEmail(log);

    updateProgress({ step: STEPS.LAUNCHING, email: tempEmail.email });
    log(`Launching browser for ${tempEmail.email}`);

    // Custom browser args for Grok/Cloudflare - NO incognito, more realistic
    const grokBrowserArgs = [
        "--disable-blink-features=AutomationControlled",
        "--disable-features=BlockThirdPartyCookies",
        "--disable-features=IsolateOrigins,site-per-process",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-popup-blocking",
        "--ignore-certificate-errors",
        "--window-size=1920,1080",
    ];
    
    // Use persistent userDataDir for Grok to build browser history/cookies
    const persistentUserDataDir = path.join(os.homedir(), '.bercocok-tanam', 'grok-browser-profile');
    
    // Ensure directory exists
    if (!fs.existsSync(persistentUserDataDir)) {
        fs.mkdirSync(persistentUserDataDir, { recursive: true });
        log(`Created persistent browser profile: ${persistentUserDataDir}`);
    } else {
        log(`Using existing browser profile: ${persistentUserDataDir}`);
    }

    const { browser, page: routerPage } = await launchBrowser(
        browserArgsIndex,
        workerIndex,
        proxy,
        grokBrowserArgs, // Use custom args instead of config defaults
        persistentUserDataDir, // Use persistent profile
    );

    let grokPage = null;

    try {
        updateProgress({ step: STEPS.NAVIGATING });
        grokPage = await openGrokCLIOAuthAndGetNewPage(browser, routerPage, log);

        updateProgress({ step: STEPS.GOOGLE_LOGIN });
        await handleGrokSignUp(grokPage, tempEmail, log);

        updateProgress({ step: STEPS.WAITING });
        const otpCode = await waitForOTP(tempEmail.csrfToken, tempEmail.cookies, tempEmail.userAgent, log);

        updateProgress({ step: STEPS.IMPORTING });
        await enterOTPAndCompleteSignUp(grokPage, otpCode, log);
        
        await waitForDeviceAuthorized(grokPage, log);
        
        await waitForOAuthComplete(routerPage, log);

        log("OAuth complete, closing Grok tab...");
        await grokPage.close();
        grokPage = null;

        log(`Account created and OAuth successful: ${tempEmail.email}`);

        await sleep(config.delays.beforeBrowserClose);
    } finally {
        if (grokPage && !grokPage.isClosed()) {
            await grokPage.close().catch(() => {});
        }
        await browser.close();
        log("Browser closed.");
        if (poolProxy) {
            releaseProxy(poolProxy);
            log(`[Proxy] Released: ${poolProxy.split(':')[0]}`);
        }
    }
}

async function runGrokCLIWorker(
    accountCount,
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

    for (let i = 0; i < accountCount; i++) {
        const updateProgress = (payload) => {
            progress.updateWorker(workerId, {
                ...payload,
                success: successCount,
                failed: failedCount,
                current: processedCount,
            });
        };

        const startTime = Date.now();
        let accountSuccess = false;
        let accountError = null;
        let accountEmail = "temp-account";

        try {
            await processGrokCLIAccount(
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
                email: accountEmail,
                success: successCount,
                failed: failedCount,
                current: processedCount,
            });
        } catch (error) {
            accountSuccess = false;
            accountError = error.message;
            failedCount += 1;
            processedCount += 1;

            browserArgsIndex = (browserArgsIndex + 1) % config.browserArgsSets.length;

            log(`[${workerId}] Error: ${error.message}`);

            progress.updateWorker(workerId, {
                step: STEPS.ERROR,
                email: accountEmail,
                success: successCount,
                failed: failedCount,
                current: processedCount,
            });
        } finally {
            const duration = Date.now() - startTime;

            accountStats.push({
                email: accountEmail,
                rawLine: accountEmail,
                success: accountSuccess,
                duration,
                error: accountError,
            });
        }

        if (i < accountCount - 1) {
            progress.updateWorker(workerId, { step: STEPS.WAITING });
            await sleep(config.delays.betweenAccounts);
        }
    }

    progress.updateWorker(workerId, {
        step: STEPS.DONE,
        email: "Done",
        success: successCount,
        failed: failedCount,
        current: accountCount,
    });

    return {
        successCount,
        failedCount,
        accounts: accountStats,
        label: `Grok CLI W${workerIndex + 1}`,
    };
}

async function runGrokCLIAutomation(accountCount = 1, sharedProgress = null, useProxy = true) {
    const config = getConfig();
    const logger = createFileLogger();

    if (accountCount <= 0) {
        if (!sharedProgress) { console.log("Account count must be greater than 0"); }
        logger.close();
        return null;
    }

    if (!sharedProgress) {
        console.log("");
        console.log("🤖 Grok CLI Automation");
        console.log(`   Creating ${accountCount} account(s) with temporary emails`);
        console.log("");
    }

    const startedAt = Date.now();
    const workerCount = Math.min(config.browserCount, accountCount);
    const accountsPerWorker = Math.ceil(accountCount / workerCount);

    const progress =
        sharedProgress ||
        createProgressManager(
            `🤖 Grok CLI Automation — ${accountCount} accounts, ${workerCount} workers`,
        );

    for (let i = 0; i < workerCount; i++) {
        const workerAccounts = Math.min(accountsPerWorker, accountCount - (i * accountsPerWorker));
        progress.addWorker(`grok-cli-${i}`, workerAccounts, `Grok CLI W${i + 1}`);
    }

    const results = await Promise.all(
        Array.from({ length: workerCount }, (_, i) => {
            const browserArgsIndex = i % config.browserArgsSets.length;
            const workerAccounts = Math.min(accountsPerWorker, accountCount - (i * accountsPerWorker));

            return runGrokCLIWorker(
                workerAccounts,
                `grok-cli-${i}`,
                browserArgsIndex,
                i,
                accountCount,
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
        printReport("🤖 GROK CLI AUTOMATION REPORT", results, totalDuration);
        console.log(`📄 Log: ${logger.logFile}`);
        console.log("");
    } else {
        const duration = formatDuration(totalDuration);
        logger.log(
            `Grok CLI finished. Success: ${successCount}, Failed: ${failedCount}, Duration: ${duration}`,
        );
    }

    logger.close();

    return { successCount, failedCount, results };
}

module.exports = {
    runGrokCLIAutomation,
};
