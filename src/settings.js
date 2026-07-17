const { getConfig, reloadConfig, updateEnvValue } = require("./config");
const { readAccounts } = require("./utils");
const path = require("path");

function displaySettingsPanel(config, accounts) {
    const rows = [
        ["Router URL", config.routerUrl],
        ["PW Headless", config.headless ? "true" : "false"],
        ["Chrome Path", config.chromeExecutablePath],
        ["Account File", `${path.basename(config.accountFile)} (${accounts.length} accounts)`],
        ["Browser Count", String(config.browserCount)],
    ];

    const labelWidth = 15;
    const maxValueLen = Math.max(...rows.map(([, v]) => v.length));
    const innerWidth = labelWidth + 3 + maxValueLen;
    const boxWidth = innerWidth + 4;

    const title = "Settings";
    const titleDisplayLen = title.length;
    const titlePadLeft = Math.floor((boxWidth - 2 - titleDisplayLen) / 2);
    const titlePadRight = boxWidth - titleDisplayLen - titlePadLeft - 2;

    console.log("");
    console.log(`╔${"═".repeat(boxWidth - 2)}╗`);
    console.log(
        `║${" ".repeat(titlePadLeft)}${title}${" ".repeat(titlePadRight)}║`,
    );
    console.log(`╠${"═".repeat(boxWidth - 2)}╣`);

    for (const [label, value] of rows) {
        const line = `${label.padEnd(labelWidth)}: ${value}`;
        console.log(`║  ${line.padEnd(boxWidth - 4)}║`);
    }

    console.log(`╚${"═".repeat(boxWidth - 2)}╝`);
    console.log("");
}

async function openSettings() {
    const inquirer = (await import("inquirer")).default;
    let running = true;

    while (running) {
        console.clear(); // Clear screen before showing settings
        
        const config = getConfig();
        const accounts = readAccounts();

        displaySettingsPanel(config, accounts);

        const { choice } = await inquirer.prompt([
            {
                type: "list",
                name: "choice",
                message: "Choose setting to modify:",
                choices: [
                    { name: "Router URL", value: "router_url" },
                    { name: "PW Headless", value: "pw_headless" },
                    { name: "Chrome Executable", value: "chrome_path" },
                    { name: "Account File", value: "account_file" },
                    { name: "Browser Count", value: "browser_count" },
                    { name: "← Back", value: "back" },
                ],
            },
        ]);

        if (choice === "back") {
            running = false;
            break;
        }

        switch (choice) {
            case "router_url": {
                const { value } = await inquirer.prompt([
                    {
                        type: "input",
                        name: "value",
                        message: "Enter new Router URL:",
                        default: config.routerUrl,
                        validate: (input) => {
                            try {
                                new URL(input);
                                return true;
                            } catch {
                                return "Invalid URL. Example: http://100.112.135.61:5000/";
                            }
                        },
                    },
                ]);

                updateEnvValue("ROUTER_URL", value);
                reloadConfig();
                console.log("Router URL updated!");
                break;
            }

            case "pw_headless": {
                const { value } = await inquirer.prompt([
                    {
                        type: "list",
                        name: "value",
                        message: "PW Headless mode:",
                        choices: [
                            { name: "true (headless)", value: "1" },
                            { name: "false (visible browser)", value: "0" },
                        ],
                        default: config.headless ? "1" : "0",
                    },
                ]);

                updateEnvValue("PW_HEADLESS", value);
                reloadConfig();
                console.log("PW Headless updated!");
                break;
            }

            case "chrome_path": {
                const { value } = await inquirer.prompt([
                    {
                        type: "input",
                        name: "value",
                        message: "Enter Chrome executable path:",
                        default: config.chromeExecutablePath,
                    },
                ]);

                updateEnvValue("CHROME_EXECUTABLE_PATH", value);
                reloadConfig();
                console.log("Chrome path updated!");
                break;
            }

            case "account_file": {
                const { value } = await inquirer.prompt([
                    {
                        type: "input",
                        name: "value",
                        message: "Enter account file name:",
                        default: "accounts.txt",
                    },
                ]);

                updateEnvValue("ACCOUNT_FILE", value);
                reloadConfig();
                console.log("Account file updated!");
                break;
            }

            case "browser_count": {
                const { value } = await inquirer.prompt([
                    {
                        type: "number",
                        name: "value",
                        message: "Enter browser count:",
                        default: config.browserCount,
                        validate: (input) => {
                            const num = Number(input);
                            if (!Number.isFinite(num) || num < 1) {
                                return "Must be a number >= 1";
                            }
                            return true;
                        },
                    },
                ]);

                updateEnvValue("BROWSER_COUNT", String(value));
                reloadConfig();
                console.log("Browser count updated!");
                break;
            }
        }
    }
}

module.exports = {
    openSettings,
};
