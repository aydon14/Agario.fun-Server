// Library imports
var fs = require("fs");
var http = require("http");
var ini = require("../modules/ini");

// Project imports
var Entity = require('../entity');
var Vec2 = require('../modules/Vec2');
var Logger = require('../modules/Logger');
var Packet = require('../packet');
var {QuadNode, Quad} = require('../modules/QuadNode.js');

// Server implementation
class Server {
    constructor() {
        // Startup
        this.run = true;
        this.version = '1.6.2';
        this.httpServer = null;
        this.lastNodeId = 1;
        this.lastPlayerId = 1;
        this.clients = [];
        this.socketCount = 0;
        this.largestClient = null; // Required for spectators
        this.nodes = []; // Total nodes
        this.nodesVirus = []; // Virus nodes
        this.nodesFood = []; // Food nodes
        this.nodesEjected = []; // Ejected nodes
        this.nodesPlayer = []; // Player nodes
        this.movingNodes = []; // For move engine
        this.leaderboard = []; // For leaderboard
        this.leaderboardType = -1; // No type
        var BotLoader = require('../ai/BotLoader');
        this.bots = new BotLoader(this);

        // Main loop tick
        this.startTime = Date.now();
        this.stepDateTime = 0;
        this.timeStamp = 0;
        this.updateTime = 0;
        this.updateTimeAvg = 0;
        this.timerLoopBind = null;
        this.mainLoopBind = null;
        this.ticks = 0;
        this.disableSpawn = false;
        this.isStopping = false;
        this.silentStartup = false;

        // Backend-only virus refill tuning (not host-configurable)
        this.virusRefillIntervalTicks = 25;
        this.virusRefillPerCheck = 100;
        this.virusRefillRetryMax = 10;
        this.lastVirusRefillTick = 0;

        // Config
        this.config = {
            serverTimeout: 300,
            serverMaxConnections: 500,
            serverPort: 443,
            serverGamemode: 0,
            teamAmount: 3,
            serverRestart: 0,
            serverColorSystem: 0,
            serverMaxLB: 10,
            autoKillall: 0,
            borderWidth: 14142.135623730952,
            borderHeight: 14142.135623730952,
            foodMinSize: 10,
            foodMaxSize: 20,
            foodAmount: 1500,
            foodMassGrow: 1,
            virusMinSize: 100,
            virusMaxSize: 141.421356237,
            virusMaxPoppedSize: 60,
            virusEqualPopSize: 0,
            virusAmount: 50,
            virusFeeding: 1,
            motherCellMaxMass: 0,
            virusVelocity: 780,
            virusMaxCells: 0,
            explodeVelocity: 780,
            serverBots: 0,
            botsAvoidViruses: 1,
            botsCanSplit: 1,
            botSplitCooldown: 15,
            botsUseCustomNames: 0,
            ejectSize: 36.06,
            ejectSizeLoss: 42.43,
            ejectCooldown: 3,
            ejectSpawnPercent: 0.5,
            ejectVirus: 0,
            ejectVelocity: 780,
            playerMinSize: 31.6227766017,
            playerMaxSize: 1500,
            playerMinSplitSize: 59.16079783,
            playerMinEjectSize: 59.16079783,
            playerStartSize: 31.6227766017,
            playerMaxCells: 16,
            playerRigidCells: 1,
            playerSpeed: 1,
            playerDecayRate: 0.002,
            playerDecayCap: 0,
            playerRecombineTime: 30,
            playerDefaultName: "Unnamed Cell",
            playerBotGrow: 0,
            splitVelocity: 780,
            minionStartSize: 31.6227766017,
            minionMaxStartSize: 31.6227766017,
            minionCollideTeam: 0,
            disableQ: 0,
            serverMinions: 0,
            minionsOnLeaderboard: 0,
            minionsUseCustomNames: 0
        };
        this.loadConfig();
        this.ipBanList = [];
        this.minionTest = [];
        this.userList = [];
        this.badWords = [];

        // Set border, quad-tree
        this.setBorder(this.config.borderWidth, this.config.borderHeight);
        this.quadTree = new QuadNode(this.border);
    }
    start(options = {}) {
        this.isStopping = false;
        this.silentStartup = !!options.silentStartup;
        this.timerLoopBind = this.timerLoop.bind(this);
        this.mainLoopBind = this.mainLoop.bind(this);
        // Set up gamemode(s)
        var Gamemode = require('../gamemodes');
        this.mode = Gamemode.get(this.config.serverGamemode);
        this.mode.onServerInit(this);
        // Start the server
        this.httpServer = http.createServer();
        var wsOptions = {
            server: this.httpServer,
            perMessageDeflate: false,
            maxPayload: 4096
        };
        this.WebSocket = require("ws");
        this.wsServer = new this.WebSocket.Server(wsOptions);
        this.wsServer.on('error', this.onServerSocketError.bind(this));
        this.wsServer.on('connection', this.onClientSocketOpen.bind(this));
        this.httpServer.listen(this.config.serverPort, "0.0.0.0", this.onHttpServerOpen.bind(this));
    }
    async onHttpServerOpen() {
        // Start Main Loop
        setTimeout(this.timerLoopBind, 1);
        if (this.isStopping)
            return;
        // Logging
        if (!this.silentStartup) {
            Logger.info("The gamemode is " + this.mode.name);
            Logger.info("Join game using:");
            Logger.info(`ws://127.0.0.1:${this.config.serverPort} (Singleplayer)`);
        }
        // Log public-IP join link
        await new Promise((resolve, reject) => {
            const req = http.get({'host': 'api.ipify.org', 'port': 80, 'path': '/', 'timeout': 3000}, (resp) => {
                resp.on('data', (ip) => {
                    if (!this.silentStartup)
                        Logger.info(`ws://${ip}:${this.config.serverPort} (Multiplayer/Port Forwarding)`);
                    resolve();
                });
            });
            req.on('error', (err) => {
                resolve();
            });
            req.setTimeout(3000, () => {
                req.destroy();
                if (!this.silentStartup)
                    Logger.error("HTTP request timed out. Check 'https://www.whatismyip.com/' for multiplayer.");
                resolve(); // Resolve the promise after aborting the request
            });
        });

        // Player bots
        if (this.config.serverBots) {
            for (var i = 0; i < this.config.serverBots; i++)
                this.bots.addBot();
            if (!this.silentStartup)
                Logger.info(this.config.serverBots + " bots have been added");
        }
        this.spawnCells(this.config.virusAmount, this.config.foodAmount);
    }
    stop() {
        if (this.isStopping)
            return Promise.resolve();

        this.isStopping = true;
        this.run = false;

        if (this.bots && typeof this.bots.stop === 'function') {
            this.bots.stop();
        }

        for (const socket of this.clients) {
            try {
                socket.close(1001, "Server restarting");
            } catch (err) {
            }
            if (socket && socket._socket && typeof socket._socket.destroy == 'function') {
                try {
                    socket._socket.destroy();
                } catch (err) {
                }
            }
        }
        this.clients = [];

        const closeWs = new Promise((resolve) => {
            if (!this.wsServer || typeof this.wsServer.close != 'function')
                return resolve();

            try {
                this.wsServer.clients.forEach((client) => {
                    try {
                        client.terminate();
                    } catch (err) {
                    }
                });
                this.wsServer.close(() => resolve());
            } catch (err) {
                resolve();
            }
        });

        const closeHttp = new Promise((resolve) => {
            if (!this.httpServer || typeof this.httpServer.close != 'function')
                return resolve();

            try {
                this.httpServer.close(() => resolve());
            } catch (err) {
                resolve();
            }
        });

        return Promise.all([closeWs, closeHttp]).then(() => {
            this.httpServer = null;
            this.wsServer = null;
        });
    }
    loadConfig() {
        let config = "./config.ini";
        try {
            if (fs.existsSync(config)) {
                let i = ini.parse(fs.readFileSync(config, "utf-8"));
                for (let r in i) this.config.hasOwnProperty(r) ? this.config[r] = i[r] : Logger.error("Unknown config.ini value: " + r + "!");
            } else Logger.info("Config file not found! Generating new config..."),
            fs.writeFileSync(config, ini.stringify(this.config), "utf-8");
        } catch (ini) {
            Logger.error(ini.stack);
            Logger.error("Failed to load " + config + ": " + ini.message + "!");
        }
    }
    addNode(node) {
        // Add to quad-tree & node list
        var x = node.position.x;
        var y = node.position.y;
        var s = node._size;
        node.quadItem = {
            cell: node,
            bound: new Quad(x - s, y - s, x + s, y + s)
        };
        this.quadTree.insert(node.quadItem);
        this.nodes.push(node);
        // Special on-add actions
        node.onAdd(this);
    }
    onServerSocketError(error) {
        switch (error.code) {
            case "EADDRINUSE":
                Logger.error("Server could not bind to port " + this.config.serverPort + "!");
                Logger.error("Please close out of Skype or change 'serverPort' in the config to a different number.");
                break;
            case "EACCES":
                Logger.error("Please make sure you are running the server with root privileges.");
                break;
            default:
                Logger.error("Error code not handled: " + error.code + " - " + error.message)
        }
        process.exit(1); // Exits the program
    }
    onClientSocketOpen(ws, req) {
        var req = req || ws.upgradeReq;
        var logip = ws._socket.remoteAddress + ":" + ws._socket.remotePort;
        // Ensure the server connections don't go over config.serverMaxConnections
        if (this.clients.length >= this.config.serverMaxConnections) {
            ws.close(1000, "Server connection limit reached.");
            Logger.info("BLOCKED " + logip + ", reason: Server connection limit reached.");
            return;
        }
        ws.on('error', function (err) {
            Logger.error("[" + logip + "] " + err.stack);
        });
        ws.isConnected = true;
        ws.remoteAddress = ws._socket.remoteAddress;
        ws.remotePort = ws._socket.remotePort;
        ws.lastAliveTime = Date.now();
        Logger.info("User connected: " + logip);
        var PlayerTracker = require('./PlayerTracker');
        ws.playerTracker = new PlayerTracker(this, ws);
        var PacketHandler = require('./PacketHandler');
        ws.packetHandler = new PacketHandler(this, ws);
        var self = this;
        ws.on('message', function (message) {
            if (!message.length)
                return;
            if (message.length > 256) {
                ws.close(1009, "Spam");
                return;
            }
            ws.packetHandler.handleMessage(message);
        });
        ws.on('error', function (error) {
            ws.packetHandler.sendPacket = function (data) { };
        });
        ws.on('close', function (reason) {
            if (ws._socket && ws._socket.destroy != null && typeof ws._socket.destroy == 'function') {
                ws._socket.destroy();
            }
            self.socketCount--;
            ws.isConnected = false;
            ws.packetHandler.sendPacket = function (data) { };
            ws.closeReason = {
                reason: ws._closeCode,
                message: ws._closeMessage
            };
            ws.closeTime = Date.now();
            Logger.info("User disconnected: " + logip);
        });
        this.socketCount++;
        this.clients.push(ws);
        // Check for external minions
        this.addMinions(ws);
    }
    addMinions(ws) {
        // Add server minions if needed
        if (this.config.serverMinions && !ws.playerTracker.isMinion) {
            for (var i = 0; i < this.config.serverMinions; i++) {
                this.bots.addMinion(ws.playerTracker);
            }
        }
    }
    setBorder(width, height) {
        var hw = width / 2;
        var hh = height / 2;
        this.border = new Quad(-hw, -hh, hw, hh);
        this.border.width = width;
        this.border.height = height;
    }
    getRandomColor() {
        switch (this.config.serverColorSystem) {
            default: // Agario.fun color system
                {
                    var colorRGB = [0xFF, 0x07, (Math.random() * 256) >> 0];
                    colorRGB.sort(function () {
                        return 0.5 - Math.random();
                    });
        
                    // return random
                    return {
                        r: colorRGB[0],
                        g: colorRGB[1],
                        b: colorRGB[2]
                    };
                }
            case 1: // MultiOgar's random color system
                {
                    let h = 360 * Math.random(),
                        s = 248 / 255,
                        color = {r: 1, g: 1, b: 1};
                    if (s > 0) {
                        h /= 60;
                        let i = ~~(h) >> 0,
                            f = h - i,
                            p = 1 * (1 - s),
                            q = 1 * (1 - s * f),
                            t = 1 * (1 - s * (1 - f));
                        switch (i) {
                            case 0:
                                color = {r: 1, g: t, b: p};
                                break;
                            case 1:
                                color = {r: q, g: 1, b: p};
                                break;
                            case 2:
                                color = {r: p, g: 1, b: t};
                                break;
                            case 3:
                                color = {r: p, g: q, b: 1};
                                break;
                            case 4:
                                color = {r: t, g: p, b: 1};
                                break;
                            default:
                                color = {r: 1, g: p, b: q};
                        }
                    }
                    color.r = Math.max(color.r, 0);
                    color.g = Math.max(color.g, 0);
                    color.b = Math.max(color.b, 0);
                    color.r = Math.min(color.r, 1);
                    color.g = Math.min(color.g, 1);
                    color.b = Math.min(color.b, 1);
                    return {
                        r: (color.r * 255) >> 0,
                        g: (color.g * 255) >> 0,
                        b: (color.b * 255) >> 0
                    };
                }
            case 2: // Ogar-Unlimited's random color system
                {
                    let color = [255, 7, (Math.random() * 255) >> 0];
                    color.sort(() => .5 - Math.random());
                    return {
                        r: color[0],
                        b: color[1],
                        g: color[2]
                    };
                }
            case 3: // Old Ogar's random color system
                {
                    let choices = [
                            {r: 235, g:  75, b:   0},
                            {r: 225, g: 125, b: 255},
                            {r: 180, g:   7, b:  20},
                            {r:  80, g: 170, b: 240},
                            {r: 180, g:  90, b: 135},
                            {r: 195, g: 240, b:   0},
                            {r: 150, g:  18, b: 255},
                            {r:  80, g: 245, b:   0},
                            {r: 165, g:  25, b:   0},
                            {r:  80, g: 145, b:   0},
                            {r:  55, g:  92, b: 255}
                        ],
                        color = choices[Math.floor(Math.random() * 11)];
                    return {
                        r: color.r,
                        g: color.g,
                        b: color.b
                    };
                }
            case 4: // Truely randomized color system
                {
                    return {
                        r: (Math.random() * 256) >> 0,
                        g: (Math.random() * 256) >> 0,
                        b: (Math.random() * 256) >> 0
                    };
                }
        }
    }
    removeNode(node) {
        // Remove from quad-tree
        node.isRemoved = true;
        this.quadTree.remove(node.quadItem);
        node.quadItem = null;
        // Remove from node lists
        var i = this.nodes.indexOf(node);
        if (i > -1)
            this.nodes.splice(i, 1);
        i = this.movingNodes.indexOf(node);
        if (i > -1)
            this.movingNodes.splice(i, 1);
        // Special on-remove actions
        node.onRemove(this);
    }
    broadcastKillallNotification(sourceCode) {
        sourceCode = sourceCode | 0;
        this.clients.forEach((socket) => {
            if (!socket || !socket.packetHandler || typeof socket.packetHandler.sendPacket !== "function")
                return;
            socket.packetHandler.sendPacket(new Packet.KillallNotification(sourceCode));
        });
    }
    killAllPlayersAndRefillViruses(source) {
        source = source || "unknown";
        let removedPlayerCells = 0;
        this.clients.forEach((socket) => {
            const client = socket.playerTracker;
            while (client.cells.length) {
                this.removeNode(client.cells[0]);
                removedPlayerCells++;
            }
        });

        let removedViruses = 0;
        while (this.nodesVirus.length) {
            this.removeNode(this.nodesVirus[0]);
            removedViruses++;
        }

        let spawnedViruses = 0;
        const targetViruses = Math.max(0, this.config.virusAmount | 0);
        const maxAttempts = Math.max(targetViruses * 4, targetViruses + 32, 64);
        let attempts = 0;
        while (this.nodesVirus.length < targetViruses && attempts++ < maxAttempts) {
            if (this.spawnVirus(this.virusRefillRetryMax || 24)) {
                spawnedViruses++;
            }
            else {
                break;
            }
        }

        let sourceCode = 0;
        if (source === "host-command")
            sourceCode = 1;
        else if (source === "auto-map-cover")
            sourceCode = 2;
        this.broadcastKillallNotification(sourceCode);

        return {
            source,
            removedPlayerCells,
            removedViruses,
            spawnedViruses
        };
    }
    checkAutoKillallOnMapCover() {
        if (!this.config.autoKillall)
            return;

        // Corner-safe threshold: large enough to cover the whole map even near an edge/corner.
        const mapCoverThreshold = Math.hypot(this.border.width, this.border.height) / 1.5;
        let triggerCell = null;
        for (let i = 0; i < this.nodesPlayer.length; i++) {
            const cell = this.nodesPlayer[i];
            if (cell && !cell.isRemoved && cell._size >= mapCoverThreshold) {
                triggerCell = cell;
                break;
            }
        }
        if (!triggerCell)
            return;

        this.killAllPlayersAndRefillViruses("auto-map-cover");
    }
    updateClients() {
        // check dead clients
        var len = this.clients.length;
        for (var i = 0; i < len;) {
            if (!this.clients[i]) {
                i++;
                continue;
            }
            this.clients[i].playerTracker.checkConnection();
            if (this.clients[i].playerTracker.isRemoved || this.clients[i].isCloseRequest)
                // remove dead client
                this.clients.splice(i, 1);
            else
                i++;
        }
        // update
        for (var i = 0; i < len; i++) {
            if (!this.clients[i])
                continue;
            this.clients[i].playerTracker.updateTick();
        }
        for (var i = 0; i < len; i++) {
            if (!this.clients[i])
                continue;
            this.clients[i].playerTracker.sendUpdate();
        }
    }
    updateLeaderboard() {
        // Update leaderboard with the gamemode's method
        this.leaderboard = [];
        this.leaderboardType = -1;
        this.mode.updateLB(this, this.leaderboard);
        if (!this.mode.specByLeaderboard) {
            // Get client with largest score if gamemode doesn't have a leaderboard
            var clients = this.clients.valueOf();
            // Use sort function
            clients.sort(function (a, b) {
                return b.playerTracker._score - a.playerTracker._score;
            });
            this.largestClient = null;
            if (clients[0])
                this.largestClient = clients[0].playerTracker;
        }
        else {
            this.largestClient = this.mode.rankOne;
        }
    }
    timerLoop() {
        if (this.isStopping)
            return;
        var timeStep = 40; // vanilla: 40
        var ts = Date.now();
        var dt = ts - this.timeStamp;
        if (dt < timeStep - 5) {
            setTimeout(this.timerLoopBind, timeStep - 5);
            return;
        }
        if (dt > 120)
            this.timeStamp = ts - timeStep;
        // update average, calculate next
        this.updateTimeAvg += 0.5 * (this.updateTime - this.updateTimeAvg);
        this.timeStamp += timeStep;
        setTimeout(this.mainLoopBind, 0);
        setTimeout(this.timerLoopBind, 0);
    }
    mainLoop() {
        if (this.isStopping)
            return;
        this.stepDateTime = Date.now();
        var tStart = process.hrtime();
        var self = this;
        // Loop main functions
        if (this.run) {
            // Move moving nodes first
            for (let i = this.movingNodes.length - 1; i >= 0; i--) {
                const cell = this.movingNodes[i];
                if (!cell || cell.isRemoved || !cell.isMoving) {
                    this.movingNodes.splice(i, 1);
                    continue;
                }
                // Scan and check for ejected mass / virus collisions
                this.boostCell(cell);
                if (!cell.quadItem) {
                    this.movingNodes.splice(i, 1);
                    continue;
                }
                this.quadTree.find(cell.quadItem.bound, function (check) {
                    var m = self.checkCellCollision(cell, check);
                    if (cell.type == 3 && check.type == 3) {
                        return;
                    }
                    self.resolveCollision(m);
                });
                if (!cell.isMoving)
                    this.movingNodes.splice(i, 1);
            }
            // Update players and scan for collisions
            var eatCollisions = [];
            this.nodesPlayer.forEach((cell) => {
                if (cell.isRemoved)
                    return;
                // Scan for eat/rigid collisions and resolve them
                this.quadTree.find(cell.quadItem.bound, function (check) {
                    var m = self.checkCellCollision(cell, check);
                    if (self.checkRigidCollision(m))
                        self.resolveRigidCollision(m);
                    else if (check != cell)
                        eatCollisions.unshift(m);
                });
                this.movePlayer(cell, cell.owner);
                this.boostCell(cell);
                this.autoSplit(cell, cell.owner);
                // Decay player cells once per second
                if (((this.ticks + 3) % 25) === 0)
                    this.updateSizeDecay(cell);
                // Remove external minions if necessary
                if (cell.owner.isMinion) {
                    cell.owner.socket.close(1000, "Minion");
                    this.removeNode(cell);
                }
            });
            eatCollisions.forEach((m) => {
                this.resolveCollision(m);
            });
            this.mode.onTick(this);
            this.checkAutoKillallOnMapCover();
            this.refillViruses();
            this.ticks++;
        }
        if (!this.run && this.mode.IsTournament)
            this.ticks++;
        this.updateClients();
        if (this.bots && typeof this.bots.processBotWorker == 'function')
            this.bots.processBotWorker();
        // Resolve virus splits efficiently & reduce lag
        for (const ws of this.clients) {
            const client = ws.playerTracker;
            if (!client.pendingSplits?.length) continue;

            const maxSplitsPerTick = 100;
            let i = 0;

            while (i++ < maxSplitsPerTick && client.pendingSplits.length) {
                const { parent, angle, mass, velocity } = client.pendingSplits.shift();
                this.splitPlayerCell(client, parent, angle, mass, velocity);
            }
        }
        // update leaderboard
        if (((this.ticks + 7) % 25) === 0)
            this.updateLeaderboard(); // once per second
        // update-update time
        var tEnd = process.hrtime(tStart);
        this.updateTime = tEnd[0] * 1e3 + tEnd[1] / 1e6;
    }
    // update remerge first
    movePlayer(cell, client) {
        if (client.socket.isConnected == false || client.frozen || !client.mouse)
            return; // Do not move
        // get movement from vector
        var d = client.mouse.difference(cell.position);
        var move = cell.getSpeed(d.dist()); // movement speed
        if (!move)
            return; // avoid jittering
        cell.position.add(d.product(move));
        // update remerge
        var time = this.config.playerRecombineTime, base = Math.max(time, cell._size * 0.2) * 25;
        // instant merging conditions
        if (!time || client.rec || client.mergeOverride) {
            cell._canRemerge = cell.boostDistance < 100;
            return; // instant merge
        }
        // regular remerge time
        cell._canRemerge = cell.getAge() >= base;
    }
    // decay player cells
    updateSizeDecay(cell) {
        var rate = this.config.playerDecayRate, cap = this.config.playerDecayCap;
        if (!rate || cell._size <= this.config.playerMinSize)
            return;
        // remove size from cell at decay rate
        if (cap && cell._mass > cap)
            rate *= 10;
        var decay = 1 - rate * this.mode.decayMod;
        cell.setSize(Math.sqrt(cell.radius * decay));
    }
    boostCell(cell) {
        if (cell.isMoving && !cell.boostDistance || cell.isRemoved) {
            cell.boostDistance = 0;
            cell.isMoving = false;
            return;
        }
        // decay boost-speed from distance
        var speed = cell.boostDistance / 9; // val: 87
        cell.boostDistance -= speed; // decays from speed
        cell.position.add(cell.boostDirection.product(speed));
        // update boundries
        cell.checkBorder(this.border);
        this.updateNodeQuad(cell);
    }
    autoSplit(cell, client) {
        // get size limit based off of rec mode
        if (client.rec)
            var maxSize = 1e9; // increase limit for rec (1 bil)
        else
            maxSize = this.config.playerMaxSize;
        // check size limit
        if (client.mergeOverride || cell._size < maxSize || maxSize <= 0)
            return;
        if (client.cells.length >= this.config.playerMaxCells || this.config.mobilePhysics) {
            // cannot split => just limit
            cell.setSize(maxSize);
        }
        else {
            // split in random direction
            var angle = Math.random() * 2 * Math.PI;
            this.splitPlayerCell(client, cell, angle, cell._mass * .5, this.config.splitVelocity);
        }
    }
    updateNodeQuad(node) {
        // update quad tree
        var item = node.quadItem.bound;
        item.minx = node.position.x - node._size;
        item.miny = node.position.y - node._size;
        item.maxx = node.position.x + node._size;
        item.maxy = node.position.y + node._size;
        this.quadTree.remove(node.quadItem);
        this.quadTree.insert(node.quadItem);
    }
    // Checks cells for collision
    checkCellCollision(cell, check) {
        var p = check.position.difference(cell.position);
        // create collision manifold
        return {
            cell: cell,
            check: check,
            d: p.dist(),
            p: p // check - cell position
        };
    }

