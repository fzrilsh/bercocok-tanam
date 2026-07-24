# Project Restructure Plan

**Date**: 2026-07-24  
**Current Status**: All source files flat in `src/` (22 files)  
**Goal**: Organized structure by domain/functionality

---

## Current Issues

1. **Flat structure** - 22 files di `src/` tanpa grouping
2. **Hard to navigate** - Automation files campur dengan utilities
3. **Poor discoverability** - Sulit cari file terkait satu automation
4. **No separation of concerns** - Config, helpers, automations, CLI semua campur
5. **Scalability problem** - Tambah automation = tambah file di root level
6. **Related files scattered** - e.g., grok.js, grok-utils.js, seal-crypto.js, seal-turnstile.js terpisah

---

## Proposed Structure

```
bercocok-tanam/
├── src/
│   ├── automations/              # Domain: Account automation implementations
│   │   ├── kiro/
│   │   │   ├── index.js          # Main automation logic (current kiro.js)
│   │   │   └── README.md         # Automation-specific docs
│   │   ├── cloudflare/
│   │   │   ├── index.js          # Main automation logic (current cloudflare.js)
│   │   │   └── README.md
│   │   ├── codebuddy/
│   │   │   ├── index.js          # Main automation logic (current codebuddy.js)
│   │   │   └── README.md
│   │   ├── tokengo/
│   │   │   ├── index.js          # Main automation logic (current tokengo.js)
│   │   │   └── README.md
│   │   ├── grok/
│   │   │   ├── index.js          # Main automation logic (current grok.js)
│   │   │   ├── utils.js          # Grok-specific utilities (current grok-utils.js)
│   │   │   ├── seal.js           # Turnstile integration (merge seal-crypto.js + seal-turnstile.js)
│   │   │   └── README.md
│   │   ├── github/
│   │   │   ├── index.js          # Node.js wrapper (current github-signup-python.js)
│   │   │   ├── signup.py         # Python automation (current github_signup.py)
│   │   │   └── README.md
│   │   └── proxy/
│   │       ├── index.js          # Proxy automation (current proxy.js)
│   │       └── README.md
│   │
│   ├── providers/                # Domain: External service integrations
│   │   ├── email/
│   │   │   ├── index.js          # Main temp email helper (current temp-email-helper.js)
│   │   │   ├── gmail.js          # Gmail provider (current gmail-helper.js + gmail-otp-cli.js)
│   │   │   ├── mailcx.js         # Mail.cx provider
│   │   │   ├── ncaori.js         # ncaori provider
│   │   │   └── 1secemail.js      # 1secemail provider
│   │   ├── router/
│   │   │   └── index.js          # 9Router integration (current 9router-helper.js)
│   │   └── google/
│   │       └── login.js          # Google authentication (current google-login.js)
│   │
│   ├── browser/                  # Domain: Browser automation utilities
│   │   └── index.js              # Browser launching + stealth (current browser.js)
│   │
│   ├── cli/                      # Domain: CLI interface
│   │   ├── menu.js               # Interactive menu (extract from index.js)
│   │   ├── progress.js           # Progress bars (current progress.js)
│   │   ├── reporter.js           # Report generation (current reporter.js)
│   │   └── settings.js           # Settings menu (current settings.js)
│   │
│   ├── config/                   # Domain: Configuration management
│   │   └── index.js              # Config loader (current config.js)
│   │
│   └── shared/                   # Domain: Shared utilities
│       └── utils.js              # Common utilities (current utils.js)
│
├── scripts/                      # Python scripts and external tools
│   └── github/
│       └── signup.py             # Moved from src/
│
├── output/                       # All generated output files
│   ├── keys/                     # Token/key files
│   │   ├── kiro_keys.txt
│   │   ├── cloudflare_keys.txt
│   │   ├── codebuddy_keys.txt
│   │   ├── tokengo_keys.txt
│   │   ├── grok_keys.txt
│   │   └── github_keys.txt
│   ├── errors/
│   │   └── errorAccounts.txt
│   └── logs/                     # Moved from root
│       └── *.log
│
├── docs/                         # Documentation
│   ├── GROK-CLI-OAUTH-ANALYSIS.md  # Moved from root
│   ├── RESTRUCTURE-PLAN.md         # This file
│   └── automations/                # Per-automation guides
│       ├── kiro.md
│       ├── grok.md
│       └── github.md
│
├── venv/                         # Python virtual environment
├── assets/                       # Static assets
│   └── screenshot.png
│
├── index.js                      # Main entry point (simplified)
├── accounts.txt                  # Input accounts
├── proxy_keys.txt                # Proxy pool (optional)
├── .env                          # User config
├── .env.example                  # Config template
├── .gitignore
├── package.json
├── eslint.config.js
├── LICENSE
└── README.md
```

