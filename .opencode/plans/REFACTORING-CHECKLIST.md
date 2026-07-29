# 🌱 Bercocok Tanam - Refactoring Checklist

**Created**: 2026-07-29  
**Status**: 📋 Not Started  
**Progress**: 0/7 phases complete

---

## Phase 1: Extract Shared Utilities ⏸️

**Duration**: 2-3 hours | **Risk**: LOW | **Lines Saved**: ~300

### Tasks

#### 1.1 Create String Utilities Module
- [ ] Create `src/utils/string.js`
- [ ] Move `generateRandomString()` from `src/providers/email/index.js` (lines 40-47)
- [ ] Move `generateRandomString()` from `src/providers/email/gmail-helper.js` (lines 92-99)
- [ ] Export function in `src/utils/string.js`
- [ ] Add to `src/utils/index.js` exports (optional)
- **Estimated**: 20 min

#### 1.2 Create Browser Helpers Module
- [ ] Create `src/browser/helpers.js`
- [ ] Move `clearBrowserCookies()` from `src/providers/router/index.js` (lines 220-225)
- [ ] Move `clearBrowserCookies()` from `src/automations/grok/utils.js` (lines 71-76)
- [ ] Move `fillInput()` from `src/automations/grok/utils.js` (lines 84-97)
- [ ] Move `clickText()` from `src/automations/grok/utils.js` (lines 99-117)
- [ ] Move `tryClickText()` from `src/automations/grok/utils.js` (lines 119-132)
- [ ] Move `tryClickText()` from `src/providers/router/index.js` (lines 198-214)
- [ ] Move `getAllCookies()` from `src/automations/grok/utils.js` (lines 78-82)
- [ ] Move `hardenPage()` from `src/automations/grok/utils.js` (lines 55-69)
- [ ] Move `pageLooksBlocked()` from `src/automations/grok/utils.js` (lines 134-152)
- [ ] Move `findChrome()` from `src/automations/grok/utils.js` (lines 4-19) to `src/browser/index.js`
- [ ] Move `clickSelector()` from `src/providers/google/login.js`
- [ ] Move `typeIntoSelector()` from `src/providers/google/login.js`
- [ ] Move `clickFirstVisibleSelector()` from `src/providers/google/login.js`
- [ ] Export all functions in `src/browser/helpers.js`
- **Estimated**: 60 min (updated from 45 min due to grok/utils.js additions)

#### 1.3 Consolidate sleep() Usage
- [ ] Remove `sleep()` from `src/providers/router/index.js` (lines 216-218)
- [ ] Update imports in `src/providers/router/index.js` to use `src/utils/index.js`
- [ ] Remove `sleep()` from `src/automations/grok/utils.js` (lines 154-156)
- [ ] Update imports in `src/automations/grok/index.js` to use `src/utils/index.js`
- [ ] Verify all other files import from `src/utils/index.js`
- **Estimated**: 15 min

#### 1.4 Consolidate randomUA() Usage
- [ ] Remove `randomUA()` from `src/providers/email/index.js` (lines 49-56)
- [ ] Update imports in `src/providers/email/index.js` to use `src/utils/index.js`
- [ ] Verify comprehensive UA pool (60+ UAs) from utils is used
- **Estimated**: 10 min

#### 1.5 Update All Imports
- [ ] Update `src/providers/router/index.js` imports
- [ ] Update `src/automations/grok/index.js` imports
- [ ] Update `src/automations/grok/utils.js` imports
- [ ] Update `src/providers/email/index.js` imports
- [ ] Update `src/providers/email/gmail-helper.js` imports
- [ ] Update `src/providers/google/login.js` imports
- [ ] Search codebase for any other usages
- **Estimated**: 30 min

#### 1.6 Validation
- [ ] Run `npm run lint` - should pass
- [ ] Manual test: Kiro automation (1 account)
- [ ] Manual test: Grok automation (1 account)
- [ ] Manual test: Router import (1 account)
- [ ] Verify browser interactions work
- **Estimated**: 30 min

**Total Estimated**: 2.75 hours (updated from 2.5 hours)

**Note**: SHARED_SELECTORS in `config/index.js` is already properly shared across automations via imports. No changes needed.

