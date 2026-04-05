var Mode = require('./Mode');

class Teams extends Mode{
    constructor() {
        super();
        this.ID = 1;
        this.name = "Teams";
        this.decayMod = 1.5;
        this.packetLB = 50;
        this.haveTeams = true;
        this.colorFuzziness = 16;
        // Special
        this.teamAmount = 3;
        this.colors = [
            { r: 210, g: 70,  b: 70  },  // red
            { r: 210, g: 130, b: 60  },  // orange
            { r: 200, g: 180, b: 60  },  // yellow
            { r: 120, g: 170, b: 70  },  // green
            { r: 60,  g: 170, b: 140 },  // teal
            { r: 60,  g: 140, b: 210 },  // blue
            { r: 120, g: 100, b: 210 },  // purple
            { r: 170, g: 90,  b: 190 },  // magenta
            { r: 180, g: 100, b: 120 },  // rose
            { r: 140, g: 110, b: 70  },  // brown
            { r: 90,  g: 130, b: 70  },  // olive
            { r: 90,  g: 130, b: 150 }   // slate
        ]; // Make sure you add extra colors here if you wish to increase the team amount
        // NOTE: If you add more colors, make sure to add the same colors into the client jss/main_out.js:596
        this.nodes = []; // Teams
        this.serverRef = null;
    }
    //Gamemode Specific Functions
    clamp(v) {
        return Math.max(0, Math.min(255, v));
    }
    getColorJitter(range) {
        return (Math.random() * (range * 2 + 1) >> 0) - range;
    }
    getTeamColor(team) {
        const base = this.colors[team];
        const j = this.getColorJitter(this.colorFuzziness);

        return {
            r: this.clamp(base.r + j),
            g: this.clamp(base.g + j),
            b: this.clamp(base.b + j)
        };
    }
    getLeastPopulatedTeam(server) {
        if (!server || !server.clients || !server.clients.length)
            return Math.floor(Math.random() * this.teamAmount);

        const teamPlayers = new Array(this.teamAmount).fill(0);
        for (var i = 0; i < server.clients.length; i++) {
            const socket = server.clients[i];
            const client = socket && socket.playerTracker;
            if (!client || client.isMi || client.isRemoved)
                continue;
            if (client.team >= 0 && client.team < this.teamAmount)
                teamPlayers[client.team]++;
        }

        var minCount = Number.MAX_SAFE_INTEGER;
        var candidates = [];
        for (var team = 0; team < this.teamAmount; team++) {
            if (teamPlayers[team] < minCount) {
                minCount = teamPlayers[team];
                candidates = [team];
            }
            else if (teamPlayers[team] == minCount) {
                candidates.push(team);
            }
        }
        return candidates[(Math.random() * candidates.length) >> 0];
    }
    // Override
    onPlayerSpawn(server, player) {
        player.team = this.getLeastPopulatedTeam(server);
        // Team color based on balanced team selection
        player.color = this.getTeamColor(player.team);
        // Spawn player
        server.spawnPlayer(player, server.randomPos());
    }
    onServerInit(server) {
        this.serverRef = server;
        // Set up teams
        var configured = parseInt(server.config.teamAmount, 10);
        if (isNaN(configured) || configured < 1) configured = 3;
        this.teamAmount = Math.min(configured, this.colors.length); // clamp team amount to # of colors

        for (var i = 0; i < this.teamAmount; i++) {
            this.nodes[i] = [];
        }
        // migrate current players to team mode
        for (var i = 0; i < server.clients.length; i++) {
            var client = server.clients[i].playerTracker;
            this.onPlayerInit(client);
            client.color = this.getTeamColor(client.team);
            for (var j = 0; j < client.cells.length; j++) {
                var cell = client.cells[j];
                cell.color = client.color;
                this.nodes[client.team].push(cell);
            }
        }
    }
    onPlayerInit(player) {
        // Assign least-populated team when player tracker is created.
        player.team = this.getLeastPopulatedTeam(this.serverRef);
    }
    onCellAdd(cell) {
        // Add to team list
        this.nodes[cell.owner.team].push(cell);
    }
    onCellRemove(cell) {
        // Remove from team list
        var index = this.nodes[cell.owner.team].indexOf(cell);
        if (index != -1) {
            this.nodes[cell.owner.team].splice(index, 1);
        }
    }
    onCellMove(cell, server) {
        // Find team
        for (var i = 0; i < cell.owner.visibleNodes.length; i++) {
            // Only collide with player cells
            var check = cell.owner.visibleNodes[i];
            if ((check.type != 0) || (cell.owner == check.owner)) {
                continue;
            }
            // Collision with teammates
            var team = cell.owner.team;
            if (check.owner.team == team) {
                var manifold = server.checkCellCollision(cell, check); // Calculation info
                if (manifold != null) { // Collided
                    // Cant eat team members
                    !manifold.check.canEat(manifold.cell);
                }
            }
        }
    }
    updateLB(server) {
        server.leaderboardType = this.packetLB;
        var total = 0;
        var teamMass = [];
        // Get mass
        for (var i = 0; i < this.teamAmount; i++) {
            // Set starting mass
            teamMass[i] = 0;
            // Loop through cells
            for (var j = 0; j < this.nodes[i].length; j++) {
                var cell = this.nodes[i][j];
                if (!cell)
                    continue;
                teamMass[i] += cell._mass;
                total += cell._mass;
            }
        }
        // No players
        if (total <= 0) {
            for (var i = 0; i < this.teamAmount; i++) {
                server.leaderboard[i] = 0;
            }
            return;
        }
        // Calc percentage
        for (var i = 0; i < this.teamAmount; i++) {
            server.leaderboard[i] = teamMass[i] / total;
        }
    }
}

module.exports = Teams;
Teams.prototype = new Mode();