# Grok CLI OAuth Device-Code Flow Analysis

**Tanggal**: 2026-07-24  
**Repo**: 9router (fzrilsh fork)  
**Provider**: `grok-cli` (Grok Build / cli-chat-proxy.grok.com)  
**Error**: `invalid_grant` / `Access denied` saat polling

---

## Executive Summary

**Root Cause**: Inconsistency antara device-code generation dan polling logic.

- **Device-code generation** menganggap `grok-cli` sebagai **non-PKCE provider** (tidak kirim `code_challenge`)
- **Polling** menganggap `grok-cli` sebagai **PKCE provider** (kirim `code_verifier`)
- **xAI token endpoint** reject karena menerima `code_verifier` tanpa ada `code_challenge` di device-code request awal → `invalid_grant`

**Fix**: Tambahkan `"grok-cli"` ke array `noPkceProviders` di `src/app/api/oauth/[provider]/[action]/route.js:284`

---

## OAuth Device-Code Flow

### 1. Device Code Generation (`GET /api/oauth/grok-cli/device-code`)

**File**: `src/app/api/oauth/[provider]/[action]/route.js:141-178`

**Logic**:
```javascript
const noPkceDeviceProviders = [
  "github",
  "kimi",
  "kimi-coding",
  "kilocode",
  "codebuddy-cn",
  "codebuddy-int",
  "qoder",
  "grok-cli",  // ✅ grok-cli ADA di sini
];

if (noPkceDeviceProviders.includes(provider)) {
  deviceData = await requestDeviceCode(provider, undefined, deviceOptions); // ← TANPA code_challenge
} else {
  deviceData = await requestDeviceCode(provider, authData.codeChallenge, deviceOptions);
}
```

**Request ke xAI** (`src/lib/oauth/providers.js:274-298`):
```http
POST https://auth.x.ai/oauth2/device/code
Content-Type: application/x-www-form-urlencoded
User-Agent: grok-pager/0.2.93 grok-shell/0.2.93 (linux; x86_64)

client_id=b1a00492-073a-47ea-816f-4c329264a828
&scope=openid profile email offline_access grok-cli:access api:access conversations:read conversations:write
&referrer=grok-build
```

**Response**:
```json
{
  "device_code": "...",
  "user_code": "XXXX-XXXX",
  "verification_uri": "https://auth.x.ai/activate",
  "expires_in": 600,
  "interval": 5
}
```

**Observasi**: Tidak ada `code_challenge` dikirim → xAI tidak expect `code_verifier` saat polling.

---

### 2. Polling (`POST /api/oauth/grok-cli/poll`)

**File**: `src/app/api/oauth/[provider]/[action]/route.js:276-338`

**Logic (BUGGY)**:
```javascript
const noPkceProviders = ["github", "kimi", "kimi-coding", "kilocode", "codebuddy-cn", "codebuddy-int"];
// ❌ grok-cli TIDAK ada di sini

let result;
if (noPkceProviders.includes(provider)) {
  result = await pollForToken(provider, deviceCode, null, extraData);
} else if (provider === "kiro") {
  result = await pollForToken(provider, deviceCode, null, extraData);
} else if (provider === "qoder") {
  // ...
} else {
  // ❌ grok-cli masuk ke sini (treated as PKCE provider)
  if (!codeVerifier) {
    return NextResponse.json({ error: "Missing code verifier" }, { status: 400 });
  }
  result = await pollForToken(provider, deviceCode, codeVerifier); // ← KIRIM code_verifier
}
```

**Request ke xAI** (`src/lib/oauth/providers.js:299-330`):
```http
POST https://auth.x.ai/oauth2/token
Content-Type: application/x-www-form-urlencoded
User-Agent: grok-pager/0.2.93 grok-shell/0.2.93 (linux; x86_64)

grant_type=urn:ietf:params:oauth:grant-type:device_code
&device_code=...
&client_id=b1a00492-073a-47ea-816f-4c329264a828
&code_verifier=...  ← ❌ INI MASALAHNYA (tidak seharusnya ada)
```