---

## Phase 2: Create HTTP Client Module ⏸️

**Duration**: 3-4 hours | **Risk**: MEDIUM | **Lines Saved**: ~150

### Tasks

#### 2.1 Create Shared HTTP Client
- [ ] Create `src/automations/shared/` directory
- [ ] Create `src/automations/shared/http-client.js`
- [ ] Extract `createAxiosInstance()` from `src/automations/tokengo/index.js`
- [ ] Extract `buildStealthHeaders()` from `src/automations/tokengo/index.js`
- [ ] Extract `axiosRequestWithRetry()` from `src/automations/tokengo/index.js`
- [ ] Consolidate with similar functions from `src/automations/livrouter/index.js`
- [ ] Export all functions
- [ ] Add JSDoc comments
- **Estimated**: 60 min

#### 2.2 Refactor TokenGo Automation
- [ ] Update `src/automations/tokengo/index.js` imports
- [ ] Remove duplicated HTTP client functions
- [ ] Update function calls to use shared module
- [ ] Verify proxy parameter passing
- [ ] Verify retry logic unchanged
- **Estimated**: 45 min

#### 2.3 Refactor LivRouter Automation
- [ ] Update `src/automations/livrouter/index.js` imports
- [ ] Remove duplicated HTTP client functions
- [ ] Update function calls to use shared module
- [ ] Verify proxy parameter passing
- [ ] Verify retry logic unchanged
- **Estimated**: 45 min

#### 2.4 Validation
- [ ] Run `npm run lint` - should pass
- [ ] Manual test: TokenGo automation (1 account)
- [ ] Manual test: TokenGo with proxy pool
- [ ] Test TokenGo retry logic (simulate 429 if possible)
- [ ] Manual test: LivRouter automation (1 account)
- [ ] Manual test: LivRouter with proxy pool
- [ ] Verify output files format unchanged
- **Estimated**: 60 min

**Total Estimated**: 3.5 hours

---

## Phase 3: Create OAuth Utilities ⏸️

**Duration**: 4-5 hours | **Risk**: MEDIUM | **Lines Saved**: ~200

### Tasks

#### 3.1 Create OAuth Module
- [ ] Create `src/automations/shared/oauth.js`
- [ ] Define base `OAuthStrategy` class
- [ ] Implement `GitHubOAuthStrategy` class
- [ ] Extract common OAuth flow from TokenGo
- [ ] Extract common OAuth flow from LivRouter
- [ ] Consolidate state management
- [ ] Consolidate browser interception logic
- [ ] Consolidate callback exchange
- [ ] Export strategies
- **Estimated**: 90 min

#### 3.2 Refactor TokenGo OAuth
- [ ] Update `src/automations/tokengo/index.js` imports
- [ ] Remove `harvestOAuthState()` function
- [ ] Remove `buildGitHubOAuthUrl()` function
- [ ] Remove `executeGitHubOAuthAndIntercept()` function
- [ ] Remove `exchangeOAuthCallback()` function
- [ ] Use `GitHubOAuthStrategy` from shared
- [ ] Verify OAuth flow unchanged
- **Estimated**: 60 min

#### 3.3 Refactor LivRouter OAuth
- [ ] Update `src/automations/livrouter/index.js` imports
- [ ] Remove duplicated OAuth functions
- [ ] Use `GitHubOAuthStrategy` from shared
- [ ] Keep affiliate chain logic (service-specific)
- [ ] Verify OAuth flow unchanged
- **Estimated**: 60 min

#### 3.4 Refactor Codebuddy OAuth (if applicable)
- [ ] Review `src/automations/codebuddy/index.js` OAuth implementation
- [ ] Standardize to use `GitHubOAuthStrategy` if similar
- [ ] Or document why it's different
- **Estimated**: 30 min

#### 3.5 Validation
- [ ] Run `npm run lint` - should pass
- [ ] Manual test: TokenGo GitHub OAuth (1 account)
- [ ] Manual test: LivRouter GitHub OAuth (1 account)
- [ ] Manual test: Codebuddy GitHub OAuth (1 account)
- [ ] Verify state management correct
- [ ] Verify callback interception works
- [ ] Check error handling for OAuth failures
- **Estimated**: 60 min

