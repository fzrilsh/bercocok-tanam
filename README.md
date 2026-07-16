# 🌱 bercocok-tanam

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D16-brightgreen)](https://nodejs.org/)
[![GitHub Stars](https://img.shields.io/github/stars/fzrilsh/bercocok-tanam?style=social)](https://github.com/fzrilsh/bercocok-tanam/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/fzrilsh/bercocok-tanam?style=social)](https://github.com/fzrilsh/bercocok-tanam/network/members)
[![GitHub Issues](https://img.shields.io/github/issues/fzrilsh/bercocok-tanam)](https://github.com/fzrilsh/bercocok-tanam/issues)
[![Last Commit](https://img.shields.io/github/last-commit/fzrilsh/bercocok-tanam)](https://github.com/fzrilsh/bercocok-tanam/commits/main)
[![Code Style: ESLint](https://img.shields.io/badge/code_style-ESLint-5e5ce6.svg)](https://eslint.org/)
[![Sponsor on Patreon](https://img.shields.io/badge/Patreon-Support%20Development-ff424d?logo=patreon&logoColor=white)](https://patreon.com/fazrilsh)

Automated CLI tool for harvesting Kiro refresh tokens, Cloudflare Workers AI API tokens, and Codebuddy AI OAuth tokens using Puppeteer. Features multi-worker parallel processing, proxy pool management, detailed per-account reporting, and comprehensive error tracking.

![All-in-One Automation Screenshot](assets/screenshot.png)

## ✨ Features

- 🔑 **Kiro Automation** - Automated Kiro OAuth refresh token extraction
- ☁️ **Cloudflare Automation** - Cloudflare Workers AI API token generation
- 🤖 **Codebuddy Automation [BETA]** - Codebuddy AI OAuth token extraction (⚠️ requires residential proxies)
- 🚀 **All-in-One Mode** - Run Kiro, Cloudflare, and Codebuddy automations in parallel
- 🌐 **Proxy Pool System** - Shared proxy pool with automatic worker assignment and locking
- 👷 **Multi-Worker Parallel Processing** - Configure multiple browser instances for faster processing
- 📊 **Detailed Reporting** - Per-worker and per-account statistics with timing breakdown
- 🎯 **Smart Account Queue Management** - Automatic account locking prevents duplicate processing
- ❌ **Comprehensive Error Tracking** - All failed accounts logged with timestamps and automation type
- 🔄 **Account Change Detection** - Confirmation prompt when account count changes before automation
- 🔌 **Flexible Proxy Support** - Per-account proxies or shared proxy pool for all automations
- ⚙️ **Interactive Settings** - Easy configuration management through CLI interface

## 📋 Requirements

- Node.js 16+ 
- Google Chrome or Chromium browser
- Valid Google accounts (email|password format)
- **9Router** - Backend service for token management
  - This tool harvests tokens and imports them to 9Router
  - Must be running and accessible at configured `ROUTER_URL`
  - Default: `http://127.0.0.1:20128/`

## 🚀 Installation

```bash
# Clone the repository
git clone https://github.com/fzrilsh/bercocok-tanam
cd bercocok-tanam

# Install dependencies
npm install

# Create accounts file
echo "email@example.com|password123" > accounts.txt

# (Optional) Configure settings
cp .env.example .env
# Edit .env with your settings
```

## ⚙️ Configuration

Create a `.env` file in the project root:

```env
ROUTER_URL=http://your-router-url:20128/
PW_HEADLESS=1
BROWSER_COUNT=4
BROWSER_SLOW_MO=2
CHROME_EXECUTABLE_PATH=/path/to/chrome
ACCOUNT_FILE=accounts.txt
RESULT_FILE={provider}_keys.txt
ERROR_ACCOUNT_FILE=errorAccounts.txt
PROXY_POOL_FILE=proxy_keys.txt
DELAY_BEFORE_NEXT_CLICK_MS=1000
DELAY_BETWEEN_ACCOUNTS_MS=3000
DELAY_BEFORE_BROWSER_CLOSE_MS=3000
DELAY_BEFORE_READING_COOKIES_MS=5000
TIMEOUT_NAVIGATION_MS=60000
TIMEOUT_DEFAULT_MS=15000
TIMEOUT_SHORT_MS=10000
```

| Variable | Description | Default |
|---|---|---|
| `ROUTER_URL` | 9Router endpoint for token import | `http://127.0.0.1:20128/` |
| `PW_HEADLESS` | `1` = headless, `0` = visible browser | `1` |
| `BROWSER_COUNT` | Number of parallel browser instances | `1` |
| `BROWSER_SLOW_MO` | Delay between browser actions (ms) | `2` |
| `CHROME_EXECUTABLE_PATH` | Path to Chrome/Chromium executable | Auto-detect |
| `ACCOUNT_FILE` | Path to accounts file | `accounts.txt` |
| `RESULT_FILE` | The system automatically replaces `{provider}` with the automation name (`kiro`, `cloudflare`, or `proxy`) | `{provider}_keys.txt` |
| `ERROR_ACCOUNT_FILE` | Log file for failed accounts | `errorAccounts.txt` |
| `PROXY_POOL_FILE` | Shared proxy pool file (optional) - workers auto-pick available proxies | `proxy_keys.txt` |
| `DELAY_BEFORE_NEXT_CLICK_MS` | Delay before next click action | `1000` |
| `DELAY_BETWEEN_ACCOUNTS_MS` | Delay between processing accounts | `3000` |
| `DELAY_BEFORE_BROWSER_CLOSE_MS` | Delay before closing browser | `3000` |
| `DELAY_BEFORE_READING_COOKIES_MS` | Delay before reading cookies | `5000` |
| `TIMEOUT_NAVIGATION_MS` | Page navigation timeout | `60000` |
| `TIMEOUT_DEFAULT_MS` | Default element wait timeout | `15000` |
| `TIMEOUT_SHORT_MS` | Short element wait timeout | `10000` |

## 📝 Account File Format

Create `accounts.txt` with one account per line:

```
user1@gmail.com|password123
user2@gmail.com|password456
user3@gmail.com|password789|http://proxy-server:8080
user4@gmail.com|password321|http://user:pass@proxy:8080
```

**Format Rules:**
- One account per line
- Fields separated by `|` (pipe)
- Lines starting with `#` are comments
- Proxy is optional (supported by all automations)

### Proxy Pool (Optional)

Instead of specifying proxies per account, you can use a shared proxy pool. Create a proxy pool file (e.g., `proxy_keys.txt`):

```
191.96.254.138:6185:username:password
45.38.107.97:6014:username:password
198.105.121.200:6462:username:password
```

**Format:** `ip:port:username:password` (one proxy per line)
- System automatically converts to `http://user:pass@host:port` format

**How it works:**
- Workers automatically pick available proxies from the pool
- Proxies are locked while in use (other workers wait)
- **30-minute cooldown per proxy IP** after use (prevents Google CAPTCHA from rapid reuse)
- Proxy is released after browser closes
- **Priority:** Account proxy > Pool proxy > No proxy

**Important:** 
- **⚠️ Codebuddy Automation:** Requires **residential proxies only**. Datacenter proxies will result in "Account Access Restricted" errors due to Tencent Cloud's security policies. If you don't have residential proxies, Codebuddy automation will likely fail.
- Proxy pool is used for Kiro, Cloudflare, and Codebuddy automations.

Enable by setting `PROXY_POOL_FILE=proxy_keys.txt` in `.env`

## 🎮 Usage

```bash
# Start the CLI
npm start

# Choose from menu:
# 1. 🔑 Kiro Automation
# 2. ☁️  Cloudflare Automation
# 3. 🤖 Codebuddy Automation [BETA] (⚠️ Requires Residential Proxy)
# 4. 🚀 All-in-One Automation
# 5. ⚙️  Settings
# 6. 🚪 Exit
```

### Account Change Confirmation

If you modify `accounts.txt` while at the menu, the system will detect changes when you start an automation:

```
? Account file changed: 5 → 3 accounts. Continue with automation? (Y/n)
```

- Select `Y` to proceed with the new account list
- Select `n` to return to menu and review changes

## 📊 Reports

After each automation run, you'll see a detailed report:

```
════════════════════════════════════════════════════════════════════════════════
  🌱 KIRO AUTOMATION REPORT
════════════════════════════════════════════════════════════════════════════════

📊 OVERALL SUMMARY
────────────────────────────────────────────────────────────────────────────────
  Total Accounts       : 10
  ✅ Success           : 8 accounts
  ❌ Failed            : 2 accounts
  Success Rate         : 80.0%
  Total Duration       : 5m 23s
  Average per Account  : 32.3s

👷 WORKER DETAILS
────────────────────────────────────────────────────────────────────────────────

  Kiro W1
    Processed: 5 accounts | ✅ 4 | ❌ 1
    Average: 31.2s/account
    Accounts:
      ✅ user1@gmail.com 28.5s
      ✅ user2@gmail.com 35.1s
      ❌ user3@gmail.com 29.8s
      ✅ user4@gmail.com 30.2s
      ✅ user5@gmail.com 32.4s

❌ FAILED ACCOUNTS
────────────────────────────────────────────────────────────────────────────────
  • user3@gmail.com
    Error: RefreshToken cookie not found

  💡 Check errorAccounts.txt for complete details

════════════════════════════════════════════════════════════════════════════════
```

## 📁 Output Files

- **`{provider}_keys.txt`** - Token output files, generated per automation:
  - `kiro_keys.txt` — Kiro refresh tokens (format: `email|refreshToken`)
  - `cloudflare_keys.txt` — Cloudflare Workers AI API tokens
  - `codebuddy_keys.txt` — Codebuddy OAuth tokens (auto-imported to 9Router, no local save)
- **`errorAccounts.txt`** - Failed accounts with error messages, timestamps, and automation type
- **`logs/`** - Detailed execution logs with timestamps

### Error Accounts Format

```
email|password | Kiro | 2026-07-10T14:23:45.123Z | RefreshToken cookie not found
email|password | Cloudflare | 2026-07-10T14:25:12.456Z | Account ID not found
```

## 🏗️ Project Structure

```
bercocok-tanam/
├── index.js              # Main entry point with menu system
├── src/
│   ├── browser.js        # Browser launching with stealth mode
│   ├── cloudflare.js     # Cloudflare token harvesting logic
│   ├── codebuddy.js      # Codebuddy OAuth token harvesting logic
│   ├── config.js         # Configuration management
│   ├── google-login.js   # Google authentication helpers
│   ├── kiro.js           # Kiro token harvesting logic
│   ├── progress.js       # Progress bar and status display
│   ├── reporter.js       # Report generation and formatting
│   ├── settings.js       # Interactive settings menu
│   └── utils.js          # Utility functions and helpers
├── assets/
│   └── screenshot.png    # CLI screenshot
├── accounts.txt          # Account list (user-created)
├── kiro_keys.txt         # Kiro tokens output (auto-generated)
├── cloudflare_keys.txt   # Cloudflare tokens output (auto-generated)
├── codebuddy_keys.txt    # Codebuddy tokens output (not saved, auto-imported)
├── errorAccounts.txt     # Failed accounts log
├── logs/                 # Execution logs
├── .env                  # Configuration (user-created)
├── eslint.config.js      # ESLint configuration
└── package.json          # Dependencies and scripts
```

## 🛠️ Tech Stack

- **Node.js** - Runtime environment
- **Puppeteer** - Browser automation
- **Puppeteer-Stealth** - Anti-detection plugin
- **Inquirer** - Interactive CLI prompts
- **CLI-Progress** - Progress bars
- **ANSI-Colors** - Terminal colors
- **9Router** - Token management backend service

## 🔧 Troubleshooting

### "No accounts found" error
- Check `accounts.txt` format: `email|password` or `email|password|proxy`
- Ensure no extra spaces around the `|` separator
- Remove empty lines or add `#` for comments

### "RefreshToken cookie not found"
- Google may require additional verification
- Check if account credentials are correct
- Wait a few minutes and retry (rate limiting)

### Browser won't launch
- Verify Chrome path in settings or `.env`
- Check Chrome is installed and executable
- Try default Chrome path (remove custom setting)

### "spawn /Applications/Google Chrome.app EACCE" (Mac)
Permission error when launching Chrome. Common causes:
- **Wrong path**: `/Applications/Google Chrome.app` is the app bundle, not the executable
- **Solution**: Use correct executable path:
  ```bash
  CHROME_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ```
- If using Chromium: `/Applications/Chromium.app/Contents/MacOS/Chromium`
- If using Brave: `/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`
- **Alternative**: Leave `CHROME_EXECUTABLE_PATH` empty — Puppeteer auto-detects bundled Chromium
- **Check permissions**: Ensure Chrome has execute permission:
  ```bash
  ls -l "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  # Should show: -rwxr-xr-x (x = executable bit)
  ```
- **Security settings**: If downloaded manually, remove quarantine attribute:
  ```bash
  xattr -d com.apple.quarantine "/Applications/Google Chrome.app"
  ```

### 9Router connection errors
- Verify 9Router is running and accessible
- Check `ROUTER_URL` in `.env` or settings
- Test connection: `curl http://127.0.0.1:20128/`
- Ensure firewall allows connections to router port
- Check router logs for import errors
- Disable **Require Login** in 9Router (**Settings → Security**) — the import API will be rejected if authentication is enabled

### Proxy errors
- Verify proxy format: `http://host:port` or `http://user:pass@host:port`
- Test proxy connection separately
- Try without proxy first to isolate issue

### CAPTCHA challenges and security restrictions
- **Kiro/Cloudflare**: Proxy pool includes 30-minute cooldown per IP to prevent CAPTCHA
- **Codebuddy**: Requires **residential proxies only**. Datacenter proxies will trigger "Account Access Restricted" errors from Tencent Cloud's security system. This is not a CAPTCHA but an account-level restriction that cannot be bypassed without residential IPs.
- Reduce `BROWSER_COUNT` (fewer parallel instances)
- Increase delays between actions
- Ensure browser profile is clean (no previous bot flags)
- Free datacenter proxies are more likely to trigger CAPTCHAs than residential proxies

## 📄 License

ISC

## 👤 Author

**Fazril Syaveral Hillaby**
- GitHub: [@fzrilsh](https://github.com/fzrilsh)
- Patreon: [Support Development](https://patreon.com/fazrilsh)

## 🙏 Acknowledgements

- **[9Router](https://github.com/9router/9router)** - Backend token management service that powers the import functionality
- **[Puppeteer](https://pptr.dev/)** & **[puppeteer-extra-plugin-stealth](https://github.com/berstend/puppeteer-extra)** - Browser automation framework and anti-detection capabilities
- **[Inquirer.js](https://github.com/SBoudrias/Inquirer.js)** - Interactive CLI prompts
- **[node-cli-progress](https://github.com/npkgz/cli-progress)** - Terminal progress bars
- **[ansi-colors](https://github.com/doowb/ansi-colors)** - Terminal color styling

Special thanks to the open-source community for making automation tools accessible.

## 🤝 Contributing

Contributions welcome! Please ensure:
- Code follows ESLint configuration (4-space indent)
- All user-facing text is in English
- Comprehensive error handling
- Test changes with multiple accounts before submitting PR

## 💬 Support & Community

- **Issues**: [GitHub Issues](https://github.com/fzrilsh/bercocok-tanam/issues)
- **Discussions**: [GitHub Discussions](https://github.com/fzrilsh/bercocok-tanam/discussions)
- **Sponsor**: [Patreon](https://patreon.com/fazrilsh)

For security vulnerabilities, please email directly instead of opening a public issue.

## 📜 Changelog

See [commit history](https://github.com/fzrilsh/bercocok-tanam/commits/main) for detailed changes.

---

**Built with ❤️ for automation efficiency**
