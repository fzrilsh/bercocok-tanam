import time
import random
import string
import re
import os
import json
import tempfile
from typing import Dict, Optional, Tuple
import requests
import undetected_chromedriver as uc
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.common.action_chains import ActionChains
from selenium.common.exceptions import TimeoutException, NoSuchElementException

# Import local proxy server
try:
    from local_proxy import LocalProxyServer
    LOCAL_PROXY_AVAILABLE = True
except ImportError:
    LOCAL_PROXY_AVAILABLE = False
    print("⚠️  local_proxy.py not found, proxy support limited")

# Cookie warming file
WARM_COOKIES_FILE = 'warm_cookies.json'


class TempEmail:
    def __init__(self, email, provider, csrf_token=None, cookies=None, node_binary=None, gmail_otp_cli=None):
        self.email = email
        self.provider = provider
        self.csrf_token = csrf_token
        self.cookies = cookies
        self.node_binary = node_binary
        self.gmail_otp_cli = gmail_otp_cli
        self.session = requests.Session()
    
    def get_random_user_agent(self):
        user_agents = [
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
        ]
        return random.choice(user_agents)
    
    def wait_for_github_otp(self, max_attempts=30):
        print(f"Waiting for GitHub OTP email ({self.provider})...")
        
        if self.provider == "ncaori":
            return self._wait_for_github_otp_ncaori(max_attempts)
        elif self.provider == "1secemail":
            return self._wait_for_github_otp_secemail(max_attempts)
        elif self.provider == "gmail":
            return self._wait_for_github_otp_gmail()
        else:
            raise Exception(f"Unknown provider: {self.provider}")
    
    def _wait_for_github_otp_gmail(self):
        if not self.node_binary or not self.gmail_otp_cli:
            raise Exception("Gmail provider requires --node-binary and --gmail-otp-cli arguments")
        
        print("Reading OTP via Gmail API (Node helper)...")
        import subprocess
        result = subprocess.run(
            [self.node_binary, self.gmail_otp_cli, '--type', 'launch_code', '--email', self.email],
            stdout=subprocess.PIPE, text=True, timeout=300
        )
        
        if result.returncode != 0:
            raise Exception(f"Gmail OTP failed (exit {result.returncode})")
        
        otp_code = result.stdout.strip()
        if not otp_code:
            raise Exception("Gmail OTP: no code returned")
        
        print(f"GitHub OTP code received (Gmail): {otp_code}")
        return otp_code
    
    def _wait_for_github_otp_ncaori(self, max_attempts):
        user_agent = self.get_random_user_agent()
        
        headers = {
            'accept': '*/*',
            'accept-language': 'en-US,en;q=0.7',
            'cache-control': 'no-cache',
            'pragma': 'no-cache',
            'priority': 'u=1, i',
            'referer': 'https://www.ncaori.my.id/',
            'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Brave";v="150"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"macOS"',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
            'sec-gpc': '1',
            'user-agent': user_agent
        }
        
        for attempt in range(1, max_attempts + 1):
            print(f"Checking for GitHub OTP (attempt {attempt}/{max_attempts})...")
            
            try:
                from urllib.parse import quote
                encoded_email = quote(self.email)
                
                response = self.session.get(
                    f'https://www.ncaori.my.id/api/emails?recipient={encoded_email}',
                    headers=headers
                )
                
                data = response.json()
                
                if data.get('emails'):
                    for email_msg in data['emails']:
                        sender = email_msg.get('sender', '')
                        subject = email_msg.get('subject', '')
                        
                        if 'noreply@github.com' in sender and 'launch code' in subject.lower():
                            content = email_msg.get('body_html', '') or email_msg.get('body_text', '')
                            
                            otp_match = re.search(r'<span class="f00-light text-gray-dark sans-serif text-semibold"[^>]*>(\d{8})</span>', content)
                            if otp_match:
                                otp_code = otp_match.group(1)
                                print(f"GitHub OTP code received: {otp_code}")
                                return otp_code
                            
                            plain_otp_match = re.search(r'(\d{8})', content)
                            if plain_otp_match:
                                otp_code = plain_otp_match.group(1)
                                print(f"GitHub OTP code received (plain): {otp_code}")
                                return otp_code
            except Exception as e:
                print(f"Error checking emails: {e}")
            
            time.sleep(5)
        
        raise Exception("GitHub OTP code not received within timeout")
    
    def _wait_for_github_otp_secemail(self, max_attempts):
        if not self.csrf_token or not self.cookies:
            raise Exception("1secemail provider requires csrf_token and cookies")
        
        user_agent = self.get_random_user_agent()
        
        headers = {
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'en-US,en;q=0.5',
            'cache-control': 'no-cache',
            'content-type': 'application/json',
            'cookie': self.cookies,
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
            'user-agent': user_agent
        }
        
        for attempt in range(1, max_attempts + 1):
            print(f"Checking for GitHub OTP (attempt {attempt}/{max_attempts})...")
            
            try:
                response = self.session.post(
                    'https://www.1secemail.com/get_messages',
                    headers=headers,
                    json={'_token': self.csrf_token}
                )
                
                data = response.json()
                
                if data.get('messages') and len(data['messages']) > 0:
                    for email_msg in data['messages']:
                        from_email = email_msg.get('from_email', '')
                        subject = email_msg.get('subject', '')
                        
                        if from_email == 'noreply@github.com' and subject and 'launch code' in subject.lower():
                            content = email_msg.get('content', '')
                            
                            otp_match = re.search(r'<span class="f00-light text-gray-dark sans-serif text-semibold"[^>]*>(\d{8})</span>', content)
                            if otp_match:
                                otp_code = otp_match.group(1)
                                print(f"GitHub OTP code received: {otp_code}")
                                return otp_code
            except Exception as e:
                print(f"Error checking emails: {e}")
            
            time.sleep(5)
        
        raise Exception("GitHub OTP code not received within timeout")


