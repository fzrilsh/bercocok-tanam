const { mkdirSync, mkdtempSync, appendFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { getConfig } = require('../../config');
const { createTempEmail } = require('../../providers/email');
const { readInboxMetadata, readMessageBody } = require('../../providers/email/gmail-helper');
const { resolveTurnstileExt, cleanupSealedTemps } = require('./seal-turnstile');
const {
    launchChrome,
    hardenPage,
    clearBrowserCookies,
    getAllCookies,
    fillInput,
    clickText,
    tryClickText,
    pageLooksBlocked,
    sleep,
} = require('./utils');
const { STEPS } = require('../../cli/progress');
const { createFileLogger } = require('../../utils');
const { addAccountToRouter } = require('../../providers/router');

const PROJECT_ROOT = join(__dirname, '../../..');
const GROK_KEYS_FILE = join(PROJECT_ROOT, 'grok_keys.txt');
const SIGNUP_URL = 'https://accounts.x.ai/sign-up?redirect=grok-com';

function extractOtp(text) {
    if (!text) return null;
    let g = text.match(/code:\s*([A-Z0-9]{3}-[A-Z0-9]{3})/i);
    if (g) return g[1].replace(/-/g, '');
    g = text.match(/code:\s*([A-Z0-9]{6})/i);
    if (g) return g[1];
    g = text.match(/\b([A-Z0-9]{3}-[A-Z0-9]{3})\b/i);
    if (g) return g[1].replace(/-/g, '');
    g = text.match(/\b([A-Z0-9]{6})\b/);
    if (g) return g[1];
    return null;
}

class Mail {
    constructor(provider) {
        this.provider = provider;
        this.addr = '';
        this.tempEmailData = null;
        this.log = () => {};
    }

    async create(accountIndex, log) {
        this.log = log || (() => {});
        this.tempEmailData = await createTempEmail(accountIndex, this.log, this.provider);
        this.addr = this.tempEmailData.email;
        this.provider = this.tempEmailData.provider;
        return this.addr;
    }

    async peekCode() {
        if (!this.tempEmailData) return null;

        try {
            if (this.provider === 'ncaori') {
                const res = await fetch(
                    `https://www.ncaori.my.id/api/emails?recipient=${encodeURIComponent(this.addr)}`
                );
                if (!res.ok) {
                    this.log(`[Grok Mail] ncaori API error: ${res.status}`);
                    return null;
                }
                const data = await res.json();
                this.log(`[Grok Mail] ncaori: ${data.emails?.length || 0} messages`);
                for (const msg of data.emails || []) {
                    const content = (msg.subject || '') + '\n' + (msg.body_html || '') + '\n' + (msg.body_text || '');
                    const code = extractOtp(content);
                    if (code) {
                        this.log(`[Grok Mail] OTP found in ncaori message: ${code}`);
                        return code;
                    }
                }
            } else if (this.provider === '1secemail') {
                // Use session-based authentication (POST to /get_messages with CSRF token + cookies)
                if (!this.tempEmailData.csrfToken || !this.tempEmailData.cookies) {
                    this.log(`[Grok Mail] 1secemail: missing csrfToken or cookies`);
                    return null;
                }

                const url = `https://www.1secemail.com/get_messages`;
                this.log(`[Grok Mail] Polling 1secemail (session-auth): ${url}`);
                
                const res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'accept': 'application/json, text/plain, */*',
                        'accept-language': 'en-US,en;q=0.5',
                        'cache-control': 'no-cache',
                        'content-type': 'application/json',
                        'cookie': this.tempEmailData.cookies,
                        'origin': 'https://www.1secemail.com',
                        'pragma': 'no-cache',
                        'referer': 'https://www.1secemail.com/',
                        'user-agent': this.tempEmailData.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    },
                    body: JSON.stringify({ _token: this.tempEmailData.csrfToken }),
                });

                if (!res.ok) {
                    this.log(`[Grok Mail] 1secemail API error: ${res.status}`);
                    return null;
                }
                
                const data = await res.json();
                const messages = data.messages || [];
                this.log(`[Grok Mail] 1secemail: ${messages.length} messages`);
                
                for (const msg of messages) {
                    const subject = msg.subject || '';
                    const content = msg.content || '';
                    const fromEmail = msg.from_email || '';
                    
                    this.log(`[Grok Mail] Message from ${fromEmail}: subject="${subject.substring(0, 50)}"`);
                    
                    // Try extracting OTP from subject first, then from content
                    const codeFromSubject = extractOtp(subject);
                    if (codeFromSubject) {
                        this.log(`[Grok Mail] OTP found in subject: ${codeFromSubject}`);
                        return codeFromSubject;
                    }
                    
                    const codeFromContent = extractOtp(content);
                    if (codeFromContent) {
                        this.log(`[Grok Mail] OTP found in content: ${codeFromContent}`);
                        return codeFromContent;
                    }
                }
            } else if (this.provider === 'gmail') {
                const query = `to:${this.addr} from:x.ai newer_than:5m`;
                const metaMsgs = await readInboxMetadata(query, 5, this.log);
                this.log(`[Grok Mail] gmail: ${metaMsgs.length} messages`);
                for (const msg of metaMsgs) {
                    const codeFromSubject = extractOtp(msg.subject || '');
                    if (codeFromSubject) {
                        this.log(`[Grok Mail] OTP found in subject: ${codeFromSubject}`);
                        return codeFromSubject;
                    }
                    const body = await readMessageBody(msg.id, this.log);
                    const code = extractOtp((msg.subject || '') + '\n' + body);
                    if (code) {
                        this.log(`[Grok Mail] OTP found in gmail message: ${code}`);
                        return code;
                    }
                }
            } else if (this.provider === 'mailcx') {
                const { pollMessages } = require('../../providers/email');
                const messages = await pollMessages(this.tempEmailData, this.log);
                this.log(`[Grok Mail] mailcx: ${messages.length} messages`);
                for (const msg of messages) {
                    const content = (msg.subject || '') + '\n' + (msg.body || '');
                    const code = extractOtp(content);
                    if (code) {
                        this.log(`[Grok Mail] OTP found in mailcx message: ${code}`);
                        return code;
                    }
                }
            }
        } catch (e) {
            this.log(`[Grok Mail] peekCode error: ${e.message}`);
            return null;
        }
        return null;
    }
}