---

## Benefits

### 1. **Clear Separation of Concerns**
- **Automations** (`src/automations/`): Semua automation logic terisolasi
- **Providers** (`src/providers/`): External service integrations
- **CLI** (`src/cli/`): User interface code
- **Config** (`src/config/`): Configuration management
- **Shared** (`src/shared/`): Reusable utilities

### 2. **Better Discoverability**
```bash
# Want to work on Grok automation?
cd src/automations/grok/

# Everything related to Grok in one place:
- index.js       # Main logic
- utils.js       # Grok-specific utilities
- seal.js        # Turnstile integration
- README.md      # Documentation
```

### 3. **Easier Testing**
```javascript
// Before (flat structure):
import { processGrokAccount } from '../../src/grok.js';
import { resolveTurnstileExt } from '../../src/seal-turnstile.js';
import { launchChrome } from '../../src/grok-utils.js';

// After (structured):
import Grok from '../../src/automations/grok/index.js';
// or test the whole module
```

### 4. **Cleaner Imports**
```javascript
// Before:
const { createTempEmail } = require('./temp-email-helper');
const { readInboxMetadata } = require('./gmail-helper');
const { addAccountToRouter } = require('./9router-helper');
const { launchBrowser } = require('./browser');

// After:
const Email = require('./providers/email');
const Router = require('./providers/router');
const Browser = require('./browser');
```

### 5. **Output Organization**
```bash
# Before (root pollution):
kiro_keys.txt
cloudflare_keys.txt
tokengo_keys.txt
grok_keys.txt
github_keys.txt
errorAccounts.txt
logs/

# After (organized):
output/
  keys/
    kiro_keys.txt
    cloudflare_keys.txt
    ...
  errors/
    errorAccounts.txt
  logs/
    2026-07-24.log
```

### 6. **Documentation Co-location**
```
src/automations/grok/
├── index.js
├── utils.js
├── seal.js
└── README.md      # Grok-specific setup, troubleshooting, etc.

docs/
├── GROK-CLI-OAUTH-ANALYSIS.md  # Deep technical analysis
└── automations/
    └── grok.md                  # User-facing guide
```

---

## Migration Plan

### Phase 1: Preparation (No Breaking Changes)
**Duration**: 1-2 hours  
**Risk**: Low

1. **Create new directory structure**
   ```bash
   mkdir -p src/{automations/{kiro,cloudflare,codebuddy,tokengo,grok,github,proxy},providers/{email,router,google},browser,cli,config,shared}
   mkdir -p scripts/github
   mkdir -p output/{keys,errors,logs}
   mkdir -p docs/automations
   ```

2. **Create index.js files with re-exports** (temporary compatibility layer)
   ```javascript
   // src/automations/kiro/index.js
   module.exports = require('../../kiro');  // Temporary re-export
   
   // Later akan diganti dengan actual implementation
   ```

3. **Update .gitignore**
   ```
   # Output files
   /output/keys/*.txt
   /output/errors/*.txt
   /output/logs/*.log
   
   # Keep structure
   !/output/keys/.gitkeep
   !/output/errors/.gitkeep
   !/output/logs/.gitkeep
   ```

### Phase 2: Move Automations (One at a time)
**Duration**: 3-4 hours  
**Risk**: Medium

