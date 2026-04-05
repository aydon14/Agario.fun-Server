// External modules.
const ReadLine = require("readline");

// Project modules.
const Commands = require("../modules/CommandList.js");
const Server = require("./Server.js");
const Logger = require("../modules/Logger.js");

// Create console interface.
const inputInterface = ReadLine.createInterface(process.stdin, process.stdout);

let instance = null;
let restartWarningTimer = null;
let restartTimer = null;
let restartInProgress = false;

const clearRestartTimers = () => {
    if (restartWarningTimer) {
        clearTimeout(restartWarningTimer);
        restartWarningTimer = null;
    }
    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }
};

const scheduleRestart = () => {
    clearRestartTimers();
    const autoRestartMinutes = Number(instance.config.serverRestart) || 0;
    if (autoRestartMinutes <= 0) {
        return;
    }

    const restartDelayMs = autoRestartMinutes * 60 * 1000;
    if (restartDelayMs <= 60 * 1000) {
        Logger.warn("Server restarting in 1 minute.");
    } else {
        restartWarningTimer = setTimeout(() => {
            Logger.warn("Server restarting in 1 minute.");
        }, restartDelayMs - (60 * 1000));
    }

    restartTimer = setTimeout(async () => {
        await restartServer();
    }, restartDelayMs);
};

const restartServer = async () => {
    if (restartInProgress) {
        return;
    }
    restartInProgress = true;
    clearRestartTimers();
    Logger.info("Server restarting.");

    try {
        if (instance) {
            await instance.stop();
        }
        instance = new Server();
        bindRestartHandler();
        instance.start({ silentStartup: true });
        scheduleRestart();
    } finally {
        restartInProgress = false;
    }
};

const bindRestartHandler = () => {
    if (instance) {
        instance.requestRestart = restartServer;
    }
};

// Create and start instance of server.
instance = new Server();
bindRestartHandler();
instance.start();
scheduleRestart();

// Welcome message.
Logger.starttext(`Running SFA Server, a FOSS agar.io server implementation.`);

// Catch console input.
inputInterface.on("line", (input) => {
    const args = input.toLowerCase().split(" ");
    if(Commands[args[0]]) {
        Commands[args[0]](instance, args)
    };
});