**Total Estimated**: 5 hours

---

## Phase 4: Extract Base Worker ⏸️

**Duration**: 6-8 hours | **Risk**: HIGH | **Lines Saved**: ~600-720

### Tasks

#### 4.1 Create Base Worker Class
- [ ] Create `src/automations/base/` directory
- [ ] Create `src/automations/base/BaseWorker.js`
- [ ] Implement template method `run()`
- [ ] Implement queue management logic
- [ ] Implement account locking logic
- [ ] Implement progress tracking
- [ ] Implement stats collection
- [ ] Define abstract `processAccount()` method
- [ ] Define hooks: `onSuccess()`, `onFailure()`
- [ ] Add JSDoc comments
- **Estimated**: 90 min

#### 4.2 Migrate Kiro Automation (First)
- [ ] Create `KiroWorker` class extending `BaseWorker`
- [ ] Implement `processAccount()` with Kiro-specific logic
- [ ] Update `runKiroAutomation()` to use `KiroWorker`
- [ ] Remove old worker function
- [ ] Test thoroughly before proceeding
- **Estimated**: 60 min

#### 4.3 Validate Kiro Migration
- [ ] Run `npm run lint`
- [ ] Test with 1 account (success case)
- [ ] Test with invalid account (error handling)
- [ ] Test with proxy pool
- [ ] Test with BROWSER_COUNT=1, 2, 4
- [ ] Test retry mechanism
- [ ] Compare output with original implementation
- [ ] If all tests pass, proceed to next migration
- **Estimated**: 60 min

#### 4.4 Migrate Cloudflare Automation
- [ ] Create `CloudflareWorker` class extending `BaseWorker`
- [ ] Implement `processAccount()` with Cloudflare-specific logic
- [ ] Update main function to use `CloudflareWorker`
- [ ] Test thoroughly
- **Estimated**: 45 min

#### 4.5 Migrate Proxy Automation
- [ ] Create `ProxyWorker` class extending `BaseWorker`
- [ ] Implement `processAccount()` with Proxy-specific logic
- [ ] Update main function to use `ProxyWorker`
- [ ] Test thoroughly
- **Estimated**: 45 min

#### 4.6 Migrate TokenGo Automation
- [ ] Create `TokenGoWorker` class extending `BaseWorker`
- [ ] Implement `processAccount()` with TokenGo-specific logic
- [ ] Update main function to use `TokenGoWorker`
- [ ] Test thoroughly (especially proxy rotation on 429)
- **Estimated**: 60 min

#### 4.7 Migrate LivRouter Automation
- [ ] Create `LivRouterWorker` class extending `BaseWorker`
- [ ] Implement `processAccount()` with LivRouter-specific logic
- [ ] Update main function to use `LivRouterWorker`
- [ ] Test thoroughly
- **Estimated**: 60 min

#### 4.8 Migrate Codebuddy Automation
- [ ] Create `CodebuddyWorker` class extending `BaseWorker`
- [ ] Implement `processAccount()` with Codebuddy-specific logic
- [ ] Update main function to use `CodebuddyWorker`
- [ ] Test thoroughly
- **Estimated**: 60 min

#### 4.9 Final Validation
- [ ] Run `npm run lint` on all modified files
- [ ] Test all 6 automations individually
- [ ] Test all-in-one mode with multiple automations
- [ ] Verify all output files correct
- [ ] Check error logging works
- **Estimated**: 60 min

**Total Estimated**: 7.5 hours

**Note on GitHub Automation**:
- GitHub uses subprocess pattern (spawns Python), not browser pattern like other automations
- BaseWorker may not fully apply - consider these options:
  1. Create SubprocessWorker variant of BaseWorker for process management
  2. Skip GitHub in Phase 4, keep current implementation as-is
  3. Extract only common worker logic that applies (queue, locking, stats)
- Decision point: Evaluate during Phase 4 after BaseWorker implementation complete

---

## Phase 5: Extract Base Automation ⏸️

**Duration**: 6-8 hours | **Risk**: HIGH | **Lines Saved**: ~640

### Tasks