**Response xAI**:
```json
{
  "error": "invalid_grant",
  "error_description": "Access denied"
}
```

**xAI menolak** karena:
- Device-code request tidak include `code_challenge` (PKCE tidak dipakai)
- Token request tiba-tiba kirim `code_verifier` (tidak matching dengan flow)
- OAuth spec: `code_verifier` hanya valid kalau ada `code_challenge` di authorization request

---

## Implementation Details

### Config (`open-sse/providers/registry/grok-cli.js`)

```javascript
export default {
  id: "grok-cli",
  oauth: {
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    deviceCodeUrl: "https://auth.x.ai/oauth2/device/code",
    tokenUrl: "https://auth.x.ai/oauth2/token",
    refreshUrl: "https://auth.x.ai/oauth2/token",
    scope: "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write",
    referrer: "grok-build",
    refreshLeadMs: 300000,
  },
};
```

### Provider Implementation (`src/lib/oauth/providers.js:271-394`)

**Device-code generation** (lines 274-298):
- Body: `client_id`, `scope`, `referrer` (no `code_challenge`)
- User-Agent: `grok-pager/0.2.93 grok-shell/0.2.93 (linux; x86_64)`

**Polling** (lines 299-330):
- Body: `grant_type`, `device_code`, `client_id` (should NOT include `code_verifier`)
- Handles `authorization_pending` dan `slow_down` sebagai pending states

**Post-exchange** (lines 331-348):
- Fetch user profile dari `https://cli-chat-proxy.grok.com/v1/user`
- Extract email dari `id_token` atau `access_token`
- Surface `expiresAt` untuk proactive refresh

---

## Bug Analysis

### Root Cause

**File**: `src/app/api/oauth/[provider]/[action]/route.js`

**Line 141-164**: Device-code generation
```javascript
const noPkceDeviceProviders = [
  // ...
  "grok-cli",  // ✅ grok-cli included
];
```

**Line 284**: Polling
```javascript
const noPkceProviders = ["github", "kimi", "kimi-coding", "kilocode", "codebuddy-cn", "codebuddy-int"];
// ❌ grok-cli MISSING
```

**Inconsistency**: Dua array berbeda untuk fase berbeda dari flow yang sama.

### Why This Wasn't Caught Earlier

1. **Commit history** menunjukkan `grok-cli` ditambahkan di `a11937c` (feat: add Grok CLI)
2. **Commit `59b7828`** (fix: align Grok Build with current subscription protocol) mengubah 13 files, 839 insertions — kemungkinan ada refactor yang split logic tapi miss sync list
3. **Issue #2734** confirm: token works initially (device-code + first poll success), lalu dies after 6h → refresh problem, bukan initial auth problem
4. **User's error** (`invalid_grant` saat polling) suggest: either re-auth after token expired, atau fresh auth attempt dengan code yang sudah di-refactor

---

## Comparison with Working Providers

### GitHub (Non-PKCE, works correctly)

**Device-code** (`src/lib/oauth/providers.js:673-693`):
- No `code_challenge` sent
- Listed in `noPkceDeviceProviders` ✅

**Polling** (`src/lib/oauth/providers.js:694-717`):
- No `code_verifier` sent
- Listed in `noPkceProviders` ✅

**Consistency**: ✅ GitHub ada di kedua list

### Qwen (PKCE, works correctly)

**Device-code**:
- `code_challenge` sent via `authData.codeChallenge`
- NOT in `noPkceDeviceProviders` ✅

**Polling**:
- `code_verifier` sent
- NOT in `noPkceProviders`, masuk else branch ✅

**Consistency**: ✅ Qwen tidak ada di kedua list

### grok-cli (BROKEN)

**Device-code**:
- No `code_challenge` sent
- Listed in `noPkceDeviceProviders` ✅