class GitHubSignup:
    def __init__(self, headless=False, proxy=None, chrome_binary=None, use_warm_cookies=True):
        self.headless = headless
        self.proxy = proxy
        self.chrome_binary = chrome_binary
        self.use_warm_cookies = use_warm_cookies
        self.driver = None
        self.proxy_extension = None
        self.local_proxy_server = None
        self.local_proxy_port = None
    
    def create_proxy_auth_extension(self, proxy_host, proxy_port, proxy_user, proxy_pass):
        """Create a Chrome extension for proxy authentication"""
        manifest_json = """
{
    "version": "1.0.0",
    "manifest_version": 2,
    "name": "Proxy Auth",
    "permissions": [
        "proxy",
        "tabs",
        "unlimitedStorage",
        "storage",
        "<all_urls>",
        "webRequest",
        "webRequestBlocking"
    ],
    "background": {
        "scripts": ["background.js"]
    },
    "minimum_chrome_version": "22.0.0"
}
"""
        
        background_js = """
var config = {
    mode: "fixed_servers",
    rules: {
        singleProxy: {
            scheme: "http",
            host: "%s",
            port: parseInt(%s)
        },
        bypassList: ["localhost"]
    }
};

chrome.proxy.settings.set({value: config, scope: "regular"}, function() {});

function callbackFn(details) {
    return {
        authCredentials: {
            username: "%s",
            password: "%s"
        }
    };
}

chrome.webRequest.onAuthRequired.addListener(
    callbackFn,
    {urls: ["<all_urls>"]},
    ['blocking']
);
""" % (proxy_host, proxy_port, proxy_user, proxy_pass)
        
        # Create temp directory for extension
        extension_dir = tempfile.mkdtemp()
        
        with open(os.path.join(extension_dir, 'manifest.json'), 'w') as f:
            f.write(manifest_json)
        
        with open(os.path.join(extension_dir, 'background.js'), 'w') as f:
            f.write(background_js)
        
        # Create zip file
        extension_zip = os.path.join(tempfile.gettempdir(), 'proxy_auth_extension.zip')
        with zipfile.ZipFile(extension_zip, 'w') as zf:
            zf.write(os.path.join(extension_dir, 'manifest.json'), 'manifest.json')
            zf.write(os.path.join(extension_dir, 'background.js'), 'background.js')
        
        return extension_dir
    
    def sleep(self, min_sec, max_sec=None):
        if max_sec is None:
            time.sleep(min_sec)
        else:
            time.sleep(min_sec + random.random() * (max_sec - min_sec))
    
    def save_warm_cookies(self):
        """Save current browser cookies for next signup (cookie warming)"""
        try:
            cookies = self.driver.get_cookies()
            with open(WARM_COOKIES_FILE, 'w') as f:
                json.dump(cookies, f, indent=2)
            print(f"✅ Saved {len(cookies)} warm cookies to {WARM_COOKIES_FILE}")
        except Exception as e:
            print(f"⚠️  Could not save warm cookies: {e}")
    
    def auto_save_cookies(self, step_name=""):
        """Auto-save cookies after each significant step"""
        try:
            if self.driver:
                self.save_warm_cookies()
                if step_name:
                    print(f"💾 Cookies saved at step: {step_name}")
        except Exception as e:
            print(f"⚠️  Auto-save cookies failed at {step_name}: {e}")
    
    def load_warm_cookies(self):
        """Load warm cookies from previous successful signup"""
        if not self.use_warm_cookies:
            return False
        
        if not os.path.exists(WARM_COOKIES_FILE):
            print("ℹ️  No warm cookies found (first run)")
            return False
        
        try:
            print("🔥 Loading warm cookies from previous signup...")
            
            # Navigate to GitHub first to set domain
            self.driver.get('https://github.com')
            self.sleep(2)
            
            with open(WARM_COOKIES_FILE, 'r') as f:
                cookies = json.load(f)
            
            # Filter out session/CSRF cookies that cause token mismatch
            # Only inject "safe" profile cookies
            BLOCKED_COOKIES = [
                '_gh_sess',           # Session cookie with CSRF state
                'user_session',       # User session
                '__Host-user_session_same_site',  # Session
                'logged_in',          # Login state
                'dotcom_user',        # User identifier
            ]
            
            # Add each cookie (except blocked ones)
            loaded_count = 0
            skipped_count = 0
            for cookie in cookies:
                # Skip blocked cookies
                if cookie['name'] in BLOCKED_COOKIES:
                    skipped_count += 1
                    continue
                
                try:
                    # Remove fields that Selenium doesn't accept
                    cookie_dict = {
                        'name': cookie['name'],
                        'value': cookie['value'],
                        'domain': cookie.get('domain', 'github.com'),
                        'path': cookie.get('path', '/'),
                        'secure': cookie.get('secure', True)
                    }
                    
                    # Add sameSite if present
                    if cookie.get('sameSite'):
                        cookie_dict['sameSite'] = cookie['sameSite']
                    
                    # Add expiry if present and valid
                    if cookie.get('expiry'):
                        cookie_dict['expiry'] = int(cookie['expiry'])
                    
                    self.driver.add_cookie(cookie_dict)
                    loaded_count += 1
                except Exception as e:
                    # Skip cookies that can't be added
                    skipped_count += 1
            
            print(f"✅ Loaded {loaded_count} warm cookies (skipped {skipped_count} session cookies)")
            self.sleep(1)
            return True
            
        except Exception as e:
            print(f"⚠️  Could not load warm cookies: {e}")
            return False
    
    def add_human_behavior(self):
        print("Adding human-like behavior...")
        
        # Random scroll
        try:
            self.driver.execute_script(f"window.scrollBy(0, {random.randint(0, 100)});")
        except:
            pass
        self.sleep(0.5, 1.5)
        
        # Random mouse movement - use smaller offset to avoid out of bounds
        try:
            actions = ActionChains(self.driver)
            random_x = random.randint(10, 50)
            random_y = random.randint(10, 50)
            actions.move_by_offset(random_x, random_y).perform()
        except Exception as e:
            # Mouse movement is optional, just for appearing human-like
            pass
        self.sleep(0.3, 1.0)
    
    def accept_cookies(self):
        print("Checking for cookie consent popup...")
        
        cookie_selectors = [
            "//button[contains(text(), 'Accept All')]",
            "//button[contains(text(), 'Accept all')]",
            "//button[contains(text(), 'Accept All Cookies')]",
            "//button[contains(text(), 'Allow All')]",
            "//button[contains(text(), 'I Accept')]",
            "//button[contains(text(), 'Accept')]",
            "//button[contains(text(), 'Agree')]",
            "//button[contains(@id, 'accept')]",
            "//button[contains(@class, 'accept')]",
            "//a[contains(text(), 'Accept All')]",
            "//a[contains(text(), 'Accept')]"
        ]
        
        for selector in cookie_selectors:
            try:
                button = WebDriverWait(self.driver, 2).until(
                    EC.element_to_be_clickable((By.XPATH, selector))
                )
                print(f"Found cookie consent button: {selector}")
                self.sleep(0.5)
                button.click()
                print("Clicked cookie consent button")
                self.sleep(1)
                return True
            except TimeoutException:
                continue
        
        print("No cookie consent popup found")
        return False
    
    def wait_for_github_challenge(self, max_wait_time=60):
        print("Checking for GitHub bot detection challenge...")
        
        start_time = time.time()
        manual_solve_warning_shown = False
        
        while time.time() - start_time < max_wait_time:
            try:
                body_text = self.driver.find_element(By.TAG_NAME, 'body').text
                page_url = self.driver.current_url
                
                # More specific detection - only flag if these exact phrases appear
                has_github_challenge = (
                    'We detected unusual activity from your browsing behavior' in body_text or
                    'complete this verification' in body_text.lower() or
                    'prove you are human' in body_text.lower()
                )
                
                has_captcha = False
                try:
                    captcha_selectors = [
                        "//iframe[contains(@src, 'hcaptcha')]",
                        "//iframe[contains(@src, 'recaptcha')]",
                        "//div[contains(@class, 'g-recaptcha')]",
                        "//div[contains(@class, 'h-captcha')]"
                    ]
                    for selector in captcha_selectors:
                        elements = self.driver.find_elements(By.XPATH, selector)
                        if elements and elements[0].is_displayed():
                            has_captcha = True
                            break
                except:
                    pass
                
                is_signup_flow = 'github.com/signup' in page_url or 'github.com/account' in page_url
                
                if not (has_github_challenge or (has_captcha and is_signup_flow)):
                    print("✅ No GitHub challenge detected, proceeding...")
                    return True
                
                elapsed = int(time.time() - start_time)
                
                if elapsed == 5 and not manual_solve_warning_shown:
                    print("🤖 GitHub bot detection triggered!")
                    if has_captcha:
                        print("📋 Captcha detected - you need to solve it manually")
                    print("⏳ Waiting for manual solve...")
                    print(f"   Challenge text: {body_text[:200]}...")
                    manual_solve_warning_shown = True
                
                if elapsed % 10 == 0 and elapsed > 0:
                    print(f"⏰ Still waiting for challenge solve... ({elapsed}s/{max_wait_time}s)")
                
                time.sleep(2)
            
            except Exception as e:
                print(f"Error checking challenge: {e}")
                # If there's an error checking, assume no challenge and proceed
                return True
        
        print("❌ GitHub challenge timeout - challenge was not solved")
        raise Exception('GitHub bot detection challenge could not be solved. Please use headed mode or residential proxy.')
    
    def launch_browser(self):
        print("🚀 Launching browser...")
        
        print("  ├─ Setting up Chrome options...")
        options = uc.ChromeOptions()
        
        options.add_argument('--disable-blink-features=AutomationControlled')
        options.add_argument('--disable-features=BlockThirdPartyCookies')
        options.add_argument('--no-first-run')
        options.add_argument('--no-default-browser-check')
        options.add_argument('--disable-popup-blocking')
        options.add_argument('--ignore-certificate-errors')
        options.add_argument('--window-size=1920,1080')
        print("  ├─ Chrome options configured")
        
        # Setup proxy via local proxy server
        if self.proxy and LOCAL_PROXY_AVAILABLE:
            print(f"  ├─ Setting up proxy wrapper...")
            
            # Parse proxy to format for LocalProxyServer
            if '@' in self.proxy:
                # Already in correct format: http://user:pass@host:port
                upstream_proxy = self.proxy
            elif self.proxy.count(':') >= 3:
                # Format: host:port:user:pass -> convert to http://user:pass@host:port
                parts = self.proxy.split(':')
                proxy_host = parts[0]
                proxy_port = parts[1]
                proxy_user = parts[2]
                proxy_pass = ':'.join(parts[3:])
                upstream_proxy = f'http://{proxy_user}:{proxy_pass}@{proxy_host}:{proxy_port}'
            else:
                # No auth: host:port
                upstream_proxy = f'http://{self.proxy}'
            
            # Start local proxy server with random available port
            import socket
            
            # Find available port
            with socket.socket() as s:
                s.bind(('', 0))
                self.local_proxy_port = s.getsockname()[1]
            
            self.local_proxy_server = LocalProxyServer(
                listen_port=self.local_proxy_port,
                upstream_proxy_url=upstream_proxy
            )
            self.local_proxy_server.start()
            
            # Configure Chrome to use local proxy (no auth needed)
            options.add_argument(f'--proxy-server=http://127.0.0.1:{self.local_proxy_port}')
            print(f"  ├─ ✅ Proxy configured: 127.0.0.1:{self.local_proxy_port}")
        
        elif self.proxy:
            print(f"  ├─ ⚠️  Local proxy not available, proxy may not work correctly")
        
        if self.headless:
            options.add_argument('--headless=new')
            print("  ├─ Headless mode enabled")
        else:
            print("  ├─ Headed mode (browser visible)")
        
        # Detect Chrome version
        chrome_version = None
        if self.chrome_binary:
            options.binary_location = self.chrome_binary
            print(f"  ├─ Chrome binary: {self.chrome_binary}")
            
            # Try to detect Chrome version
            print("  ├─ Detecting Chrome version...")
            try:
                import subprocess
                result = subprocess.run([self.chrome_binary, '--version'], 
                                      capture_output=True, text=True, timeout=5)
                version_output = result.stdout.strip()
                # Extract major version (e.g., "Google Chrome 150.0.7871.127" -> 150)
                version_match = re.search(r'(\d+)\.', version_output)
                if version_match:
                    chrome_version = int(version_match.group(1))
                    print(f"  ├─ ✅ Chrome version detected: {chrome_version}")
            except Exception as e:
                print(f"  ├─ ⚠️  Could not detect version: {e}")
                chrome_version = 150  # Default fallback
                print(f"  ├─ Using default version: {chrome_version}")
        
        # Launch browser
        print("  ├─ Starting Chrome browser (this may take 10-30 seconds)...")
        if LOCAL_PROXY_AVAILABLE and self.local_proxy_server:
            self.driver = uc.Chrome(
                options=options,
                version_main=chrome_version,
                browser_executable_path=self.chrome_binary
            )
        else:
            self.driver = uc.Chrome(
                options=options,
                version_main=chrome_version,
                browser_executable_path=self.chrome_binary
            )
        
        print("  ├─ Setting page load timeout to 60s...")
        self.driver.set_page_load_timeout(60)
        
        print("  └─ ✅ Browser launched successfully!")
        return self
    
    def inject_github_cookies(self):
        """Inject GitHub cookies to appear more like a real user session"""
        print("Injecting GitHub cookies...")
        
        # First navigate to GitHub to set domain
        self.driver.get('https://github.com')
        self.sleep(2)
        
        # Cookies to inject
        cookies = [
            {
                "domain": "github.com",
                "name": "_octo",
                "path": "/",
                "sameSite": "Lax",
                "secure": True,
                "value": "GH1.1.723845500.1784644460"
            },
            {
                "domain": "github.com",
                "name": "_gh_sess",
                "path": "/",
                "sameSite": "Lax",
                "secure": True,
                "value": "t5UM52sfzHhb8XDn1rZsJtUBaN%2BTm2zW7mBwpLn38VFLCnSE6oWxqsBktMDFM3AtGSIqNHOcN3sglFqPeGcqPXw2vgg4u1L1QHifByAXbjqxkxFgWs%2BuNFBhqZta1b9hpw0CdPeEnLjyThVP1DVR7TT630a%2BF08EE70FHg5lNPkVdDNY%2Flb8dA8Xo9%2FLl8qn1TYHNarV0HLOUbarCRD8mC7K%2BvyWblLKzDCYW1bw84urXY8%2FuU7HHq4Y%2B%2BwqCJGgqyt73QQoJVFbr%2FKJKyhYQg%3D%3D--9hvEnRLcv7JOaNav--0wswmShmLUyetyPVdY30hQ%3D%3D"
            },
            {
                "domain": "github.com",
                "name": "GHCC",
                "path": "/",
                "sameSite": "Lax",
                "secure": True,
                "value": "Required:1-Analytics:0-SocialMedia:0-Advertising:0"
            },
            {
                "domain": "github.com",
                "name": "cpu_bucket",
                "path": "/",
                "sameSite": "Lax",
                "secure": True,
                "value": "sm"
            },
            {
                "domain": "github.com",
                "name": "preferred_color_mode",
                "path": "/",
                "sameSite": "Lax",
                "secure": True,
                "value": "dark"
            },
            {
                "domain": "github.com",
                "name": "tz",
                "path": "/",
                "sameSite": "Lax",
                "secure": True,
                "value": "Asia%2FJakarta"
            }
        ]
        
        # Add each cookie
        for cookie in cookies:
            try:
                # Selenium requires specific format
                cookie_dict = {
                    'name': cookie['name'],
                    'value': cookie['value'],
                    'domain': cookie['domain'],
                    'path': cookie['path'],
                    'secure': cookie['secure']
                }
                
                # sameSite handling (Selenium uses different case)
                if cookie.get('sameSite'):
                    cookie_dict['sameSite'] = cookie['sameSite']
                
                self.driver.add_cookie(cookie_dict)
                print(f"  ✅ Added cookie: {cookie['name']}")
            except Exception as e:
                print(f"  ⚠️  Could not add cookie {cookie['name']}: {e}")
        
        print("✅ GitHub cookies injected")
        self.sleep(1)
    
    def fill_signup_form(self, email, password, username):
        print("\n📝 Starting GitHub signup form...")
        
        print("  ├─ Navigating to https://github.com/signup...")
        self.driver.get('https://github.com/signup')
        self.sleep(3, 5)
        
        print("  ├─ Checking for bot detection challenges...")
        self.wait_for_github_challenge(20)
        
        print("  ├─ Checking for cookie consent popup...")
        self.accept_cookies()
        
        print("  ├─ Adding human-like behavior...")
        self.add_human_behavior()
        self.sleep(1, 2)
        
        # Fill email
        print(f"\n  ├─ [EMAIL] Waiting for email field...")
        email_input = WebDriverWait(self.driver, 30).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, 'input#email'))
        )
        print(f"  ├─ [EMAIL] Field found, clicking...")
        email_input.click()
        self.sleep(0.3, 0.5)
        
        print(f"  ├─ [EMAIL] Typing: {email}")
        for char in email:
            email_input.send_keys(char)
            self.sleep(0.01, 0.5)
        print(f"  ├─ [EMAIL] ✅ Email entered")
        
        self.sleep(1, 1.5)
        self.add_human_behavior()
        
        # Fill password
        print(f"\n  ├─ [PASSWORD] Waiting for password field...")
        password_input = WebDriverWait(self.driver, 30).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, 'input#password'))
        )
        print(f"  ├─ [PASSWORD] Field found, clicking...")
        password_input.click()
        self.sleep(0.3, 0.5)
        
        print(f"  ├─ [PASSWORD] Typing password ({len(password)} characters)...")
        for char in password:
            password_input.send_keys(char)
            self.sleep(0.01, 0.05)
        print(f"  ├─ [PASSWORD] ✅ Password entered")
        
        self.sleep(1, 1.5)
        self.add_human_behavior()
        
        # Fill username
        print(f"\n  ├─ [USERNAME] Waiting for username field...")
        username_input = WebDriverWait(self.driver, 30).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, 'input#login'))
        )
        print(f"  ├─ [USERNAME] Field found, clicking...")
        username_input.click()
        self.sleep(0.3, 0.5)
        
        print(f"  ├─ [USERNAME] Typing: {username}")
        for char in username:
            username_input.send_keys(char)
            self.sleep(0.01, 0.05)
        print(f"  ├─ [USERNAME] ✅ Username entered")
        
        self.sleep(1, 1.5)
        self.add_human_behavior()
        
        # Uncheck Copilot opt-in if checked
        print("\n  ├─ [CHECKBOXES] Checking for opt-in checkboxes...")
        try:
            copilot_checkbox = self.driver.find_element(By.CSS_SELECTOR, 'input#user_signup\\[copilot_opt_in\\]')
            if copilot_checkbox.is_selected():
                self.sleep(0.5, 0.8)
                copilot_checkbox.click()
                print("  ├─ [CHECKBOXES] ✅ Copilot checkbox unchecked")
        except Exception as e:
            print(f"  ├─ [CHECKBOXES] Copilot checkbox not found: {e}")
        
        # Uncheck marketing consent if checked
        try:
            marketing_checkbox = self.driver.find_element(By.CSS_SELECTOR, 'input#user_signup\\[marketing_consent\\]')
            if marketing_checkbox.is_selected():
                self.sleep(0.5, 0.8)
                marketing_checkbox.click()
                print("  ├─ [CHECKBOXES] ✅ Marketing checkbox unchecked")
        except Exception as e:
            print(f"  ├─ [CHECKBOXES] Marketing checkbox not found: {e}")
        
        self.sleep(1, 2)
        self.add_human_behavior()
        
        # Submit the form
        print("\n  ├─ [SUBMIT] Looking for 'Create account' button...")
        try:
            # Try multiple selectors to find the submit button
            submit_btn = None
            
            # Method 1: Find all submit buttons and filter
            buttons = self.driver.find_elements(By.CSS_SELECTOR, 'button[type="submit"]')
            print(f"  ├─ [SUBMIT] Found {len(buttons)} submit buttons")
            
            for btn in buttons:
                btn_text = btn.text
                if 'Create account' in btn_text or 'create account' in btn_text.lower():
                    submit_btn = btn
                    print(f"  ├─ [SUBMIT] ✅ Found 'Create account' button")
                    break
            
            # Method 2: If not found, try last visible submit button (skip OAuth buttons)
            if not submit_btn:
                print(f"  ├─ [SUBMIT] Trying fallback method...")
                for btn in reversed(buttons):
                    btn_text = btn.text
                    if btn_text and 'Google' not in btn_text and 'Apple' not in btn_text:
                        submit_btn = btn
                        print(f"  ├─ [SUBMIT] Using button: '{btn_text}'")
                        break
            
            if not submit_btn:
                raise Exception("Could not find Create account button")
            
            # Scroll to button to make sure it's visible
            print(f"  ├─ [SUBMIT] Scrolling to button...")
            self.driver.execute_script("arguments[0].scrollIntoView(true);", submit_btn)
            self.sleep(1)
            
            print(f"  ├─ [SUBMIT] Clicking submit button...")
            submit_btn.click()
            print("  ├─ [SUBMIT] ✅ Button clicked")
        except Exception as e:
            print(f"  └─ [SUBMIT] ❌ Error clicking submit: {e}")
            raise
        
        print("\n  ├─ Waiting for page to process (5-7 seconds)...")
        self.sleep(5, 7)
        
        # Check what page we're on after submit
        try:
            current_url = self.driver.current_url
            page_title = self.driver.title
            print(f"  ├─ Current page: {current_url}")
            print(f"  ├─ Page title: {page_title}")
        except Exception as e:
            print(f"  ├─ Could not get page info: {e}")
        
        print("  ├─ Checking for challenges after submit...")
        self.wait_for_github_challenge(60)
        
        # Auto-save cookies after successful form submission
        self.auto_save_cookies("form_submission")
        
        print("  └─ ✅ Form submission complete!\n")
    
    def enter_otp(self, otp_code):
        print("Waiting for OTP input fields...")
        self.sleep(2, 3)
        
        self.wait_for_github_challenge(60)
        self.add_human_behavior()
        
        # Save warm cookies at OTP step (successful signup so far)
        self.save_warm_cookies()
        
        print(f"Entering OTP code: {otp_code}")
        
        digits = list(otp_code)
        for i in range(8):
            input_field = WebDriverWait(self.driver, 30).until(
                EC.presence_of_element_located((By.CSS_SELECTOR, f'input#launch-code-{i}'))
            )
            self.sleep(0.1, 0.3)
            input_field.click()
            self.sleep(0.01, 0.05)
            input_field.send_keys(digits[i])
            self.sleep(0.2, 0.5)
        
        print("Waiting for auto-submit or clicking continue...")
        self.sleep(3, 4)
        self.add_human_behavior()
        
        try:
            continue_btn = WebDriverWait(self.driver, 5).until(
                EC.element_to_be_clickable((By.XPATH, '//button[contains(text(), "Continue")]'))
            )
            continue_btn.click()
        except TimeoutException:
            print("Continue button not found or already auto-submitted")
        
        print("Waiting for redirect to dashboard...")
        self.sleep(2)
        self.wait_for_github_challenge(60)
        
        WebDriverWait(self.driver, 60).until(
            lambda driver: '/login' in driver.current_url or '/dashboard' in driver.current_url
        )
        
        print("GitHub signup completed successfully!")
    
    def close(self):
        if self.driver:
            self.driver.quit()
            print("Browser closed.")
        
        # Stop local proxy server if running
        if self.local_proxy_server:
            self.local_proxy_server.stop()
            self.local_proxy_server = None


