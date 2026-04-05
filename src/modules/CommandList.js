const Logger = require("./Logger");

class CommandsList {
    constructor() {
        // Command descriptions
        this.help.description = "List of currently available commands.";
        this.playerlist.description = "Produce a list of clients currently connected to the server.";
        this.minion.description = "Give minions to a player.";
        this.addbot.description = "Add player bots to this server.";
        this.rmbot.description = "Remove bots from the server";
        this.kick.description = "Kick a client from the game";
        this.killall.description = "Remove all client cells";
        this.mass.description = "Set mass for all cells of a player.";
        this.restart.description = "Restart the server.";
        this.exit.description = "Exit the server.";
        this.stats.description = "Generate current server stats";
        this.aliases.description = "Generate command aliases.";
    };

    help() {
        const commands = Object.getOwnPropertyNames(CommandsList.prototype); // List of methods.
        commands.shift(); // Remove constructor.

        Logger.info(`The server currently supports a total of ${commands.length} commands.`);

        // Print each command and its description.
        commands.forEach(command => {
            const commandObj = CommandsList.prototype[command]; // Command object

            // Ignore aliases, only print commands.
            if(CommandsList.prototype[commandObj.name] && !CommandsList.prototype[commandObj.name].isAlias) {
                console.log(`${commands.indexOf(command) + 1}. ${command}: ${commandObj.description}`);
            };
        });
    };

    playerlist(server) {
        // Sort client IDs in descending order.
        server.clients.sort((a, b) => {return a.playerTracker.pID - b.playerTracker.pID});

        server.clients.forEach(socket => {
            const client = socket.playerTracker;

            // Ignore disconnnected sockets.
            if(!socket.isConnected) {
                return;
            };

            Logger.info(`Info record for client ${client.pID}: `);
            console.log(`- isMinion: ${client.isMi}`);
            console.log(`- protocol:  ${client.protocol || "none"}`);
            console.log(`- remoteAdress: ${client.remoteAddress || "none"}`);
            console.log(`- spectate: ${client.spectate}`);
            console.log(`- name: ${client._name || "none"}`);
            console.log(`- cells: ${client.cells.length}`);
            console.log(`- score: ${Math.floor(client._score)}`);
            console.log(`- position: {x: ${Math.floor(client.centerPos.x)}, y: ${Math.floor(client.centerPos.y)}}`);
            console.log(`\n`);
        });
    };

    minion(server, args) {
        const ID = parseInt(args[1]);
        const amount = parseInt(args[2]) || 1;
        const name = args.splice(3).join(" ");

        if (isNaN(ID)) {
            return Logger.warn(`Please provide a numerical player ID.`);
        };

        // Check if server is empty.
        if(!server.clients.length) {
            return Logger.warn("The server is empty.");
        };
 
        for (let key in server.clients) {
            const client = server.clients[key].playerTracker;
            // Only use the right ID, skip all others.
            if(client.pID == ID) {
                // Remove minions if no amount is provided.
                if (client.hasMinions == true) {
                    // Set hasMinions flag to false.
                    client.hasMinions = false;
                    return Logger.info(`Removed ${client._name}'s minions.`);
                };

                // Exclude disconnected players.
                if (!server.clients[key].isConnected) {
                    return Logger.warn(`${client._name} isn't connected`)
                };


                // Add the provided (or default) amount of minions to the client specified.
                for (let i = 0; i < amount; i++) {
                    server.bots.addMinion(client, name);
                };

                // Set hasMinions flag to true.
                client.hasMinions = true;

                return Logger.success(`Gave ${amount} minions to ${client._name}`);
            };
        };
    };

    addbot(server, args) {
        const amount = parseInt(args[1]) || 1;
        server.config.serverBots += amount;

        for (let i = 0; i != amount; i++) {
            server.bots.addBot();
        };

        return Logger.success(`Added ${amount} player bot${amount > 1 ? "s"  : ""} to the game. Use the rmbot command to remove them.`);
    };

