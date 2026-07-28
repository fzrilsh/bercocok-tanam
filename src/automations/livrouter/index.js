const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { getConfig, getResultFile, ROOT_DIR } = require('../../config');
const { createRouter } = require('../../providers/router');
const { sleep, createFileLogger, formatDuration, ensureFileExists, acquireProxy, releaseProxy } = require('../../utils');
const { launchBrowser } = require('../../browser');
const { STEPS, createProgressManager } = require('../../cli/progress');
const { printReport } = require('../../cli/reporter');

const BASE_URL = 'https://livrouter.com';
const GITHUB_CLIENT_ID = 'Ov23lizY0ILAlo5BAEBa';
const RESULT_FILE = path.join(ROOT_DIR, 'livrouter_keys.txt');

async function logoutSession(axiosInstance, log) {
  log('Pre-flight: Logging out to ensure clean session...');

  const url = `${BASE_URL}/api/gateway/user/logout`;

  try {
    const response = await axiosRequestWithRetry(axiosInstance, 'GET', url, {}, log);

    if (response.status === 200) {
      log('✅ Logout successful - session cleaned');
    } else {
      log(`⚠️ Logout returned ${response.status} (continuing anyway)`);
    }
  } catch (err) {
    log(`⚠️ Logout failed: ${err.message} (continuing anyway)`);
  }
}

function buildStealthHeaders() {
  return {
    'accept': 'application/json',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    'pragma': 'no-cache',
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  };
}

function createAxiosInstance(proxy, log) {
  const config = {
    timeout: 30000,
    headers: buildStealthHeaders(),
    validateStatus: () => true
  };

  if (proxy) {
    let proxyUrl = proxy;
    if (!proxy.startsWith('http://') && !proxy.startsWith('https://')) {
      proxyUrl = `http://${proxy}`;
    }

    try {
      const httpsAgent = new HttpsProxyAgent(proxyUrl);
      config.httpsAgent = httpsAgent;
      config.proxy = false;

      const proxyDisplay = proxyUrl.includes('@')
        ? proxyUrl.split('@')[1].replace(/^https?:\/\//, '')
        : proxyUrl.replace(/^https?:\/\//, '');

      log(`Using proxy: ${proxyDisplay}`);
    } catch (err) {
      log(`Proxy config error: ${err.message} - proceeding without proxy`);
    }
  }

  return axios.create(config);
}

async function axiosRequestWithRetry(axiosInstance, method, url, options, log, maxRetries = 5) {
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      const response = await axiosInstance.request({ method, url, ...options });

      if (response.status === 429) {
        attempt++;
        if (attempt < maxRetries) {
          log(`Got HTTP 429, retry ${attempt}/${maxRetries} after 2s...`);
          await sleep(2000);
          continue;
        }
        throw new Error(`HTTP 429 persisted after ${maxRetries} retries`);
      }

      if (response.status >= 500 && response.status < 600) {
        attempt++;
        if (attempt < maxRetries) {
          log(`Got ${response.status}, retry ${attempt}/${maxRetries} after 2s...`);
          await sleep(2000);
          continue;
        }
        return response;
      }

      return response;

    } catch (err) {
      attempt++;
      if (attempt >= maxRetries) {
        throw new Error(`Network error after ${maxRetries} attempts: ${err.message}`);
      }
      log(`Network error: ${err.message}, retry ${attempt}/${maxRetries}...`);
      await sleep(2000);
    }
  }

  throw new Error(`Failed after ${maxRetries} retries`);
}

async function harvestOAuthState(axiosInstance, log, affCode = null) {
  log('Phase 0: Harvesting OAuth state...');

  let url = `${BASE_URL}/api/gateway/oauth/state`;
  if (affCode) {
    url += `?aff=${affCode}`;
    log(`Using affiliate code: ${affCode}`);
  }

  const response = await axiosRequestWithRetry(axiosInstance, 'GET', url, {}, log);

  if (response.status !== 200) {
    throw new Error(`OAuth state failed: HTTP ${response.status} - ${JSON.stringify(response.data)}`);
  }

  const data = response.data;
  if (!data.success || !data.data) {
    throw new Error(`OAuth state failed: ${JSON.stringify(data)}`);
  }

  const oauthState = data.data;
  log(`OAuth state harvested: ${oauthState}`);

  const setCookieHeader = response.headers['set-cookie'];
  let stateCookies = '';

  if (setCookieHeader) {
    const cookieArray = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    stateCookies = cookieArray.map(cookie => cookie.split(';')[0].trim()).join('; ');
    if (stateCookies) {
      log(`Phase 0 cookies captured: ${stateCookies.substring(0, 60)}...`);
    }
  }

  return { state: oauthState, cookies: stateCookies };
}

