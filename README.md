# 🌱 bercocok-tanam

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D16-brightgreen)](https://nodejs.org/)
[![GitHub Stars](https://img.shields.io/github/stars/fzrilsh/bercocok-tanam?style=social)](https://github.com/fzrilsh/bercocok-tanam/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/fzrilsh/bercocok-tanam?style=social)](https://github.com/fzrilsh/bercocok-tanam/network/members)
[![GitHub Issues](https://img.shields.io/github/issues/fzrilsh/bercocok-tanam)](https://github.com/fzrilsh/bercocok-tanam/issues)
[![Last Commit](https://img.shields.io/github/last-commit/fzrilsh/bercocok-tanam)](https://github.com/fzrilsh/bercocok-tanam/commits/main)
[![Code Style: ESLint](https://img.shields.io/badge/code_style-ESLint-5e5ce6.svg)](https://eslint.org/)
[![Sponsor on Patreon](https://img.shields.io/badge/Patreon-Support%20Development-ff424d?logo=patreon&logoColor=white)](https://patreon.com/fazrilsh)

Automated CLI tool for harvesting Kiro refresh tokens and Cloudflare Workers AI API tokens using Puppeteer. Features multi-worker parallel processing, detailed per-account reporting, and comprehensive error tracking.

## ✨ Features

- 🔑 **Kiro Automation** - Automated Kiro OAuth refresh token extraction
- ☁️ **Cloudflare Automation** - Cloudflare Workers AI API token generation  
- 🚀 **All-in-One Mode** - Run both automations in parallel
- 👷 **Multi-Worker Parallel Processing** - Configure multiple browser instances for faster processing
- 📊 **Detailed Reporting** - Per-worker and per-account statistics with timing breakdown
- 🎯 **Smart Account Queue Management** - Automatic account locking prevents duplicate processing
- ❌ **Comprehensive Error Tracking** - All failed accounts logged with timestamps and automation type
- 🔄 **Account Change Detection** - Confirmation prompt when account count changes before automation
- 🌐 **Proxy Support** - Cloudflare automation supports proxy configuration per account
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
git clone <repository-url>
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
# Router URL for token import (default: http://127.0.0.1:20128/)
ROUTER_URL=http://your-router-url:20128/

# Browser settings
PW_HEADLESS=0                 # 0 = visible browser, 1 = headless mode
BROWSER_COUNT=1               # Number of parallel browser instances
BROWSER_SLOW_MO=2            # Delay between actions (ms)

# Chrome executable path
CHROME_EXECUTABLE_PATH=/path/to/chrome

# File paths
ACCOUNT_FILE=accounts.txt
RESULT_FILE=cf_keys.txt
ERROR_ACCOUNT_FILE=errorAccounts.txt

# Delays (milliseconds)
DELAY_BEFORE_NEXT_CLICK_MS=1000
DELAY_BETWEEN_ACCOUNTS_MS=3000
DELAY_BEFORE_BROWSER_CLOSE_MS=3000
DELAY_BEFORE_READING_COOKIES_MS=5000

# Timeouts (milliseconds)
TIMEOUT_NAVIGATION_MS=60000
TIMEOUT_DEFAULT_MS=15000
TIMEOUT_SHORT_MS=10000
```

## 📝 Account File Format

Create `accounts.txt` with one account per line:

```
# Kiro accounts (email|password)
user1@gmail.com|password123
user2@gmail.com|password456

# Cloudflare accounts with proxy (email|password|proxy)
user3@gmail.com|password789|http://proxy-server:8080
user4@gmail.com|password321|http://user:pass@proxy:8080
```

**Format Rules:**
- One account per line
- Fields separated by `|` (pipe)
- Lines starting with `#` are comments
- Proxy is optional (Cloudflare only)

## 🎮 Usage

```bash
# Start the CLI
npm start

# Choose from menu:
# 1. 🔑 Kiro Automation
# 2. ☁️  Cloudflare Automation  
# 3. 🚀 All-in-One Automation
# 4. ⚙️  Settings
# 5. 🚪 Exit
```

### Account Change Confirmation

If you modify `accounts.txt` while at the menu, the system will detect changes when you start an automation:

```
? Account file changed: 5 → 3 accounts. Continue with automation? (Y/n)
```

- Select `Y` to proceed with the new account list
- Select `n` to return to menu and review changes

## ⚠️ Important: Headless Mode

> **💡 Recommendation: Use Non-Headless Mode (`PW_HEADLESS=0`)**
>
> Non-headless mode (visible browser) significantly reduces errors because:
> - **Google CAPTCHA detection is minimal** - Visible browsers appear more "human"
> - **Always passes CAPTCHA challenges** - Real rendering triggers fewer bot detection flags
> - **Better success rate** - Lower chance of being flagged as automated traffic
> - **Easier debugging** - You can see exactly what's happening
>
> Headless mode (`PW_HEADLESS=1`) is faster but more likely to trigger:
> - CAPTCHA challenges
> - Account verification prompts
> - Bot detection mechanisms
>
> **For production use, always prefer `PW_HEADLESS=0`** for maximum reliability.

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

- **`cf_keys.txt`** - Successfully harvested Cloudflare tokens
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
│   ├── config.js         # Configuration management
│   ├── google-login.js   # Google authentication helpers
│   ├── kiro.js           # Kiro token harvesting logic
│   ├── progress.js       # Progress bar and status display
│   ├── reporter.js       # Report generation and formatting
│   ├── settings.js       # Interactive settings menu
│   └── utils.js          # Utility functions and helpers
├── accounts.txt          # Account list (user-created)
├── cf_keys.txt           # Cloudflare tokens output
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
- Try non-headless mode (`PW_HEADLESS=0`)
- Check if account credentials are correct
- Wait a few minutes and retry (rate limiting)

### Browser won't launch
- Verify Chrome path in settings or `.env`
- Check Chrome is installed and executable
- Try default Chrome path (remove custom setting)

### 9Router connection errors
- Verify 9Router is running and accessible
- Check `ROUTER_URL` in `.env` or settings
- Test connection: `curl http://127.0.0.1:20128/`
- Ensure firewall allows connections to router port
- Check router logs for import errors

### Proxy errors (Cloudflare only)
- Verify proxy format: `http://host:port` or `http://user:pass@host:port`
- Test proxy connection separately
- Try without proxy first to isolate issue

### CAPTCHA challenges
- **Solution: Use non-headless mode** (`PW_HEADLESS=0`)
- Reduce `BROWSER_COUNT` (fewer parallel instances)
- Increase delays between actions
- Ensure browser profile is clean (no previous bot flags)

## 📄 License

ISC

## 🤝 Contributing

Contributions welcome! Please ensure:
- Code follows ESLint configuration (4-space indent)
- All user-facing text is in English
- Comprehensive error handling
- Comments for complex logic

---

**Built with ❤️ for automation efficiency**