#### 5.1 Create Base Automation Class
- [ ] Create `src/automations/base/BaseAutomation.js`
- [ ] Implement common automation flow
- [ ] Define abstract methods: `readAccounts()`, `createWorker()`, `getAutomationName()`
- [ ] Implement logger setup
- [ ] Implement chunking logic
- [ ] Implement worker spawning
- [ ] Implement results aggregation
- [ ] Implement report generation
- [ ] Support shared vs standalone progress
- [ ] Add JSDoc comments
- **Estimated**: 90 min

#### 5.2 Migrate Kiro Automation (First)
- [ ] Create `KiroAutomation` class extending `BaseAutomation`
- [ ] Implement required abstract methods
- [ ] Update `runKiroAutomation()` to use class
- [ ] Remove old automation flow code
- [ ] Test thoroughly
- **Estimated**: 45 min

#### 5.3 Validate Kiro Migration
- [ ] Run `npm run lint`
- [ ] Test standalone mode
- [ ] Test shared progress mode
- [ ] Test report generation
- [ ] Verify log files created
- [ ] If all tests pass, proceed
- **Estimated**: 30 min

#### 5.4 Migrate Remaining Automations
- [ ] Migrate Cloudflare automation
- [ ] Test Cloudflare thoroughly
- [ ] Migrate Proxy automation
- [ ] Test Proxy thoroughly
- [ ] Migrate TokenGo automation
- [ ] Test TokenGo thoroughly
- [ ] Migrate LivRouter automation
- [ ] Test LivRouter thoroughly
- [ ] Migrate Codebuddy automation
- [ ] Test Codebuddy thoroughly
- [ ] Migrate Grok automation
- [ ] Test Grok thoroughly
- [ ] Migrate GitHub automation
- [ ] Test GitHub thoroughly
- **Estimated**: 5 hours (40 min per automation)

#### 5.5 Final Validation
- [ ] Run `npm run lint` on all files
- [ ] Test all 8 automations individually
- [ ] Test various combinations in all-in-one mode
- [ ] Test with different BROWSER_COUNT values
- [ ] Verify all reports generated correctly
- [ ] Check all log files created
- **Estimated**: 90 min

**Total Estimated**: 8 hours

---

## Phase 6: Consolidate Provider Patterns ⏸️

**Duration**: 4-5 hours | **Risk**: MEDIUM | **Lines Saved**: ~200

### Tasks

#### 6.1 Consolidate Email Provider Matchers
- [ ] Review matchers in `src/providers/email/index.js` (lines 536-575)
- [ ] Review matchers in `src/providers/email/gmail-helper.js` (lines 243-283)
- [ ] Identify duplicated logic
- [ ] Keep matchers in `email/index.js` only
- [ ] Update `gmail-helper.js` to import from `index.js`
- [ ] Remove `waitForGitHubOTP()` duplication
- [ ] Remove `waitForGitHubDeviceOTP()` duplication
- [ ] Remove `waitForEmail()` duplication
- **Estimated**: 60 min

#### 6.2 Separate Router HTTP Client
- [ ] Create `src/providers/router/client.js`
- [ ] Move `NineRouter` class (lines 3-142 from router/index.js)
- [ ] Keep only HTTP API methods
- [ ] Export `NineRouter` class
- [ ] Add JSDoc comments
- **Estimated**: 30 min

#### 6.3 Create OAuth Service
- [ ] Create `src/providers/router/oauth-service.js`
- [ ] Move `addAccountToRouter()` (lines 227-382 from router/index.js)
- [ ] Move OAuth device flow logic
- [ ] Keep high-level orchestration
- [ ] Export OAuth functions
- **Estimated**: 45 min

#### 6.4 Move Router Browser Helpers
- [ ] Move `tryClickText()` from router to `src/browser/helpers.js`
- [ ] Move `clearBrowserCookies()` if not already moved
- [ ] Update router imports
- **Estimated**: 15 min

#### 6.5 Refactor Router Index
- [ ] Update `src/providers/router/index.js`
- [ ] Import from `client.js` and `oauth-service.js`
- [ ] Keep `createRouter()` as main export
- [ ] Keep `expandSsoCookies()` (cookie utility)
- [ ] Orchestrate client + oauth-service
- **Estimated**: 30 min

