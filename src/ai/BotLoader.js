// Library imports
const fs = require("fs");
const path = require("path");

// Project imports
const FakeSocket = require('./FakeSocket');
const PacketHandler = require('../server/PacketHandler');
const BotPlayer = require('./BotPlayer');
const MinionPlayer = require('./MinionPlayer');
const BotDecisionWorker = require('./BotDecisionWorker');

class BotLoader {
    constructor(server) {
        this.server = server;
        this.nextBotId = 1;
        this.freeBotIds = [];
        this.decisionWorker = new BotDecisionWorker(server);
        this.botNamePool = this.loadNamePool(path.join(__dirname, "../names/bots.txt"));
        this.minionNamePool = this.loadNamePool(path.join(__dirname, "../names/minions.txt"));
        this.botNameDeck = [];
        this.botNameDeckIndex = 0;
        this.minionNameDeck = [];
        this.minionNameDeckIndex = 0;
    }

    loadNamePool(filePath) {
        try {
            if (!fs.existsSync(filePath))
                return [];
            const text = fs.readFileSync(filePath, "utf8");
            return text
                .split(/\r?\n/)
                .map(line => line.trim().replace(/^"+|"+$/g, ""))
                .filter(line => line.length > 0);
        } catch (err) {
            return [];
        }
    }

    shuffleInPlace(list) {
        for (let i = list.length - 1; i > 0; i--) {
            const j = (Math.random() * (i + 1)) >> 0;
            const temp = list[i];
            list[i] = list[j];
            list[j] = temp;
        }
        return list;
    }

    pickFromShuffledDeck(pool, fallback, deckKey, indexKey) {
        if (!pool || !pool.length)
            return fallback;

        if (!this[deckKey].length || this[indexKey] >= this[deckKey].length) {
            this[deckKey] = this.shuffleInPlace(pool.slice());
            this[indexKey] = 0;
        }

        const name = this[deckKey][this[indexKey]++];
        return name || fallback;
    }

    getNextBotId() {
        if (this.freeBotIds.length > 0) {
            return this.freeBotIds.shift();
        }
        return this.nextBotId++;
    }

    addBot() {
        const id = this.getNextBotId();
        const useCustomNames = (this.server.config.botsUseCustomNames | 0) === 1;
        const botName = useCustomNames
            ? this.pickFromShuffledDeck(this.botNamePool, `bot ${id}`, "botNameDeck", "botNameDeckIndex")
            : `bot ${id}`;

        const socket = new FakeSocket(this.server);
        socket.playerTracker = new BotPlayer(this.server, socket);
        socket.packetHandler = new PacketHandler(this.server, socket);

        this.server.clients.push(socket);
        socket.packetHandler.setNickname(botName);

        socket._botId = id;
    }

    addMinion(owner, name, mass) {
        const maxSize = this.server.config.minionMaxStartSize;
        const defaultSize = this.server.config.minionStartSize;

        const socket = new FakeSocket(this.server);
        socket.playerTracker = new MinionPlayer(this.server, socket, owner);
        socket.packetHandler = new PacketHandler(this.server, socket);

        socket.playerTracker.spawnmass = mass || (maxSize > defaultSize
            ? Math.floor(Math.random() * (maxSize - defaultSize) + defaultSize)
            : defaultSize);

        this.server.clients.push(socket);
        const hasProvidedName = !(name == "" || !name);
        const useCustomNames = (this.server.config.minionsUseCustomNames | 0) === 1;
        const minionName = hasProvidedName
            ? name
            : useCustomNames
                ? this.pickFromShuffledDeck(this.minionNamePool, "minion", "minionNameDeck", "minionNameDeckIndex")
                : "minion";
        socket.packetHandler.setNickname(minionName);
    }

    releaseBotId(id) {
        if (!this.freeBotIds.includes(id)) {
            this.freeBotIds.push(id);
            this.freeBotIds.sort((a, b) => a - b);
        }
    }

    processBotWorker() {
        if (this.decisionWorker)
            this.decisionWorker.flush();
    }

    forgetBotPlayer(playerId) {
        if (this.decisionWorker)
            this.decisionWorker.forgetPlayer(playerId);
    }

    stop() {
        if (this.decisionWorker)
            this.decisionWorker.stop();
    }
}

module.exports = BotLoader;