    rmbot(server, args) {
        const amount = parseInt(args[1]) || server.clients.length;
        const botClients = server.clients
            .filter(socket => socket.playerTracker?.isBot)
            .sort((a, b) => {
                const getNumber = name => parseInt(name?.split(" ")[1]) || 0;
                return getNumber(b.playerTracker._name) - getNumber(a.playerTracker._name);
            });

        const toRemove = botClients.slice(0, amount);
        let removed = 0;
        for (const socket of toRemove) {
            const client = socket.playerTracker;
            if (typeof socket._botId === "number") {
                server.bots.releaseBotId(socket._botId);
            }
            if (server.bots && typeof server.bots.forgetBotPlayer === "function") {
                server.bots.forgetBotPlayer(client.pID);
            }
            if (client?.cells?.length) {
                while (client.cells.length) {
                    const cell = client.cells[0];
                    server.removeNode(cell);
                }
            }
            client.isRemoved = true;
            const index = server.clients.indexOf(socket);
            if (index !== -1) server.clients.splice(index, 1);
            if (socket._socket?.destroy) socket._socket.destroy();
            socket.close();

            removed++;
            server.config.serverBots = Math.max(server.config.serverBots - 1, 0);
        }
        return Logger.success(`Removed ${removed} bot${removed !== 1 ? "s" : ""} from the server.`);
    }

    kick(server, args) {
        const ID = parseInt(args[1]) || args[1];
        let total = 0;

        // Check if server is empty.
        if(!server.clients.length) {
            return Logger.warn("The server is empty.");
        };


        server.clients.forEach(socket => {
            const client = socket.playerTracker;

            if(client.pID == ID || ID == "all") {
                socket.close();
               return total++;
            };
        });

        if(total > 0) {
            return Logger.success(`Kicked ${total} client${total > 1 ? "s" : ""}.`);
        } else if (total == 0 && ID != "all") {
            return Logger.warn(`Please provide an amount of bots to kick. Or provide "all" to kick all bots.`)
        };
    };

    killall(server, args) {
        if (typeof server.killAllPlayersAndRefillViruses !== "function") {
            return Logger.warn("Killall handler is unavailable.");
        }

        server.killAllPlayersAndRefillViruses("host-command");
    };

    mass(server, args) {
        const ID = parseInt(args[1]);
        const mass = Math.sqrt((parseInt(args[2])) * 100);

        if (isNaN(ID)) {
            return Logger.warn(`Please provide a numerical player ID.`);
        };

        if(isNaN(mass)) {
            return Logger.warn(`Please provide a numerical mass.`);
        };

        server.clients.forEach(socket => {
            const client = socket.playerTracker;

            if(client.pID == ID) {
                client.cells.forEach(cell => {
                    cell.setSize(mass);
                });

                return Logger.success(`Set ${client._name || "An unnamed cell"}'s mass to ${mass}`);
            };
        });

    };

    restart(server, args) {
        if (typeof server.requestRestart !== "function") {
            return Logger.warn("Restart handler is unavailable.");
        }
        server.requestRestart();
    }

    exit(server, args) {
        const exitCode = args[1]; // Optional exit code.

        Logger.info("Exiting server...");
        return process.exit(exitCode);
    };

    stats(server, args) {
        Logger.info(`Connected players: ${server.clients.length} / ${server.config.serverMaxConnections}`);
        Logger.info(`Clients: ${server.clients.length}`);
        Logger.info(`Server uptime: ${Math.floor(process.uptime() / 60)}`);
        Logger.info(`Process memory usage ${Math.round(process.memoryUsage().heapUsed / 1048576 * 10) / 10 }/${Math.round(process.memoryUsage().heapTotal / 1048576 * 10) / 10} mb`);
        Logger.info(`Update time: ${server.updateTimeAvg.toFixed(3)}ms`);
    }

    aliases(server, args) {
        const commands = Object.getOwnPropertyNames(CommandsList.prototype); // List of methods.
        commands.shift(); // Remove constructor.

        commands.forEach(command => {
            const commandObj = CommandsList.prototype[command]; // Command object.
            const aliasName = commandObj.name[0] + commandObj.name[commandObj.name.length - 1]; // Alias name.

            // Ignore aliases, only print commands.
            if(CommandsList.prototype[commandObj.name]) {
                CommandsList.prototype[aliasName] = (server, args) => CommandsList.prototype[commandObj.name](server, args);
                CommandsList.prototype[aliasName].isAlias = true;
            };
        });

        return Logger.success("Aliases generated.");
    };
};

module.exports = new CommandsList();