def generate_username():
    chars = string.ascii_lowercase + string.digits
    return ''.join(random.choices(chars, k=10))

def generate_password():
    chars = string.ascii_letters + string.digits
    password = 'GhPass' + ''.join(random.choices(chars, k=16)) + '!@#'
    return password


def create_github_account(email, provider, csrf_token=None, cookies=None, headless=False, proxy=None, chrome_binary=None, node_binary=None, gmail_otp_cli=None):
    temp_email = TempEmail(email, provider, csrf_token, cookies, node_binary, gmail_otp_cli)
    
    username = generate_username()
    password = generate_password()
    
    print(f"\nAccount Details:")
    print(f"Email: {temp_email.email}")
    print(f"Provider: {temp_email.provider}")
    print(f"Username: {username}")
    print(f"Password: {password}\n")
    
    signup = GitHubSignup(headless=headless, proxy=proxy, chrome_binary=chrome_binary)
    
    try:
        signup.launch_browser()
        
        # Load warm cookies from previous successful signup
        signup.load_warm_cookies()
        
        signup.fill_signup_form(temp_email.email, password, username)
        
        otp_code = temp_email.wait_for_github_otp()
        signup.enter_otp(otp_code)
        
        print("\n✅ GitHub account created successfully!")
        print(f"Email: {temp_email.email}")
        print(f"Password: {password}")
        print(f"Username: {username}")
        
        time.sleep(5)
        
        return {
            'email': temp_email.email,
            'password': password,
            'username': username,
            'success': True
        }
    
    except Exception as e:
        print(f"\n❌ Error creating account: {e}")
        return {
            'email': temp_email.email if temp_email.email else 'unknown',
            'password': password,
            'username': username,
            'success': False,
            'error': str(e)
        }
    
    finally:
        signup.close()