    checkRigidCollision(m) {
        if (this.config.playerRigidCells === 1) { // Old rigid cell system
            if (!m.cell.owner || !m.check.owner)
                return false;
            if (m.cell.owner != m.check.owner) {
                // Minions don't collide with their team when the config value is 0
                if (this.mode.haveTeams && m.check.owner.isMi || m.cell.owner.isMi && this.config.minionCollideTeam === 0) {
                    return false;
                }
                else {
                    // Different owners => same team
                    return this.mode.haveTeams &&
                        m.cell.owner.team == m.check.owner.team;
                }
            }
            var r = this.config.mobilePhysics ? 1 : 13;
            if (m.cell.getAge() < r || m.check.getAge() < r) {
                return false; // just splited => ignore
            } 
            return !m.cell._canRemerge || !m.check._canRemerge;
        } else { // New rigid cell system
            if (!m.cell.owner || !m.check.owner)
                return false;

            // Allow same-player cells to freely overlap (no rigid push)
            if (m.cell.owner === m.check.owner)
                return false;

            // Handle team-based rigid collision
            if (this.mode.haveTeams) {
                if ((m.cell.owner.isMi || m.check.owner.isMi) && this.config.minionCollideTeam === 0)
                    return false;
                return m.cell.owner.team === m.check.owner.team;
            }

            return false;
        }
    }
    // Resolves rigid body collisions
    resolveRigidCollision(m) {
        var push = (m.cell._size + m.check._size - m.d) / m.d;
        if (push <= 0 || m.d == 0)
            return; // do not extrude
        // body impulse
        var rt = m.cell.radius + m.check.radius;
        var r1 = push * m.cell.radius / rt;
        var r2 = push * m.check.radius / rt;
        // apply extrusion force
        m.cell.position.subtract(m.p.product(r2));
        m.check.position.add(m.p.product(r1));
    }
    // Resolves non-rigid body collision
    resolveCollision(m) {
        var cell = m.cell;
        var check = m.check;
        if (cell._size > check._size) {
            cell = m.check;
            check = m.cell;
        }
        // Do not resolve removed
        if (cell.isRemoved || check.isRemoved)
            return;
        // check eating distance
        check.div = this.config.mobilePhysics ? 20 : 3;
        if (m.d >= check._size - cell._size / check.div) {
            return; // too far => can't eat
        }
        // collision owned => ignore, resolve, or remerge
        if (cell.owner && cell.owner == check.owner) {
            if (cell.getAge() < 13 || check.getAge() < 13)
                return; // just splited => ignore
        }
        else if (check._size < cell._size * 1.15 || !check.canEat(cell))
            return; // Cannot eat or cell refuses to be eaten
        // Consume effect
        check.onEat(cell);
        cell.onEaten(check);
        cell.killer = check;
        // Remove cell
        this.removeNode(cell);
    }
    splitPlayerCell(client, parent, angle, mass, velocity) {
        var size = Math.sqrt(mass * 100);
        var size1 = Math.sqrt(parent.radius - size * size);
        // Too small to split
        if (!size1 || size1 < this.config.playerMinSize)
            return;
        // Remove size from parent cell
        parent.setSize(size1);
        // Create cell and add it to node list
        var newCell = new Entity.PlayerCell(this, client, parent.position, size);
        newCell.setBoost(velocity * Math.pow(size, 0.0122), angle);
        this.addNode(newCell);
    }
    queueSplitCell(client, parent, angle, mass, velocity) {
        client.pendingSplits.push({ parent, angle, mass, velocity });
    }
    randomPos() {
        return new Vec2(this.border.minx + this.border.width * Math.random(),
            this.border.miny + this.border.height * Math.random());
    }
    spawnFood() {
        var cell = new Entity.Food(this, null, this.randomPos(), this.config.foodMinSize);
        if (this.config.foodMassGrow) {
            var maxGrow = this.config.foodMaxSize - cell._size;
            cell.setSize(cell._size += maxGrow * Math.random());
        }
        cell.color = this.getRandomColor();
        this.addNode(cell);
    }
    spawnVirus(maxAttempts) {
        var virus = new Entity.Virus(this, null, this.randomPos(), this.config.virusMinSize);
        let safe = !this.willCollide(virus);
        let attempts = 0;
        const retryMax = Math.max(1, maxAttempts || 64);
        while (!safe && attempts++ < retryMax) {
            virus = new Entity.Virus(this, null, this.randomPos(), this.config.virusMinSize);
            safe = !this.willCollide(virus);
        }
        if (!safe)
            return false;
        this.addNode(virus);
        return true;
    }
    refillViruses() {
        if (this.ticks - this.lastVirusRefillTick < this.virusRefillIntervalTicks)
            return;
        this.lastVirusRefillTick = this.ticks;

        var target = this.config.virusAmount;
        if (!target || target <= 0)
            return;

        var deficit = target - this.nodesVirus.length;
        if (deficit <= 0)
            return;

        var spawnBudget = Math.min(deficit, this.virusRefillPerCheck);
        while (spawnBudget-- > 0) {
            if (!this.spawnVirus(this.virusRefillRetryMax))
                break;
        }
    }
    spawnCells(virusCount, foodCount) {
        for (var i = 0; i < foodCount; i++) {
            this.spawnFood();
        }
        for (var ii = 0; ii < virusCount; ii++) {
            this.spawnVirus();
        }
    }
    spawnPlayer(player, pos) {
        if (this.disableSpawn)
            return; // Not allowed to spawn!
        // Check for special starting size
        var size = this.config.playerStartSize;
        if (player.spawnmass)
            size = player.spawnmass;
        // Check if can spawn from ejected mass
        var index = ~~(this.nodesEjected.length * Math.random());
        var eject = this.nodesEjected[index]; // Randomly selected
        if (Math.random() <= this.config.ejectSpawnPercent &&
            eject && eject.boostDistance < 1) {
            // Spawn from ejected mass
            pos = eject.position.clone();
            player.color = eject.color;
            size = Math.max(size, eject._size * 1.15);
        }
        // Spawn player safely (do not check minions)
        var cell = new Entity.PlayerCell(this, player, pos, size);
        if (this.willCollide(cell) && !player.isMi)
            pos = this.randomPos(); // Not safe => retry
        this.addNode(cell);
        // Set initial mouse coords
        player.mouse.assign(pos);
    }
    willCollide(cell) {
        const x = cell.position.x;
        const y = cell.position.y;
        const r = cell._size;
        const bound = new Quad(x - r, y - r, x + r, y + r);
        return this.quadTree.find(bound, n => n.type == 0);
    }
    splitCells(client) {
        // Split cell order decided by cell age
        var cellToSplit = [];
        for (var i = 0; i < client.cells.length; i++)
            cellToSplit.push(client.cells[i]);
        // Split split-able cells
        cellToSplit.forEach((cell) => {
            var d = client.mouse.difference(cell.position);
            if (d.distSquared() < 1) {
                d.x = 1, d.y = 0;
            }
            if (cell._size < this.config.playerMinSplitSize)
                return; // cannot split
            // Get maximum cells for rec mode
            if (client.rec)
                var max = 200; // rec limit
            else
                max = this.config.playerMaxCells;
            if (client.cells.length >= max)
                return;
            // Now split player cells
            this.splitPlayerCell(client, cell, d.angle(), cell._mass * .5, this.config.splitVelocity);
        });
    }
    canEjectMass(client) {
        if (client.lastEject === null) {
            // first eject
            client.lastEject = this.ticks;
            return true;
        }
        var dt = this.ticks - client.lastEject;
        if (dt < this.config.ejectCooldown) {
            // reject (cooldown)
            return false;
        }
        client.lastEject = this.ticks;
        return true;
    }
    ejectMass(client) {
        if (!this.canEjectMass(client) || client.frozen)
            return;
        for (var i = 0; i < client.cells.length; i++) {
            var cell = client.cells[i];
            if (cell._size < this.config.playerMinEjectSize) continue;
            var loss = this.config.ejectSizeLoss;
            var newSize = cell.radius - loss * loss;
            var minSize = this.config.playerMinSize;
            if (newSize < 0 || newSize < minSize * minSize)
                continue; // Too small to eject
            cell.setSize(Math.sqrt(newSize));

            var d = client.mouse.difference(cell.position);
            var sq = d.dist();
            d.x = sq > 1 ? d.x / sq : 1;
            d.y = sq > 1 ? d.y / sq : 0;

            // Get starting position
            var pos = cell.position.sum(d.product(cell._size));
            var angle = d.angle() + (Math.random() * .6) - .3;
            // Create cell and add it to node list
            var ejected;
            if (this.config.ejectVirus) {
                ejected = new Entity.Virus(this, null, pos, this.config.ejectSize);
            } else {
                ejected = new Entity.EjectedMass(this, null, pos, this.config.ejectSize);
            }
            ejected.color = cell.color;
            ejected.setBoost(this.config.ejectVelocity, angle);
            this.addNode(ejected);
        }
    }
    shootVirus(parent, angle) {
        // Create virus and add it to node list
        var pos = parent.position.clone();
        var newVirus = new Entity.Virus(this, null, pos, this.config.virusMinSize);
        newVirus.setBoost(this.config.virusVelocity, angle);
        this.addNode(newVirus);
    }
};
module.exports = Server;
