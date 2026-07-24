#!/usr/bin/env node

const { waitForGitHubOTP, waitForGitHubDeviceOTP } = require("./gmail-helper");

async function main() {
    const args = process.argv.slice(2);
    const typeIdx = args.indexOf("--type");
    const type = typeIdx >= 0 ? args[typeIdx + 1] : "launch_code";

    const log = (msg) => process.stderr.write(`${msg}\n`);

    try {
        if (type === "device_verification") {
            const code = await waitForGitHubDeviceOTP(15, log);
            process.stdout.write(code);
            process.exit(0);
        } else {
            const code = await waitForGitHubOTP(30, log);
            process.stdout.write(code);
            process.exit(0);
        }
    } catch (err) {
        process.stderr.write(`Error: ${err.message}\n`);
        process.exit(1);
    }
}

main();
