const cliProgress = require("cli-progress");
const colors = require("ansi-colors");

const STEPS = {
    LAUNCHING: "Launching browser",
    NAVIGATING: "Navigating",
    GOOGLE_LOGIN: "Google login",
    GETTING_TOKEN: "Getting token",
    IMPORTING: "Importing token",
    HARVESTING: "Harvesting API",
    VALIDATING: "Validating",
    IMPORTING_CF: "Importing to 9R",
    DONE: "Done",
    ERROR: "Error",
    WAITING: "Waiting...",
};

function truncateEmail(email, maxLen = 20) {
    if (!email) {return "—";}
    if (email.length <= maxLen) {return email.padEnd(maxLen);}

    return `${email.slice(0, maxLen - 1)}…`;
}

function createProgressManager(title) {
    console.log("");
    console.log(colors.green.bold(title));
    console.log("");

    const multiBar = new cliProgress.MultiBar(
        {
            format: (options, params, payload) => {
                const filled = Math.min(
                    options.barsize,
                    Math.ceil(params.progress * options.barsize),
                );
                const bar =
                    options.barCompleteChar.repeat(filled) +
                    options.barIncompleteChar.repeat(options.barsize - filled);

                const pct = Math.round(params.progress * 100);
                const workerLabel = colors.cyan(
                    payload.label || `Worker ${payload.workerIndex + 1}`,
                );

                const pctStr =
          pct === 100 ? colors.green.bold(`${pct}%`) : colors.yellow(`${pct}%`);

                const progressStr = `${params.value}/${params.total}`;
                const emailStr = truncateEmail(payload.email);

                const stepStr =
          payload.step === STEPS.DONE
              ? colors.green.bold(payload.step)
              : payload.step === STEPS.ERROR
                  ? colors.red.bold(payload.step)
                  : colors.gray(`⏳ ${payload.step}`);

                const successStr = colors.green(`✅ ${payload.success}`);
                const failStr = colors.red(`❌ ${payload.failed}`);

                return ` ${workerLabel} ${bar} ${pctStr} │ ${progressStr} │ ${emailStr} │ ${stepStr.padEnd(28)} │ ${successStr} ${failStr}`;
            },
            barCompleteChar: "█",
            barIncompleteChar: "░",
            barsize: 20,
            hideCursor: true,
            clearOnComplete: false,
            stopOnComplete: false,
            forceRedraw: true,
        },
        cliProgress.Presets.shades_grey,
    );

    const bars = {};

    function addWorker(workerId, total, label) {
        const bar = multiBar.create(total, 0, {
            workerIndex: workerId,
            label,
            email: "—",
            step: STEPS.WAITING,
            success: 0,
            failed: 0,
        });

        bars[workerId] = bar;

        return bar;
    }

    function updateWorker(workerId, payload) {
        const bar = bars[workerId];
        if (!bar) {return;}

        const current = payload.current ?? bar.value;
        bar.update(current, payload);
    }

    function stop() {
        multiBar.stop();
        console.log("");
    }

    return { addWorker, updateWorker, stop, multiBar };
}

module.exports = {
    STEPS,
    createProgressManager,
};