**Order of migration** (simplest first):
1. ✅ **proxy** (standalone, simple)
2. ✅ **kiro** (standalone, no dependencies)
3. ✅ **cloudflare** (standalone)
4. ✅ **codebuddy** (standalone)
5. ✅ **tokengo** (standalone)
6. ⚠️ **grok** (has related files: grok-utils.js, seal-*.js)
7. ⚠️ **github** (has Python script)

**Per automation steps:**
```bash
# Example: Moving Kiro
1. cp src/kiro.js src/automations/kiro/index.js
2. Update imports in src/automations/kiro/index.js
   - Adjust relative paths (../../providers/router vs ../9router-helper)
3. Update index.js to import from new location
4. Test: npm start → Kiro automation
5. If OK: rm src/kiro.js
6. Commit: "refactor(kiro): move to src/automations/kiro/"
```

### Phase 3: Move Providers
**Duration**: 2-3 hours  
**Risk**: Medium-High (banyak dependencies)

**Order**:
1. ✅ **9router-helper** → `src/providers/router/index.js`
2. ✅ **google-login** → `src/providers/google/login.js`
3. ⚠️ **Email providers** (complex, many files):
   - temp-email-helper.js → `src/providers/email/index.js`
   - gmail-helper.js + gmail-otp-cli.js → `src/providers/email/gmail.js`
   - Extract provider-specific code to separate files

**Email provider consolidation**:
```javascript
// src/providers/email/index.js
const gmail = require('./gmail');
const mailcx = require('./mailcx');
const ncaori = require('./ncaori');
const onesecemail = require('./1secemail');

async function createTempEmail(accountIndex, log, provider = 'auto') {
  if (provider === 'gmail') return gmail.create(accountIndex, log);
  if (provider === 'mailcx') return mailcx.create(accountIndex, log);
  // ...
}

module.exports = { createTempEmail };
```

### Phase 4: Move CLI & Utilities
**Duration**: 1-2 hours  
**Risk**: Low

```bash
# Move CLI files
mv src/progress.js src/cli/progress.js
mv src/reporter.js src/cli/reporter.js
mv src/settings.js src/cli/settings.js

# Extract menu from index.js → src/cli/menu.js

# Move utilities
mv src/browser.js src/browser/index.js
mv src/utils.js src/shared/utils.js
mv src/config.js src/config/index.js
```

### Phase 5: Update Output Paths
**Duration**: 1 hour  
**Risk**: Medium (file path changes)

**Update config.js**:
```javascript
// Before:
RESULT_FILE="{provider}_keys.txt"
ERROR_ACCOUNT_FILE="errorAccounts.txt"

// After:
RESULT_FILE="output/keys/{provider}_keys.txt"
ERROR_ACCOUNT_FILE="output/errors/errorAccounts.txt"
```

**Create output directories on startup**:
```javascript
// src/config/index.js
const fs = require('fs');
const { mkdirSync } = fs;

function ensureOutputDirs() {
  mkdirSync('output/keys', { recursive: true });
  mkdirSync('output/errors', { recursive: true });
  mkdirSync('output/logs', { recursive: true });
}
```

### Phase 6: Move Documentation
**Duration**: 30 mins  
**Risk**: None

```bash
mv GROK-CLI-OAUTH-ANALYSIS.md docs/
mv RESTRUCTURE-PLAN.md docs/

# Create per-automation README
touch src/automations/{kiro,cloudflare,codebuddy,tokengo,grok,github,proxy}/README.md
```

### Phase 7: Update README & Cleanup
**Duration**: 1 hour  
**Risk**: Low

1. Update README.md project structure section
2. Update all documentation references to new paths
3. Remove old files
4. Run full test suite
5. Update .env.example if needed

---

## Testing Strategy

### After Each Phase

```bash
# 1. Lint check
npm run lint

# 2. Build check (if applicable)
npm run build

# 3. Manual test each automation
npm start
# → Select automation
# → Verify it runs without import errors

# 4. Check output files
ls -la output/keys/
ls -la output/errors/

# 5. Git status (verify no unexpected changes)
git status
```

### Final Integration Test