#### 6.6 Document Provider Interface
- [ ] Create `docs/PROVIDER-INTERFACE.md`
- [ ] Document standard provider contract
- [ ] Document `init()`, `authenticate()`, `cleanup()` pattern
- [ ] Add examples for email providers
- [ ] Add examples for router provider
- **Estimated**: 45 min

#### 6.7 Validation
- [ ] Run `npm run lint`
- [ ] Test Gmail email provider (OTP reading)
- [ ] Test Mail.cx provider
- [ ] Test ncaori provider
- [ ] Test 1secemail provider
- [ ] Test router import functionality
- [ ] Test OAuth device flow
- [ ] Verify all matchers work
- **Estimated**: 60 min

**Total Estimated**: 4.5 hours

---

## Phase 7: Create Browser Helpers Module ⏸️

**Duration**: 2-3 hours | **Risk**: LOW | **Lines Saved**: ~100

### Tasks

#### 7.1 Verify Browser Helpers Consolidated
- [ ] Check `src/browser/helpers.js` exists
- [ ] Verify all functions from Phase 1 are there
- [ ] Check for any remaining helpers in other files
- [ ] Move any stragglers to `helpers.js`
- **Estimated**: 30 min

#### 7.2 Update Browser Index
- [ ] Edit `src/browser/index.js`
- [ ] Import helpers from `helpers.js`
- [ ] Re-export helpers for convenience
- [ ] Keep `launchBrowser()` as main export
- [ ] Add JSDoc comments
- **Estimated**: 15 min

#### 7.3 Standardize Imports Across Codebase
- [ ] Search for browser helper imports across all files
- [ ] Update to use `require('../../browser')` or `require('../../browser/helpers')`
- [ ] Remove any local helper function duplicates
- [ ] Ensure consistent import patterns
- **Estimated**: 45 min

#### 7.4 Validation
- [ ] Run `npm run lint`
- [ ] Test Grok automation (uses most browser helpers)
- [ ] Test Kiro automation (uses some helpers)
- [ ] Test all automations individually
- [ ] Verify browser interactions work correctly
- **Estimated**: 60 min

**Total Estimated**: 2.5 hours

---

## Summary & Final Steps

### Total Progress Tracking

**Phases Completed**: 0 / 7
- [ ] Phase 1: Extract Shared Utilities (2-3 hours)
- [ ] Phase 2: Create HTTP Client Module (3-4 hours)
- [ ] Phase 3: Create OAuth Utilities (4-5 hours)
- [ ] Phase 4: Extract Base Worker (6-8 hours)
- [ ] Phase 5: Extract Base Automation (6-8 hours)
- [ ] Phase 6: Consolidate Provider Patterns (4-5 hours)
- [ ] Phase 7: Create Browser Helpers Module (2-3 hours)

**Total Estimated Time**: 27-36 hours

### Final Validation Checklist

After all phases complete:
- [ ] Run `npm run lint` - no errors
- [ ] Run all automations individually
  - [ ] Kiro automation
  - [ ] Cloudflare automation
  - [ ] Proxy automation
  - [ ] TokenGo automation
  - [ ] LivRouter automation
  - [ ] Codebuddy automation
  - [ ] Grok automation
  - [ ] GitHub automation
- [ ] Run all-in-one mode with 2 automations
- [ ] Run all-in-one mode with 4+ automations
- [ ] Test with `BROWSER_COUNT=1`
- [ ] Test with `BROWSER_COUNT=4`
- [ ] Test with proxy pool enabled
- [ ] Test with proxy pool disabled
- [ ] Test headless=true mode
- [ ] Test headless=false mode
- [ ] Verify all output files generated correctly
- [ ] Verify error logging works
- [ ] Check log files created properly
- [ ] Compare line count: before vs after
- [ ] Document actual time spent per phase
- [ ] Update this checklist with lessons learned

### Success Criteria

- [ ] Total automation code reduced by ~35-40%
- [ ] Code duplication < 10%
- [ ] All existing automations work correctly
- [ ] All tests pass
- [ ] ESLint passes with no errors
- [ ] Documentation updated

---

**Created**: 2026-07-29  
**Last Updated**: 2026-07-29  
**Checklist Version**: 1.0