async function flow(page, accountIndex, log, updateProgress, tempEmailProvider) {
    const config = getConfig();
    const password = config.grokPassword || config.password || 'DefaultPass123!@#';

    updateProgress({ step: STEPS.NAVIGATING, email: 'Opening signup page...' });
    log('[Grok] Step 1: Open signup');
    await page.goto(SIGNUP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    for (let i = 0; i < 15; i++) {
        const blocked = await pageLooksBlocked(page);
        if (!blocked) break;
        if (blocked.startsWith('cloudflare block')) throw new Error(blocked);
        await sleep(1000);
    }

    await tryClickText(page, 'Accept All Cookies', 3000);
    await tryClickText(page, 'Accept all cookies', 1500);
    await sleep(500);

    const blocked = await pageLooksBlocked(page);
    if (blocked?.startsWith('cloudflare block')) throw new Error(blocked);
    log('[Grok] Page loaded');

    updateProgress({ step: STEPS.NAVIGATING, email: 'Finding email form...' });
    log('[Grok] Step 2: Sign up with email');
    const emailSel = 'input[type=email], input[name=email], input[data-testid=email]';
    const emailReady = await page.$(emailSel);
    if (!emailReady) {
        const variants = ['Sign up with email', 'Sign up with Email', 'Continue with email', 'Email'];
        let okClick = false;
        for (const v of variants) {
            try {
                await clickText(page, v, 5000);
                okClick = true;
                break;
            } catch {
            }
        }
        if (!okClick) throw new Error('Sign up with email button not found');
    }
    await page.waitForSelector(emailSel, { timeout: 12000, visible: true });
    log('[Grok] Email form ready');

    updateProgress({ step: STEPS.LAUNCHING, email: 'Creating temp email...' });
    log('[Grok] Step 3: Create temp email');
    const mail = new Mail(tempEmailProvider);
    const addr = await mail.create(accountIndex, log);
    log(`[Grok] Temp email created: ${addr} (provider: ${mail.provider})`);

    await fillInput(page, emailSel, addr);
    await page.keyboard.press('Enter');

    try {
        await page.waitForSelector('input[name=code]', { timeout: 20000, visible: true });
    } catch {
        await tryClickText(page, 'Sign up', 3000);
        await page.waitForSelector('input[name=code]', { timeout: 15000, visible: true });
    }
    log('[Grok] Email submitted');

    updateProgress({ step: STEPS.VERIFYING, email: `Waiting for OTP: ${addr}` });
    log('[Grok] Step 4: Wait for OTP');
    const t0 = Date.now();
    let code = null;
    let attempts = 0;
    while ((Date.now() - t0) / 1000 < 120) {
        attempts++;
        const elapsed = Math.floor((Date.now() - t0) / 1000);
        if (attempts % 5 === 1) {
            log(`[Grok] OTP polling attempt ${attempts}, elapsed ${elapsed}s...`);
        }
        code = await mail.peekCode();
        if (code) break;
        await sleep(3000);
    }
    if (!code) {
        log(`[Grok] OTP timeout after ${attempts} attempts`);
        throw new Error('OTP timeout 120s');
    }
    log(`[Grok] OTP received: ${code} (after ${attempts} attempts)`);

    updateProgress({ step: STEPS.VERIFYING, email: `Submitting OTP: ${code}` });
    log('[Grok] Step 5: Submit OTP');
    await fillInput(page, 'input[name=code]', code, 15000, 500);
    await page.keyboard.press('Enter');
    await page.waitForSelector('input[name=givenName]', { timeout: 20000, visible: true });
    log('[Grok] OTP verified');

    updateProgress({ step: STEPS.LOGGING_IN, email: 'Filling name & password...' });
    log('[Grok] Step 6: Fill name & password');
    const names = ['Alex','Jordan','Taylor','Morgan','Riley','Casey','Jamie','Avery','Quinn','Drew','Sam','Reese','Blake','Cameron','Skyler','Hayden','Parker','Rowan','Sage','Finley'];
    const surnames = ['Smith','Johnson','Brown','Davis','Wilson','Moore','Taylor','Anderson','Thomas','Lee','Walker','Hall','Young','King','Wright','Lopez','Hill','Green','Adams','Baker'];
    const given = names[Math.floor(Math.random() * names.length)];
    const family = surnames[Math.floor(Math.random() * surnames.length)];

    await fillInput(page, 'input[name=givenName]', given);
    await fillInput(page, 'input[name=familyName]', family);
    await fillInput(page, 'input[name=password]', password);
    log(`[Grok] Form filled: ${given} ${family}`);

    updateProgress({ step: STEPS.SOLVING_CAPTCHA, email: 'Solving turnstile...' });
    log('[Grok] Step 7: Solve turnstile & submit');
    await sleep(3000 + Math.random() * 300);
    await page.keyboard.press('Tab');
    await sleep(300 + Math.random() * 400);
    await page.keyboard.press('Space');
    await sleep(400 + Math.random() * 300);

    let tok = '';
    for (let i = 0; i < 40; i++) {
        tok = await page.evaluate(
            `(() => {
                const el = document.querySelector('input[name=cf-turnstile-response]');
                return (el && el.value) || '';
            })()`
        );
        if (tok) break;
        await sleep(1000);
    }
    if (!tok) throw new Error('Turnstile timeout 40s');
    log('[Grok] Turnstile solved');

    const emptyFields = await page.evaluate(
        `(() => {
            const empty = (s) => { const el = document.querySelector(s); return !el || !el.value; };
            return {
                given: empty('input[name=givenName]'),
                family: empty('input[name=familyName]'),
                password: empty('input[name=password]'),
            };
        })()`
    );
    if (emptyFields.given) await fillInput(page, 'input[name=givenName]', given);
    if (emptyFields.family) await fillInput(page, 'input[name=familyName]', family);
    if (emptyFields.password) await fillInput(page, 'input[name=password]', password);

    const submitSignup = async () => {
        const clicked = await page.evaluate(
            `(() => {
                const btns = Array.from(document.querySelectorAll('button, [role="button"], input[type=submit]'));
                const match = btns.find((b) => /complete\\s*sign\\s*up|create\\s*account|sign\\s*up/i.test(
                    ((b.textContent || b.value || '') + '').replace(/\\s+/g, ' ').trim()
                ));
                if (!match) return false;
                if (match.disabled) {
                    match.removeAttribute('disabled');
                    match.disabled = false;
                }
                match.click();
                return true;
            })()`
        );
        if (clicked) return;
        const formOk = await page.evaluate(
            `(() => {
                const form = document.querySelector('form');
                if (!form) return false;
                if (typeof form.requestSubmit === 'function') form.requestSubmit();
                else form.submit();
                return true;
            })()`
        );
        if (formOk) return;
        await clickText(page, 'Complete sign up', 10000);
    };

    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null),
        submitSignup(),
    ]);
    log('[Grok] Form submitted');

    updateProgress({ step: STEPS.FINALIZING, email: 'Waiting for redirect...' });
    log('[Grok] Step 8: Finish redirect');
    const isGrok = (u) => /(?:^|[/.])grok\.com(?:[/:?]|$)/i.test(u);
    let redirected = false;

    for (let i = 0; i < 20 && !redirected; i++) {
        await sleep(1500);
        let url = '';
        try {
            url = page.url();
        } catch {
            continue;
        }
        if (isGrok(url)) {
            log('[Grok] Redirect OK');
            redirected = true;
            break;
        }
    }

    if (!redirected) {
        try {
            await page.goto('https://grok.com/', { waitUntil: 'domcontentloaded', timeout: 12000 });
            await sleep(800);
            if (isGrok(page.url())) {
                log('[Grok] Force redirect OK');
                redirected = true;
            }
        } catch {
        }
    }

    if (!redirected) throw new Error('no redirect to grok.com');

    const allCookies = await getAllCookies(page);
    const ssoCookies = allCookies.filter((c) => /^(sso|sso-rw|x-userid)$/i.test(c.name));

    log('[Grok] Setting birth date...');
    try {
        const birthDateResponse = await page.evaluate(async () => {
            const response = await fetch('https://grok.com/rest/auth/set-birth-date', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ birthDate: '2007-01-01T17:00:00.000Z' }),
            });
            return { ok: response.ok, status: response.status };
        });
        if (birthDateResponse.ok) {
            log('[Grok] Birth date set successfully');
        } else {
            log(`[Grok] Birth date set failed: HTTP ${birthDateResponse.status}`);
        }
    } catch (e) {
        log(`[Grok] Birth date error: ${e.message}`);
    }

    updateProgress({ step: STEPS.DONE, email: 'Saving account...' });
    log('[Grok] Step 9: Save credentials');
    const accountData = {
        email: addr,
        password,
        code,
        sso_cookies: ssoCookies,
        final_url: page.url(),
        timestamp: Math.floor(Date.now() / 1000),
    };

    mkdirSync(PROJECT_ROOT, { recursive: true });
    appendFileSync(GROK_KEYS_FILE, JSON.stringify(accountData) + '\n');
    log('[Grok] Account saved');

    return {
        success: true,
        account: {
            ...accountData,
            username: given + family,
        },
    };
}