**Polling**:
- `code_verifier` sent ❌ (WRONG)
- NOT in `noPkceProviders` ❌ (WRONG)

**Consistency**: ❌ Inconsistent behavior

---

## Fix

### Primary Fix: Sync Lists

**File**: `src/app/api/oauth/[provider]/[action]/route.js`

**Line 284**, change:
```javascript
// BEFORE (BUGGY)
const noPkceProviders = ["github", "kimi", "kimi-coding", "kilocode", "codebuddy-cn", "codebuddy-int"];

// AFTER (FIXED)
const noPkceProviders = ["github", "kimi", "kimi-coding", "kilocode", "codebuddy-cn", "codebuddy-int", "grok-cli"];
```

### Why This Fix Works

1. `grok-cli` akan masuk branch `if (noPkceProviders.includes(provider))` line 286
2. Call `pollForToken(provider, deviceCode, null, extraData)` — `null` sebagai `codeVerifier`
3. `pollToken` implementation di `providers.js:299-330` tidak akan kirim `code_verifier` parameter
4. xAI token endpoint menerima request yang consistent dengan device-code request awal

---

## Additional Issues (From Upstream)

### 1. Token Never Refreshed ([#2734](https://github.com/decolua/9router/issues/2734))

**Symptom**: Token expires exactly at `expiresAt` (+6h), tidak pernah di-refresh proaktif.

**Root cause**: `grok-cli` tidak terdaftar di refresh scheduler atau refresh handler tidak dipanggil.

**Evidence**: Commit `7dfb346` "surface expiresAt so proactive refresh fires" sudah fix ini (line 377 `providers.js`), tapi issue #2734 report behavior unchanged di v0.5.35 & v0.5.40.

**Possible cause**: Refresh scheduler (`src/shared/services/tokenAutoRefresh.js` atau equivalent) tidak include `grok-cli` di provider list, atau `tokenRefresh.js` tidak punya handler untuk `grok-cli`.

**Check**:
```bash
grep -r "grok-cli" open-sse/services/tokenRefresh/ src/shared/services/
```

### 2. Refresh Uses Raw fetch() ([#2737](https://github.com/decolua/9router/issues/2737))

**Symptom**: Token refresh gagal di environment dengan proxy/firewall.

**Root cause**: `refreshXaiToken` (shared by xai + grok-cli) pakai raw `fetch()` bukan `proxyAwareFetch`.

**Impact**: User dengan proxy setup tidak bisa refresh token → manual re-auth daily.

### 3. Subscription Protocol Changes (Commit `59b7828`)

**Changes**: 13 files, 839 insertions — likely includes:
- New headers (`x-grok-client-identifier`, `x-grok-client-version`)
- New user profile fields (`hasGrokCodeAccess`, `subscriptionTier`)
- Endpoint changes (cli-chat-proxy.grok.com structure)

**Potential breaking change**: Kalau xAI mengubah OAuth client requirements (scope, audience, client registration), old device-code flow bisa invalid.

**Recommendation**: Verify client_id `b1a00492-073a-47ea-816f-4c329264a828` masih valid di xAI developer console.

---

## Testing Steps After Fix

### 1. Fresh Device-Code Flow

```bash
# Start OAuth flow
curl http://localhost:20128/api/oauth/grok-cli/device-code

# Expected response (no errors):
{
  "device_code": "...",
  "user_code": "XXXX-XXXX",
  "verification_uri": "https://auth.x.ai/activate",
  "verification_uri_complete": "https://auth.x.ai/activate?user_code=...",
  "expires_in": 600,
  "interval": 5,
  "codeVerifier": "..."  // present but will be null in poll
}
```

### 2. Authorize di Browser

Navigate ke `verification_uri`, paste `user_code`, authorize dengan xAI account.

### 3. Poll for Token