function buildGitHubOAuthUrl(oauthState) {
  const oauthParams = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    scope: 'user:email',
    state: oauthState,
    new_signup: 'true'
  });

  const returnTo = `/login/oauth/authorize?${oauthParams.toString()}`;
  const loginParams = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    return_to: returnTo
  });

  return `https://github.com/login?${loginParams.toString()}`;
}

async function executeGitHubOAuthAndIntercept(page, account, oauthUrl, oauthState, log) {
  log('Phase 1: Starting GitHub OAuth flow (browser will complete callback)...');

  log('Navigating to GitHub OAuth URL...');
  await page.goto(oauthUrl, { waitUntil: 'networkidle2' });

  log('Filling GitHub login form...');
  const emailInput = await page.waitForSelector('input#login_field', { timeout: 15000, visible: true });
  await emailInput.click();
  await sleep(300);
  await emailInput.evaluate(el => el.value = '');
  await emailInput.type(account.email, { delay: 80 });

  const passwordInput = await page.waitForSelector('input#password', { timeout: 5000, visible: true });
  await passwordInput.click();
  await sleep(300);
  await passwordInput.evaluate(el => el.value = '');
  await passwordInput.type(account.password, { delay: 80 });

  await sleep(500);
  log('Submitting login form...');
  await page.keyboard.press('Enter');

  log('Waiting for navigation to authorization page...');
  try {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 });
  } catch (navErr) {
    log('Navigation wait timeout (continuing anyway)');
  }

  log('Waiting for authorization page...');

  // Try to find authorization button (OPTIONAL - might already be authorized)
  log('Checking for Authorize button...');
  const buttonFound = await page.waitForSelector('button[name="authorize"][value="1"]', {
    timeout: 15000,
    visible: true
  }).then(() => true).catch(() => false);

  if (buttonFound) {
    log('Authorization button found, clicking and waiting for OAuth callback...');
    await sleep(2000);

    // Click and wait for navigation to callback URL (browser will load callback page)
    try {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
        page.click('button[name="authorize"][value="1"]', { delay: 100 })
      ]);
      log('✅ Authorization completed, navigated to callback');
    } catch (err) {
      log(`Click with navigation failed: ${err.message}, trying JavaScript click...`);

      // Try JavaScript click as fallback
      try {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
          page.evaluate(() => {
            const btn = document.querySelector('button[name="authorize"][value="1"]');
            if (btn) btn.click();
          })
        ]);
        log('✅ Authorization completed via JavaScript click');
      } catch (err2) {
        log(`⚠️  All click methods failed: ${err2.message}`);
        throw new Error('Failed to complete authorization');
      }
    }
  } else {
    log('No authorization button found - assuming already authorized');
    log('Waiting for automatic redirect to callback...');

    // Wait for navigation to callback (should happen automatically if already authorized)
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
      log('✅ Automatic redirect to callback completed');
    } catch (err) {
      log(`⚠️  No automatic redirect detected: ${err.message}`);
    }
  }

  // At this point, browser should have loaded the callback page
  // Wait for page to fully process the OAuth exchange
  log('Waiting for callback page to complete OAuth exchange...');
  await sleep(3000);

  const finalUrl = page.url();
  log(`Final URL after OAuth: ${finalUrl}`);

  // Check if we ended up on an error page
  if (finalUrl.includes('/error') || finalUrl.includes('mismatch')) {
    const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
    log(`❌ OAuth flow ended on error page`);
    log(`Error page content: ${pageText.substring(0, 300)}`);
    throw new Error(`OAuth flow failed: ${pageText.substring(0, 100)}`);
  }

  // Extract all cookies from browser (includes new session cookie from OAuth)
  const cookies = await page.cookies();
  log(`Extracted ${cookies.length} cookie(s) from browser after OAuth`);

  // Convert cookies to cookie string for axios
  const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  if (!cookieString) {
    throw new Error('No cookies found in browser after OAuth flow');
  }

  log('✅ GitHub OAuth flow completed successfully!');
  log(`Session cookies: ${cookieString.substring(0, 60)}...`);
  return { cookies: cookieString };
}