```bash
# Test all automations in sequence
1. Run Kiro automation → Check kiro_keys.txt generated
2. Run Cloudflare automation → Check cloudflare_keys.txt
3. Run Codebuddy automation → Check codebuddy_keys.txt
4. Run TokenGo automation → Check tokengo_keys.txt
5. Run Grok automation → Check grok_keys.txt
6. Run GitHub automation → Check github_keys.txt
7. Check errorAccounts.txt for any failures

# Test CLI features
8. Test Settings menu
9. Test proxy pool loading
10. Test account file changes detection
```

---

## Rollback Plan

**If restructure causes major issues:**

```bash
# Revert to last working commit
git log --oneline -10  # Find last commit before restructure
git reset --hard <commit-hash>

# Or revert specific phases
git revert <phase-commit> --no-commit
git commit -m "revert: rollback Phase X due to issues"
```

**Prevention:**
- Commit after each phase with clear messages
- Tag stable points: `git tag -a v1.0-pre-restructure -m "Before restructure"`
- Keep old structure working until new structure fully tested

---

## Breaking Changes

### For Users

**⚠️ Output file paths change:**
```bash
# Before:
kiro_keys.txt
errorAccounts.txt

# After:
output/keys/kiro_keys.txt
output/errors/errorAccounts.txt
```

**Migration for existing users:**
```bash
# Move existing output files
mkdir -p output/{keys,errors}
mv *_keys.txt output/keys/ 2>/dev/null || true
mv errorAccounts.txt output/errors/ 2>/dev/null || true
```

### For Contributors

**⚠️ Import paths change:**
```javascript
// Before:
const { processKiroAccount } = require('./src/kiro');

// After:
const Kiro = require('./src/automations/kiro');
```

**⚠️ Test paths change:**
```javascript
// Before:
import grok from '../src/grok.js';

// After:
import grok from '../src/automations/grok/index.js';
```

---

## Timeline

| Phase | Duration | Priority | Risk |
|-------|----------|----------|------|
| Phase 1: Preparation | 1-2h | High | Low |
| Phase 2: Move Automations | 3-4h | High | Medium |
| Phase 3: Move Providers | 2-3h | High | Medium-High |
| Phase 4: Move CLI & Utils | 1-2h | Medium | Low |
| Phase 5: Update Output Paths | 1h | Medium | Medium |
| Phase 6: Move Docs | 0.5h | Low | None |
| Phase 7: Update README | 1h | High | Low |
| **Total** | **10-13.5h** | | |

**Recommendation**: Execute over 2-3 coding sessions untuk avoid mistakes karena fatigue.

---

## Success Criteria

✅ **All automations work** without errors  
✅ **All tests pass** (if any)  
✅ **Output files generated** di lokasi baru  
✅ **No import errors** di console  
✅ **Git history clean** dengan clear commit messages per phase  
✅ **README updated** dengan struktur baru  
✅ **No regression** - semua feature yang sebelumnya works masih works  

---

## Future Improvements (Post-Restructure)

### 1. Shared Interfaces
```javascript
// src/automations/base.js
class BaseAutomation {
  async run(accounts, config) { throw new Error('Not implemented'); }
  async processAccount(account, config) { throw new Error('Not implemented'); }
}

// src/automations/kiro/index.js
class KiroAutomation extends BaseAutomation {
  async processAccount(account, config) {
    // Implementation
  }
}
```

### 2. Plugin System
```javascript
// Auto-discover automations
const automations = fs.readdirSync('src/automations')
  .filter(dir => fs.existsSync(`src/automations/${dir}/index.js`))
  .map(dir => require(`./automations/${dir}`));
```

### 3. Monorepo Structure (if grows too big)
```
packages/
  ├── @bercocok-tanam/core/        # Shared utilities
  ├── @bercocok-tanam/cli/         # CLI interface
  ├── @bercocok-tanam/automation-kiro/
  ├── @bercocok-tanam/automation-grok/
  └── @bercocok-tanam/providers/   # Email, router, etc.
```

### 4. TypeScript Migration
- Add JSDoc types first
- Migrate shared utilities to TS
- Migrate automations one by one
- Full TS codebase

---

**Next Steps**: Review plan → Get approval → Execute Phase 1

**Questions?** Let me know which parts need clarification.