```bash
# Poll (should succeed after user authorizes)
curl -X POST http://localhost:20128/api/oauth/grok-cli/poll \
  -H "Content-Type: application/json" \
  -d '{
    "deviceCode": "<device_code_from_step_1>",
    "codeVerifier": null
  }'

# Expected response (after user authorizes):
{
  "success": true,
  "connection": {
    "id": "...",
    "provider": "grok-cli"
  }
}
```

### 4. Verify Token Works

```bash
# Test chat request
curl -X POST http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer sk-9router-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gcli/grok-4.5",
    "messages": [{"role": "user", "content": "test"}],
    "stream": false
  }'
```

### 5. Verify Refresh (After 5h 55min)

Check logs untuk refresh attempt:
```bash
tail -f ~/.9router/log.txt | grep -i "grok-cli\|token_refresh"
```

Expected: Proactive refresh before 6h expiry.

---

## Recommended Actions

### Immediate (Fix the Bug)

1. **Apply primary fix** (add `"grok-cli"` to `noPkceProviders` line 284)
2. **Test fresh OAuth flow** (device-code → poll → chat request)
3. **Commit**:
   ```bash
   git add src/app/api/oauth/[provider]/[action]/route.js
   git commit -m "fix(grok-cli): add to noPkceProviders to match device-code flow

   grok-cli uses device-code flow WITHOUT PKCE (no code_challenge sent),
   but polling logic treated it as PKCE provider and sent code_verifier.
   This causes xAI token endpoint to reject with invalid_grant.

   Fix: add grok-cli to noPkceProviders array so polling doesn't send
   code_verifier parameter (consistent with device-code request).

   Fixes bercocok-tanam invalid_grant / Access denied error."
   ```

### Short-term (Verify Refresh Works)

1. **Check refresh handler** exists for `grok-cli`:
   ```bash
   grep -n '"grok-cli"' open-sse/services/tokenRefresh.js
   ```
2. **If missing**, add handler (grok-cli shares xAI refresh endpoint):
   ```javascript
   // In tokenRefresh.js REFRESH_HANDLERS
   "grok-cli": (c, log) => refreshXaiToken(c.refreshToken, log),
   ```
3. **Verify auto-refresh scheduler** includes `grok-cli`
4. **Monitor**: Wait 5h 55min after fresh auth, confirm proactive refresh fires

### Long-term (Upstream Sync)

1. **Monitor upstream issues** #2734, #2737, #2546
2. **Pull upstream fixes** when available (refresh scheduler, proxyAwareFetch)
3. **Test subscription changes**: Verify Grok Build subscription di console.x.ai masih aktif
4. **Consider DRY refactor**: Extract `noPkceDeviceProviders` list ke shared constant untuk avoid future mismatches

---

## Appendix: Related Files

| File | Line | Purpose |
|------|------|---------|
| `src/app/api/oauth/[provider]/[action]/route.js` | 141-164 | Device-code generation route |
| `src/app/api/oauth/[provider]/[action]/route.js` | 276-338 | Polling route (BUGGY LINE 284) |
| `src/lib/oauth/providers.js` | 271-394 | grok-cli OAuth implementation |
| `open-sse/providers/registry/grok-cli.js` | 84-96 | grok-cli OAuth config |
| `open-sse/config/grokCli.js` | - | Grok CLI constants |
| `src/lib/oauth/constants/xai.js` | - | xAI OAuth constants |
| `open-sse/services/tokenRefresh.js` | - | Token refresh handlers (check if grok-cli exists) |

---

## Changelog References

| Commit | Date | Description |
|--------|------|-------------|
| `a11937c` | 2026-07-10 | feat(grok-cli): add Grok CLI / Grok Build provider with OAuth device-code flow (#2502) |
| `7dfb346` | 2026-07-11 | fix(grok-cli): surface expiresAt so proactive token refresh fires (#2546) |
| `59b7828` | 2026-07-16 | fix(grok-cli): align Grok Build with current subscription protocol (#2590) — 13 files, 839 insertions |

---

**Generated**: 2026-07-24T15:21:24Z  
**Analyzer**: opencode (membantumu-code model)