if __name__ == '__main__':
    import argparse
    
    parser = argparse.ArgumentParser(description='GitHub Account Generator')
    parser.add_argument('--email', type=str, required=True, help='Email address to use for signup')
    parser.add_argument('--provider', type=str, required=True, help='Temp email provider (ncaori, 1secemail, or gmail)')
    parser.add_argument('--csrf-token', type=str, help='CSRF token from temp email service (required for 1secemail)')
    parser.add_argument('--cookies', type=str, help='Session cookies from temp email service (required for 1secemail)')
    parser.add_argument('--headless', action='store_true', help='Run in headless mode')
    parser.add_argument('--proxy', type=str, help='Proxy server (e.g., http://ip:port)')
    parser.add_argument('--chrome-binary', type=str, help='Path to Chrome binary')
    parser.add_argument('--node-binary', type=str, help='Path to Node.js binary (required for gmail provider)')
    parser.add_argument('--gmail-otp-cli', type=str, help='Path to gmail-otp-cli.js (required for gmail provider)')
    
    args = parser.parse_args()
    
    print("🐙 GitHub Account Generator")
    print(f"Creating account with email: {args.email}\n")
    
    result = create_github_account(
        email=args.email,
        provider=args.provider,
        csrf_token=args.csrf_token,
        cookies=args.cookies,
        headless=args.headless,
        proxy=args.proxy,
        chrome_binary=args.chrome_binary,
        node_binary=args.node_binary,
        gmail_otp_cli=args.gmail_otp_cli
    )
    
    if result['success']:
        print(f"\n{'='*60}")
        print("✅ SUCCESS")
        print(f"{'='*60}")
        print(f"📝 Created Account:")
        print(f"  {result['email']}:{result['password']}:{result['username']}")
        exit(0)
    else:
        print(f"\n{'='*60}")
        print("❌ FAILED")
        print(f"{'='*60}")
        print(f"Error: {result.get('error', 'Unknown error')}")
        exit(1)