async function exchangeOAuthCallback(axiosInstance, code, state, originalState, stateCookies, log) {
  log('Phase 2: Exchanging OAuth callback for session...');

  if (state !== originalState) {
    throw new Error(`State mismatch! Expected "${originalState}" but got "${state}"`);
  }

  log(`State validated: ${state}`);

  const url = `${BASE_URL}/api/gateway/oauth/github?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;

  const headers = {
    'accept': '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    'pragma': 'no-cache',
    'referer': `${BASE_URL}/oauth/github?code=${code}&state=${state}`,
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  };

  if (stateCookies) {
    headers['cookie'] = stateCookies;
    log(`Using Phase 0 cookies: ${stateCookies.substring(0, 60)}...`);
  }

  const response = await axiosRequestWithRetry(axiosInstance, 'GET', url, { headers }, log);

  // Debug logging
  log(`Exchange response status: ${response.status}`);
  log(`Exchange response headers: ${JSON.stringify(response.headers)}`);
  log(`Exchange response data: ${JSON.stringify(response.data)}`);

  if (response.status !== 200) {
    throw new Error(`OAuth callback failed: HTTP ${response.status} - ${JSON.stringify(response.data)}`);
  }

  const setCookieHeader = response.headers['set-cookie'];
  if (!setCookieHeader) {
    log(`❌ No set-cookie header found in response!`);
    log(`Available headers: ${Object.keys(response.headers).join(', ')}`);
    throw new Error('No set-cookie header in OAuth callback response');
  }

  const setCookieStr = Array.isArray(setCookieHeader) ? setCookieHeader.join('; ') : setCookieHeader;
  const sessionMatch = setCookieStr.match(/session=([^;]+)/);
  if (!sessionMatch) {
    throw new Error('No session cookie found in set-cookie header');
  }

  const sessionCookie = sessionMatch[1].trim();
  log(`Session cookie (first 30): ${sessionCookie.substring(0, 30)}...`);

  const data = response.data;
  if (!data.success || !data.data?.id) {
    throw new Error(`OAuth callback failed: ${JSON.stringify(data)}`);
  }

  const userId = data.data.id;
  log(`User ID: ${userId}`);

  return { sessionCookie, userId };
}

async function getUserInfo(axiosInstance, sessionCookie, userId, log) {
  log('Phase 2: Getting user info from session...');

  const headers = {
    'accept': '*/*',
    'cookie': sessionCookie,
    'referer': `${BASE_URL}/dashboard`,
    'content-type': 'application/json',
    'cache-control': 'no-cache',
    'pragma': 'no-cache'
  };

  // Add New-Api-User header if userId is provided
  if (userId) {
    headers['new-api-user'] = String(userId);
    log(`Including New-Api-User header: ${userId}`);
  } else {
    log('⚠️  No userId provided, making request WITHOUT New-Api-User header');
  }

  // Log exact request details for debugging
  log(`Request URL: ${BASE_URL}/api/gateway/user/self`);
  log(`Cookie header: ${sessionCookie.substring(0, 100)}...`);
  log(`All headers: ${JSON.stringify(headers, null, 2)}`);

  const response = await axiosRequestWithRetry(
    axiosInstance,
    'GET',
    `${BASE_URL}/api/gateway/user/self`,
    { headers },
    log
  );

  log(`Response status: ${response.status}`);
  log(`Response data: ${JSON.stringify(response.data)}`);

  if (response.status !== 200) {
    throw new Error(`Failed to get user info: HTTP ${response.status} - ${JSON.stringify(response.data)}`);
  }

  const data = response.data;

  if (!data.success || !data.data?.id) {
    throw new Error(`Invalid user info response: ${JSON.stringify(data)}`);
  }

  const returnedUserId = data.data.id;
  const affCode = data.data.aff_code || null;

  log(`User ID from API: ${returnedUserId}`);
  if (affCode) {
    log(`Affiliate code: ${affCode}`);
  }

  return { userId: returnedUserId, affCode };
}

function buildAuthHeaders(accessToken, sessionId, userId) {
  return {
    'authorization': `Bearer ${accessToken}`,
    'x-auth-session': sessionId,
    'new-api-user': String(userId),
    'origin': BASE_URL,
    'referer': `${BASE_URL}/api-keys`,
    'content-type': 'application/json',
    'accept': '*/*',
    'cache-control': 'no-cache',
    'pragma': 'no-cache'
  };
}

async function createToken(axiosInstance, accessToken, sessionId, userId, log) {
  log('Phase 3.1: Creating new token entry...');

  const randomName = `api_${Date.now()}`;

  const payload = {
    name: randomName,
    group: 'default',
    expired_time: -1,
    model_limits_enabled: false,
    model_limits: '',
    allow_ips: '',
    cross_group_retry: false,
    unlimited_quota: true,
    remain_quota: -1
  };

  const response = await axiosRequestWithRetry(
    axiosInstance,
    'POST',
    `${BASE_URL}/api/gateway/token/`,
    {
      headers: buildAuthHeaders(accessToken, sessionId, userId),
      data: payload
    },
    log
  );

  if (response.status !== 200) {
    throw new Error(`Token creation failed: HTTP ${response.status} - ${JSON.stringify(response.data)}`);
  }

  const data = response.data;

  if (!data.success) {
    throw new Error(`Token creation failed: ${JSON.stringify(data)}`);
  }

  log('Token created successfully (fetching ID...)');
}

async function getTokenId(axiosInstance, accessToken, sessionId, userId, log) {
  log('Phase 3.2: Fetching token list to get token ID...');

  const headers = buildAuthHeaders(accessToken, sessionId, userId);

  const response = await axiosRequestWithRetry(
    axiosInstance,
    'GET',
    `${BASE_URL}/api/gateway/token/?p=1&page_size=10`,
    { headers },
    log
  );

  if (response.status !== 200) {
    throw new Error(`Token list failed: HTTP ${response.status} - ${JSON.stringify(response.data)}`);
  }

  const data = response.data;

  if (!data.success || !data.data?.items?.length) {
    throw new Error(`Token list failed or empty: ${JSON.stringify(data)}`);
  }

  const tokenId = data.data.items[0].id;
  log(`Token ID: ${tokenId}`);

  return tokenId;
}

async function revealApiKey(axiosInstance, tokenId, accessToken, sessionId, userId, log) {
  log('Phase 3.3: Revealing API key...');

  const headers = buildAuthHeaders(accessToken, sessionId, userId);
  headers['content-length'] = '0';

  const response = await axiosRequestWithRetry(
    axiosInstance,
    'POST',
    `${BASE_URL}/api/gateway/token/${tokenId}/key`,
    {
      headers,
      data: ''
    },
    log
  );

  if (response.status !== 200) {
    throw new Error(`Key reveal failed: HTTP ${response.status} - ${JSON.stringify(response.data)}`);
  }

  const data = response.data;

  if (!data.success) {
    throw new Error(`Key reveal failed: ${JSON.stringify(data)}`);
  }

  const apiKey = data.data?.key || data.data;

  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error(`Invalid API key format: ${JSON.stringify(data)}`);
  }

  log(`API Key harvested: ${apiKey.substring(0, 20)}...`);

  return apiKey;
}

function saveApiKey(email, userId, apiKey, log) {
  ensureFileExists(RESULT_FILE);

  fs.appendFileSync(RESULT_FILE, `${email}|${userId}|${apiKey}\n`);

  log(`API key saved to ${RESULT_FILE}`);
}

async function refreshAccessToken(axiosInstance, sessionId, log) {
  log('Refreshing access token...');

  const headers = {
    'accept': '*/*',
    'accept-language': 'en-US,en;q=0.6',
    'cache-control': 'no-cache',
    'content-type': 'application/json',
    'pragma': 'no-cache',
    'priority': 'u=1, i',
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'sec-gpc': '1',
    'x-auth-session': sessionId,
    'referer': `${BASE_URL}/dashboard/keys`
  };

  const response = await axiosRequestWithRetry(
    axiosInstance,
    'POST',
    `${BASE_URL}/api/gateway/user/auth/refresh`,
    { headers },
    log
  );

  if (response.status !== 200) {
    throw new Error(`Token refresh failed: HTTP ${response.status} - ${JSON.stringify(response.data)}`);
  }

  const data = response.data;

  if (!data.success || !data.data?.access_token) {
    throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  }

  const newAccessToken = data.data.access_token;
  const newExpiresAt = data.data.access_expires_at;

  log(`✅ Access token refreshed, expires at: ${newExpiresAt}`);

  return {
    accessToken: newAccessToken,
    accessExpiresAt: newExpiresAt
  };
}

async function transferAffiliateReward(axiosInstance, accessToken, sessionId, userId, quota, log) {
  log(`Transferring affiliate reward (quota: ${quota})...`);

  const headers = {
    'accept': '*/*',
    'accept-language': 'en-US,en;q=0.6',
    'authorization': `Bearer ${accessToken}`,
    'x-auth-session': sessionId,
    'new-api-user': String(userId),
    'cache-control': 'no-cache',
    'content-type': 'application/json',
    'pragma': 'no-cache',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'referer': `${BASE_URL}/dashboard/profile`
  };

  const payload = { quota };

  const response = await axiosRequestWithRetry(
    axiosInstance,
    'POST',
    `${BASE_URL}/api/gateway/user/aff_transfer`,
    {
      headers,
      data: payload
    },
    log
  );

  if (response.status !== 200) {
    throw new Error(`Affiliate transfer failed: HTTP ${response.status} - ${JSON.stringify(response.data)}`);
  }

  const data = response.data;

  if (!data.success) {
    throw new Error(`Affiliate transfer failed: ${JSON.stringify(data)}`);
  }

  log(`✅ Affiliate reward transferred: ${quota} quota`);
  return true;
}

async function registerToRouter(userId, apiKey, log) {
  const { ok, router, error } = await createRouter(null, log);
  if (!ok) throw new Error(`Router ${error}`);

  log('Phase 4.1: Checking LivRouter provider node...');
  const providerNodeId = await router.ensureProviderNode(
    'LivRouter',
    'livrouter',
    'chat',
    'https://api.livrouter.com/v1',
    'anthropic-compatible'
  );
  log(`LivRouter provider node: ${providerNodeId}`);

  log('Phase 4.2: Registering API key to 9router...');
  await router.importProvider(
    providerNodeId,
    `Account ${userId}`,
    apiKey,
    { defaultModel: 'glm-5.2' }
  );

  log(`✅ LivRouter key for account ${userId} successfully integrated into 9router!`);
}

async function processLivRouterAccountOnce(
  account,
  browserArgsIndex,
  workerIndex,
  log,
  updateProgress,
  proxy,
  poolProxy,
  previousUserCredentials = null
) {
  const config = getConfig();
  let oauthState = null;
  let stateCookies = null;
  let accessToken = null;
  let sessionId = null;
  let userId = null;
  let apiKey = null;
  let browser = null;
  let newAffCode = null;

  const axiosInstance = createAxiosInstance(proxy, log);
  const affCode = previousUserCredentials?.affCode || null;

  try {
    await logoutSession(axiosInstance, log);

    updateProgress({ step: STEPS.LAUNCHING, email: account.email });
    log(`Launching browser for ${account.email}`);

    const browserResult = await launchBrowser(browserArgsIndex, workerIndex, null);
    browser = browserResult.browser;
    const page = browserResult.page;

    log('Browser will handle OAuth flow completely (no manual state request)...');

    updateProgress({ step: STEPS.GOOGLE_LOGIN });

    let loginUrl = `${BASE_URL}/login`;
    if (affCode) {
      loginUrl += `?aff=${affCode}`;
      log(`Navigating to /login with affiliate code: ${affCode}`);
    } else {
      log('Navigating to /login...');
    }

    await page.goto(loginUrl, { waitUntil: 'networkidle2' });
    await sleep(1000);

    log('Checking consent checkbox...');
    const consentCheckbox = await page.$('.login-reference-consent input[type="checkbox"], .login-policy-consent input[type="checkbox"]');
    if (consentCheckbox) {
      await consentCheckbox.click();
      log('✅ Consent checkbox checked');
      await sleep(500);
    } else {
      log('⚠️ Consent checkbox not found (might not be required)');
    }

    log('Looking for GitHub login button...');
    const githubButtonSelector = 'button, a, [role="button"]';
    const githubButton = await page.evaluateHandle(() => {
      const elements = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
      return elements.find(el => {
        const text = el.textContent?.toLowerCase() || '';
        const href = el.getAttribute('href') || '';
        return text.includes('github') || href.includes('github');
      });
    });

    if (!githubButton || !githubButton.asElement()) {
      throw new Error('GitHub login button not found on /login page');
    }

    log('Clicking GitHub login button (/login will generate correct state)...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
      githubButton.asElement().click()
    ]);

    log('Redirected to GitHub OAuth with /login-generated state');
    log('Filling GitHub login form...');

    const emailInput = await page.waitForSelector('input#login_field', { timeout: 15000, visible: true });
    await emailInput.click();
    await sleep(300);
    await emailInput.evaluate(el => el.value = '');
    await emailInput.type(account.email, { delay: 80 });
    log(`Email filled: ${account.email}`);

    const passwordInput = await page.waitForSelector('input#password', { timeout: 5000, visible: true });
    await passwordInput.click();
    await sleep(300);
    await passwordInput.evaluate(el => el.value = '');
    await passwordInput.type(account.password, { delay: 80 });
    log('Password filled');

    await sleep(500);
    log('Submitting GitHub login form...');
    await page.keyboard.press('Enter');

    log('Waiting for navigation after login...');
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 });
    } catch (navErr) {
      log('Navigation wait timeout (continuing anyway)');
    }

    log('Checking for authorization page...');
    const buttonFound = await page.waitForSelector('button[name="authorize"][value="1"]', {
      timeout: 15000,
      visible: true
    }).then(() => true).catch(() => false);

    if (buttonFound) {
      log('Authorization button found, clicking...');
      await sleep(2000);

      try {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
          page.click('button[name="authorize"][value="1"]', { delay: 100 })
        ]);
        log('✅ Authorization completed, navigated to callback');
      } catch (err) {
        log(`Click with navigation failed: ${err.message}, trying JavaScript click...`);

        // Try JavaScript click as fallback
        try {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
            page.evaluate(() => {
              const btn = document.querySelector('button[name="authorize"][value="1"]');
              if (btn) btn.click();
            })
          ]);
          log('✅ Authorization completed via JavaScript click');
        } catch (err2) {
          log(`⚠️  All click methods failed: ${err2.message}`);
          throw new Error('Failed to complete authorization');
        }
      }
    } else {
      log('No authorization button - assuming already authorized');
      log('Waiting for automatic redirect...');
      await sleep(3000);
    }

    log('Waiting for OAuth callback exchange to complete...');
    await sleep(2000);

    log('Waiting for redirect to dashboard with networkidle...');
    try {
      await page.waitForFunction(
        () => window.location.href.includes('/dashboard'),
        { timeout: 30000 }
      );
      log('✅ Dashboard URL detected');

      await sleep(2000);
      log('✅ Dashboard fully loaded');
    } catch (err) {
      log(`⚠️ Dashboard wait timeout: ${err.message}`);
    }

    const finalUrl = page.url();
    log(`Final URL: ${finalUrl}`);

    log('Extracting user info from localStorage...');
    const userDataStr = await page.evaluate(() => localStorage.getItem('livrouter_user')).catch(() => null);

    if (!userDataStr) {
      throw new Error('No livrouter_user found in localStorage');
    }

    const userData = JSON.parse(userDataStr);
    userId = userData.id;
    const username = userData.username;
    accessToken = userData.accessToken;
    sessionId = userData.sessionId;
    newAffCode = userData.affCode;

    log(`User ID: ${userId}`);
    log(`Username: ${username}`);
    log(`Access token: ${accessToken.substring(0, 30)}...`);
    log(`Session ID: ${sessionId}`);
    log(`Affiliate code: ${newAffCode}`);

    await sleep(config.delays.beforeBrowserClose);
    await browser.close();
    browser = null;
    log('Browser closed (credentials extracted from localStorage)');

    if (previousUserCredentials && affCode) {
      updateProgress({ step: 'Transferring affiliate reward' });
      try {
        log('Refreshing previous user token before transfer...');
        // const refreshed = await refreshAccessToken(
        //   axiosInstance,
        //   previousUserCredentials.sessionId,
        //   log
        // );
        // previousUserCredentials.accessToken = refreshed.accessToken;

        log(`Transferring affiliate reward to previous user (ID: ${previousUserCredentials.userId})...`);
        await transferAffiliateReward(
          axiosInstance,
          previousUserCredentials.accessToken,
          previousUserCredentials.sessionId,
          previousUserCredentials.userId,
          1500000,
          log
        );
      } catch (affTransferErr) {
        log(`⚠️ Affiliate transfer failed: ${affTransferErr.message}`);
      }
    }

    updateProgress({ step: STEPS.HARVESTING });

    await createToken(axiosInstance, accessToken, sessionId, userId, log);
    const tokenId = await getTokenId(axiosInstance, accessToken, sessionId, userId, log);
    apiKey = await revealApiKey(axiosInstance, tokenId, accessToken, sessionId, userId, log);
    saveApiKey(account.email, userId, apiKey, log);

    updateProgress({ step: 'Registering to 9router' });
    try {
      await registerToRouter(userId, apiKey, log);
    } catch (routerErr) {
      log(`⚠️  9router registration failed: ${routerErr.message}`);
      log('Continuing without 9router integration...');
    }

    log(`Account harvest successful: ${account.email}`);
  } catch (error) {
    log(`❌ Error in processLivRouterAccountOnce: ${error.message}`);

    if (browser) {
      log(`🔍 Keeping browser open for debugging (60 seconds)...`);
      await sleep(60000);
      log('Closing browser after debug wait...');
    }

    throw error;
  } finally {
    if (browser) {
      await browser.close().catch(() => { });
    }
  }

  return {
    userId,
    accessToken,
    sessionId,
    affCode: newAffCode
  };
}

async function processLivRouterAccount(
  account,
  browserArgsIndex,
  workerIndex,
  log,
  updateProgress,
  useProxy = true,
  previousUserCredentials = null
) {
  const config = getConfig();
  let poolProxy = null;
  let proxy = account.proxy || null;

  if (!proxy && config.proxyPoolFile && useProxy) {
    poolProxy = await acquireProxy(log, updateProgress);
    proxy = poolProxy;
  }

  try {
    const userCredentials = await processLivRouterAccountOnce(
      account,
      browserArgsIndex,
      workerIndex,
      log,
      updateProgress,
      proxy,
      poolProxy,
      previousUserCredentials
    );

    if (poolProxy) {
      releaseProxy(poolProxy);
      log(`[Proxy] Released: ${poolProxy.split(':')[0]}`);
    }

    return userCredentials;

  } catch (error) {
    if (poolProxy) {
      releaseProxy(poolProxy);
      log(`[Proxy] Released: ${poolProxy.split(':')[0]}`);
    }
    throw error;
  }
}

async function runLivRouterWorker(
  workerAccounts,
  workerId,
  browserArgsIndex,
  workerIndex,
  total,
  progress,
  log,
  useProxy = true
) {
  const config = getConfig();

  let successCount = 0;
  let failedCount = 0;
  let processedCount = 0;
  let previousUserCredentials = null;

  const accountStats = [];

  for (const account of workerAccounts) {
    const updateProgress = (payload) => {
      progress.updateWorker(workerId, {
        ...payload,
        email: account.email,
        success: successCount,
        failed: failedCount,
        current: processedCount
      });
    };

    const startTime = Date.now();
    let accountSuccess = false;
    let accountError = null;

    try {
      const userCredentials = await processLivRouterAccount(
        account,
        browserArgsIndex,
        workerIndex,
        log,
        updateProgress,
        useProxy,
        previousUserCredentials
      );

      if (userCredentials && userCredentials.affCode) {
        previousUserCredentials = userCredentials;
        log(`Credentials stored for affiliate chaining: ${userCredentials.affCode}`);
      }

      accountSuccess = true;
      successCount += 1;
      processedCount += 1;

      progress.updateWorker(workerId, {
        step: STEPS.DONE,
        email: account.email,
        success: successCount,
        failed: failedCount,
        current: processedCount
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
        email: account.email,
        success: successCount,
        failed: failedCount,
        current: processedCount
      });
    } finally {
      const duration = Date.now() - startTime;

      accountStats.push({
        email: account.email,
        rawLine: account.rawLine,
        success: accountSuccess,
        duration,
        error: accountError
      });
    }

    if (processedCount < workerAccounts.length) {
      progress.updateWorker(workerId, { step: STEPS.WAITING });
      await sleep(config.delays.betweenAccounts);
    }
  }

  progress.updateWorker(workerId, {
    step: STEPS.DONE,
    email: 'Done',
    success: successCount,
    failed: failedCount,
    current: workerAccounts.length
  });

  return {
    successCount,
    failedCount,
    accounts: accountStats,
    label: `LivRouter W${workerIndex + 1}`
  };
}

async function runLivRouterAutomation(sharedProgress = null, useProxy = true, options = {}) {
  const config = getConfig();
  const logger = createFileLogger();

  let accounts;

  if (options.mode === 'create') {
    const { runGitHubSignupAutomation } = require('../github');
    const createCount = options.createCount || 1;
    const tempEmailProvider = options.tempEmailProvider || null;

    logger.log(`Creating ${createCount} GitHub account(s) for LivRouter...`);
    const githubResult = await runGitHubSignupAutomation(createCount, sharedProgress, useProxy, tempEmailProvider);
    if (!githubResult || githubResult.successCount === 0) {
      logger.log('No GitHub accounts created, aborting LivRouter');
      logger.close();
      return null;
    }
  }

  const GITHUB_KEYS_FILE = path.join(ROOT_DIR, 'github_keys.txt');

  if (!fs.existsSync(GITHUB_KEYS_FILE)) {
    if (!sharedProgress) {
      console.log('No github_keys.txt found. Create GitHub accounts first or use existing accounts.');
    }
    logger.close();
    return null;
  }

  const lines = fs.readFileSync(GITHUB_KEYS_FILE, 'utf-8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  accounts = lines.map((rawLine) => {
    const parts = rawLine.includes(':') ? rawLine.split(':') : rawLine.split('|');
    const email = parts[0]?.trim() || '';
    const password = parts[1]?.trim() || '';
    return { email, password, username: parts[2]?.trim() || email.split('@')[0], proxy: null, rawLine };
  }).filter((a) => a.email && a.password);

  if (accounts.length === 0) {
    if (!sharedProgress) {
      console.log('No GitHub accounts found in github_keys.txt');
    }
    logger.close();
    return null;
  }

  if (!sharedProgress) {
    console.log('');
    console.log(`🔑 LivRouter automation (GitHub OAuth) — ${accounts.length} accounts`);
    console.log('');
  }

  const startedAt = Date.now();
  const chunks = accounts.length > config.browserCount
    ? Array.from({ length: config.browserCount }, (_, i) =>
      accounts.filter((_, idx) => idx % config.browserCount === i))
    : [accounts];

  const progress = sharedProgress || createProgressManager(
    `🔑 LivRouter (GitHub) — ${accounts.length} accounts, ${chunks.length} workers`
  );

  chunks.forEach((chunk, i) => {
    progress.addWorker(`livrouter-${i}`, chunk.length, `LivRouter W${i + 1}`);
  });

  const results = await Promise.all(
    chunks.map((chunk, i) => {
      const browserArgsIndex = i % config.browserArgsSets.length;

      return runLivRouterWorker(
        chunk,
        `livrouter-${i}`,
        browserArgsIndex,
        i,
        accounts.length,
        progress,
        logger.log,
        useProxy
      );
    })
  );

  if (!sharedProgress) {
    progress.stop();
  }

  const successCount = results.reduce((sum, r) => sum + r.successCount, 0);
  const failedCount = results.reduce((sum, r) => sum + r.failedCount, 0);
  const totalDuration = Date.now() - startedAt;

  if (!sharedProgress) {
    printReport('🔑 LIVROUTER AUTOMATION REPORT', results, totalDuration);
    console.log(`📄 Log: ${logger.logFile}`);
    console.log('');
  } else {
    const duration = formatDuration(totalDuration);
    logger.log(
      `LivRouter finished. Success: ${successCount}, Failed: ${failedCount}, Duration: ${duration}`
    );
  }

  logger.close();

  return { successCount, failedCount, results };
}

async function runLivRouterCreateAndImport(
  createCount = 1,
  sharedProgress = null,
  useProxy = true,
  tempEmailProvider = null
) {
  const config = getConfig();
  const logger = createFileLogger();
  const { createGitHubAccountViaPython } = require('../github');

  if (createCount <= 0) {
    if (!sharedProgress) console.log('Create count must be > 0');
    logger.close();
    return null;
  }

  if (!sharedProgress) {
    console.log('');
    console.log('LivRouter Pipeline: Create GitHub → LivRouter OAuth');
    console.log(`   Count: ${createCount}`);
    console.log('   Each success GitHub account immediately logs into LivRouter.');
    console.log('');
  }

  const startedAt = Date.now();
  const progress = sharedProgress || createProgressManager(
    `LivRouter Create+Import — ${createCount} accounts`
  );

  const workerId = 'livrouter-pipeline-0';
  progress.addWorker(workerId, createCount, 'LivRouter Pipeline');

  let successCount = 0;
  let failedCount = 0;
  let processedCount = 0;
  let previousUserCredentials = null;
  const accountStats = [];

  for (let i = 0; i < createCount; i++) {
    const updateProgress = (payload) => {
      progress.updateWorker(workerId, {
        ...payload,
        success: successCount,
        failed: failedCount,
        current: processedCount
      });
    };

    const startTime = Date.now();
    let accountEmail = `account-${i + 1}`;
    let accountSuccess = false;
    let accountError = null;
    let rawLine = `failed-${i + 1}`;

    try {
      updateProgress({
        step: STEPS.LAUNCHING,
        email: `Creating GitHub ${i + 1}/${createCount}...`
      });
      logger.log(`[Pipeline] Creating GitHub account ${i + 1}/${createCount}...`);

      const createResult = await createGitHubAccountViaPython(
        i,
        useProxy,
        logger.log,
        updateProgress,
        tempEmailProvider
      );

      if (!createResult?.success || !createResult.account) {
        throw new Error('GitHub account creation failed');
      }

      const account = {
        email: createResult.account.email,
        password: createResult.account.password,
        username: createResult.account.username,
        proxy: null,
        rawLine: `${createResult.account.email}:${createResult.account.password}:${createResult.account.username}`
      };
      accountEmail = account.email;
      rawLine = account.rawLine;

      logger.log(`[Pipeline] GitHub created: ${account.email} — starting LivRouter OAuth...`);

      updateProgress({
        step: STEPS.NAVIGATING,
        email: `LivRouter login: ${account.email}`
      });

      const userCredentials = await processLivRouterAccount(
        account,
        i % config.browserArgsSets.length,
        0,
        logger.log,
        updateProgress,
        useProxy,
        previousUserCredentials
      );

      if (userCredentials && userCredentials.affCode) {
        previousUserCredentials = userCredentials;
        logger.log(`[Pipeline] Credentials stored for affiliate chaining: ${userCredentials.affCode}`);
      }

      accountSuccess = true;
      successCount += 1;
      processedCount += 1;

      progress.updateWorker(workerId, {
        step: STEPS.DONE,
        email: account.email,
        success: successCount,
        failed: failedCount,
        current: processedCount
      });

      logger.log(`[Pipeline] SUCCESS: ${account.email} GitHub + LivRouter`);
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
        current: processedCount
      });
    } finally {
      accountStats.push({
        email: accountEmail,
        rawLine,
        success: accountSuccess,
        duration: Date.now() - startTime,
        error: accountError
      });
    }

    if (i < createCount - 1) {
      progress.updateWorker(workerId, { step: STEPS.WAITING });
      await sleep(config.delays.betweenAccounts || 10000);
    }
  }

  progress.updateWorker(workerId, {
    step: STEPS.DONE,
    email: 'Done',
    success: successCount,
    failed: failedCount,
    current: createCount
  });

  if (!sharedProgress) {
    progress.stop();
  }

  const results = [
    {
      successCount,
      failedCount,
      accounts: accountStats,
      label: 'LivRouter Pipeline'
    }
  ];
  const totalDuration = Date.now() - startedAt;

  if (!sharedProgress) {
    printReport('LIVROUTER CREATE+IMPORT REPORT', results, totalDuration);
    console.log(`Log: ${logger.logFile}`);
    console.log('');
  } else {
    logger.log(
      `LivRouter pipeline finished. Success: ${successCount}, Failed: ${failedCount}, Duration: ${formatDuration(totalDuration)}`
    );
  }

  logger.close();

  return { successCount, failedCount, results };
}

module.exports = {
  runLivRouterAutomation,
  runLivRouterCreateAndImport
};
