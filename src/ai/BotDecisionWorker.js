const path = require('path');
const Logger = require('../modules/Logger');

let WorkerCtor = null;
try {
    WorkerCtor = require('worker_threads').Worker;
} catch (err) {
    WorkerCtor = null;
}

class BotDecisionWorker {
    constructor(server) {
        this.server = server;
        this.enabled = !!WorkerCtor;
        this.worker = null;
        this.workerBusy = false;
        this.stopping = false;
        this.pendingSnapshots = new Map();
        this.latestActions = new Map();

        if (this.enabled) {
            this.start();
        }
    }

    start() {
        if (!this.enabled || this.worker)
            return;

        const workerPath = path.join(__dirname, 'workers', 'botDecisionWorker.js');
        this.stopping = false;
        this.worker = new WorkerCtor(workerPath);

        this.worker.on('message', (msg) => {
            this.workerBusy = false;
            if (!msg || msg.type !== 'actions' || !Array.isArray(msg.actions))
                return;

            for (const action of msg.actions) {
                if (!action || typeof action.id !== 'number')
                    continue;
                this.latestActions.set(action.id, action);
            }
        });

        this.worker.on('error', (err) => {
            this.workerBusy = false;
            this.enabled = false;
            Logger.error('Bot worker failed: ' + (err && err.message ? err.message : err));
        });

        this.worker.on('exit', (code) => {
            this.workerBusy = false;
            this.worker = null;
            if (!this.stopping && code !== 0) {
                this.enabled = false;
                Logger.warn('Bot worker exited unexpectedly with code ' + code + '. Falling back to main-thread bot logic.');
            }
            this.stopping = false;
        });
    }

    submitSnapshot(snapshot) {
        if (!this.enabled || !this.worker || !snapshot || typeof snapshot.id !== 'number')
            return;
        this.pendingSnapshots.set(snapshot.id, snapshot);
    }

    getAction(botId) {
        if (typeof botId !== 'number')
            return null;
        const action = this.latestActions.get(botId) || null;
        if (action)
            this.latestActions.delete(botId);
        return action;
    }

    forgetPlayer(playerId) {
        if (typeof playerId !== 'number')
            return;
        this.pendingSnapshots.delete(playerId);
        this.latestActions.delete(playerId);
    }

    flush() {
        if (!this.enabled || !this.worker || this.workerBusy || this.pendingSnapshots.size === 0)
            return;

        const snapshots = Array.from(this.pendingSnapshots.values());
        this.pendingSnapshots.clear();
        this.workerBusy = true;

        this.worker.postMessage({
            type: 'decideBatch',
            haveTeams: !!(this.server.mode && this.server.mode.haveTeams),
            config: {
                botsAvoidViruses: this.server.config.botsAvoidViruses,
                botsCanSplit: this.server.config.botsCanSplit,
                playerMaxCells: this.server.config.playerMaxCells,
                splitVelocity: this.server.config.splitVelocity,
                playerMinSplitSize: this.server.config.playerMinSplitSize,
                playerMinSize: this.server.config.playerMinSize,
                botSplitCooldown: this.server.config.botSplitCooldown
            },
            snapshots
        });
    }

    stop() {
        if (!this.worker)
            return;
        this.stopping = true;
        try {
            this.worker.terminate();
        } catch (err) {
            this.stopping = false;
        }
        this.worker = null;
        this.workerBusy = false;
        this.pendingSnapshots.clear();
        this.latestActions.clear();
    }
}

module.exports = BotDecisionWorker;