async function runGrokAutomation(accountCount = 1, sharedProgress = null, useProxy = true, tempEmailProvider = null) {
    const config = getConfig();
    const logger = createFileLogger();

    if (accountCount <= 0) {
        if (!sharedProgress) console.log('Account count must be greater than 0');
        logger.close();
        return null;
    }

    if (!sharedProgress) {
        console.log('');
        console.log('🤖 Grok Signup Automation');
        console.log(`   Creating ${accountCount} Grok account(s)`);
        console.log('');
    }

    const startedAt = Date.now();

    let extPath;
    try {
        logger.log('[Grok] Loading turnstile extension...');
        extPath = await resolveTurnstileExt();
        logger.log('[Grok] Extension ready');
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.log(`[Grok] Turnstile error: ${msg}`);
        if (!sharedProgress) console.log(`❌ Turnstile extension error: ${msg}`);
        logger.close();
        return null;
    }

    let successCount = 0;
    let failedCount = 0;
    let processedCount = 0;
    const results = [];

    const provider = tempEmailProvider || config.tempEmailProvider || 'auto';

    const workerId = 'grok-worker-0';
    if (sharedProgress) {
        sharedProgress.addWorker(workerId, accountCount, 'Grok Signup');
    }

    for (let i = 0; i < accountCount; i++) {
        const updateProgress = sharedProgress
            ? (payload) => sharedProgress.updateWorker(workerId, { ...payload, success: successCount, failed: failedCount, current: processedCount })
            : () => {};

        const profile = mkdtempSync(join(tmpdir(), `grok-profile-${Date.now()}-`));
        let browser;

        try {
            updateProgress({ step: STEPS.LAUNCHING, email: 'Launching browser...' });
            logger.log(`[Grok] Account ${i + 1}/${accountCount}: Launching browser`);

            browser = await launchChrome({
                profile,
                extPath,
                headless: config.headless,
                chromePath: config.chromeExecutablePath,
                proxy: useProxy ? null : null,
            });

            const page = await browser.newPage();
            await hardenPage(page);

            const result = await flow(page, i, logger.log, updateProgress, provider);

            await page.close();

            if (result.success) {
                let routerSuccess = true;
                let routerError = null;

                // Add to 9router BEFORE closing browser
                try {
                    updateProgress({ step: STEPS.FINALIZING, email: 'Adding to 9router...' });
                    const routerResult = await addAccountToRouter(result.account, browser, logger.log);
                    if (routerResult.success) {
                        const status = routerResult.added ? 'Added' : (routerResult.skipped ? 'Skipped' : 'OK');
                        logger.log(`[9Router] ${status} - ${result.account.email}${routerResult.reason ? ` (${routerResult.reason})` : ''}`);
                    } else {
                        const errMsg = `${routerResult.error || 'unknown'}${routerResult.message ? ` - ${routerResult.message}` : ''}`;
                        logger.log(`[9Router] Failed: ${errMsg}`);
                        
                        // Count as failure only if not skipped (real failure, not just unconfigured)
                        if (!routerResult.skipped) {
                            routerSuccess = false;
                            routerError = errMsg;
                        }
                    }
                } catch (e) {
                    logger.log(`[9Router] Exception: ${e.message}`);
                    routerSuccess = false;
                    routerError = e.message;
                }

                if (routerSuccess) {
                    successCount++;
                    processedCount++;
                    results.push({ ...result, duration: Math.floor((Date.now() - startedAt) / 1000) });
                    logger.log(`[Grok] Account ${i + 1}/${accountCount}: SUCCESS - ${result.account.email}`);
                } else {
                    failedCount++;
                    processedCount++;
                    results.push({ success: false, error: `9router failed: ${routerError}`, accountCreated: true, account: result.account });
                    logger.log(`[Grok] Account ${i + 1}/${accountCount}: FAILED (account created but 9router failed) - ${result.account.email}`);
                }
            } else {
                failedCount++;
                processedCount++;
                results.push({ success: false, error: 'Unknown error' });
            }

            await browser.close();
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            failedCount++;
            processedCount++;
            results.push({ success: false, error: msg });
            logger.log(`[Grok] Account ${i + 1}/${accountCount}: FAILED - ${msg}`);
            if (browser) {
                try {
                    await browser.close();
                } catch {
                }
            }
        }

        if (i < accountCount - 1) {
            await sleep(config.delays?.betweenAccounts || 5000);
        }
    }

    cleanupSealedTemps();

    const totalDuration = Date.now() - startedAt;
    logger.log(`[Grok] Finished. Success: ${successCount}, Failed: ${failedCount}, Duration: ${Math.floor(totalDuration / 1000)}s`);

    if (!sharedProgress) {
        console.log('');
        console.log(`✅ Success: ${successCount}`);
        console.log(`❌ Failed: ${failedCount}`);
        console.log(`⏱️  Duration: ${Math.floor(totalDuration / 1000)}s`);
        console.log('');
    }

    logger.close();

    return { successCount, failedCount, results };
}

module.exports = {
    runGrokAutomation,
};
