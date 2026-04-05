const PlayerTracker = require('../server/PlayerTracker');
const Vec2 = require('../modules/Vec2');

const decideTypes = [
    function decidePlayer(node, cell) {
        // Same team, don't eat
        if (this.server.mode.haveTeams && cell.owner.team == node.owner.team)
            return 0;
        if (cell._size > node._size * 1.15) // Edible
            return node._size * 2.5;
        if (node._size > cell._size * 1.15) // Bigger, avoid
            return -node._size;
        return -(node._size / cell._size) / 3;
    },
    function decideFood(node, cell) { // Always edible
        return 1;
    },
    function decideVirus(node, cell) {
        const behavior = this.server.config.botsAvoidViruses;

        if (cell._size > node._size * 1.15) { // Edible
            if (this.cells.length == this.server.config.playerMaxCells) {
                // Reached cell limit, won't explode
                return node._size * 2.5;
            }
            return -behavior * 0.8;
        }
        if (node.isMotherCell && node._size > cell._size * 1.15) {
            // Avoid mother cell (same logic for all behaviors)
            return -1;
        }
        return 0;
    },
    function decideEjected(node, cell) {
        if (cell._size > node._size * 1.15)
            return node._size;
        return 0;
    }
];

class BotPlayer extends PlayerTracker {
    constructor(server, socket) {
        super(server, socket);
        this.isBot = true;
        this.decisionWorker = server && server.bots ? server.bots.decisionWorker : null;
        this.decisionCellLimit = 10;
        this.influence = 0;
        this.splitCooldown = 0;
        this.steerVec = new Vec2(0, 0);
        this.lastMoveDir = new Vec2(1, 0);
        this.idleTicks = 0;
        this.wanderAngle = Math.random() * Math.PI * 2;
    }

    getDecisionCells(limit = 10) {
        if (!this.cells.length)
            return [];
        const sorted = this.cells
            .slice()
            .sort((a, b) => b._size - a._size);
        const totalSize = sorted.reduce((sum, cell) => sum + cell._size, 0);
        const largestSize = sorted[0]._size;
        const dominance = totalSize > 0 ? largestSize / totalSize : 1;

        // Adaptive count: few cells when one giant dominates, more when sizes are even.
        const adaptiveCount = Math.max(1, Math.min(limit, Math.round(limit * (1 - dominance) + 1)));
        return sorted.slice(0, adaptiveCount);
    }

    getWeightedCenter(cells) {
        let totalWeight = 0;
        const center = new Vec2(0, 0);
        for (const cell of cells) {
            totalWeight += cell._size;
            center.add(cell.position.product(cell._size));
        }
        if (!totalWeight)
            return this.centerPos.clone();
        return center.quotient(totalWeight);
    }

    getMaxCellsForSplit() {
        const maxCells = this.server.config.playerMaxCells || 16;
        // Keep bots from over-fragmenting while still respecting higher server caps.
        return Math.max(2, Math.min(maxCells, 24));
    }

    getSplitRange(cell) {
        const splitCellSize = cell._size / Math.sqrt(2);
        const boostDistance = this.server.config.splitVelocity * Math.pow(splitCellSize, 0.0122);
        return boostDistance + splitCellSize * 1.5 + 80;
    }

    canSplitKill(cell, node, distance) {
        if (node.type !== 0 || !node.owner)
            return false;
        if (this.server.mode.haveTeams && cell.owner.team == node.owner.team)
            return false;

        // After splitting, daughter cell must still be safely larger than target.
        if (cell._size < Math.max(this.server.config.playerMinSplitSize, node._size * 2.6))
            return false;

        // Ignore tiny targets so bot splits are not wasted.
        const minWorthwhileTarget = Math.max(this.server.config.playerMinSize * 1.5, cell._size * 0.12);
        if (node._size < minWorthwhileTarget)
            return false;

        return distance <= this.getSplitRange(cell);
    }

    isSplitUnsafe(cell, target, distance) {
        if (!target || target.type !== 0)
            return false;

        const splitSize = cell._size / Math.sqrt(2);
        const splitRange = this.getSplitRange(cell);
        const toTarget = target.position.difference(cell.position);
        const toTargetDist = Math.max(1, toTarget.dist());
        const projectedTravel = Math.min(distance, splitRange * 0.92);
        const direction = toTarget.quotient(toTargetDist);
        const projectedPos = cell.position.sum(direction.product(projectedTravel));
        const safetyMargin = splitSize * 0.65 + 50;

        for (const enemy of this.viewNodes) {
            if (!enemy || enemy.type !== 0 || !enemy.owner)
                continue;
            if (enemy.owner === this || enemy === target)
                continue;
            if (this.server.mode.haveTeams && enemy.owner.team == cell.owner.team)
                continue;

            const enemyDist = enemy.position.difference(projectedPos).dist();
            const directThreat = enemy._size > splitSize * 1.15 &&
                enemyDist <= enemy._size + splitSize + safetyMargin;

            let splitThreat = false;
            const enemySplitSize = enemy._size / Math.sqrt(2);
            if (enemySplitSize > splitSize * 1.15) {
                const enemySplitRange = this.getSplitRange(enemy);
                splitThreat = enemyDist <= enemySplitRange + enemySplitSize + splitSize * 0.4;
            }

            if (directThreat || splitThreat)
                return true;
        }

        return false;
    }

    largest(list) {
        return list.reduce((largest, current) => {
            return current._size > largest._size ? current : largest;
        });
    }

    evaluateCellDecision(cell, canAttemptSplit) {
        const result = new Vec2(0, 0);
        let splitTarget = null;
        let splitDistance = 0;
        let splitScore = -Infinity;

        for (const node of this.viewNodes) {
            if (node.owner == this) continue;
            this.influence = decideTypes[node.type].call(this, node, cell);
            if (this.influence == 0) continue;

            const displacement = node.position.difference(cell.position);
            let distance = displacement.dist();
            if (this.influence < 0)
                distance -= cell._size + node._size;
            if (distance < 1) distance = 1;

            this.influence /= distance;

            if (canAttemptSplit && this.canSplitKill(cell, node, distance) && !this.isSplitUnsafe(cell, node, distance)) {
                const score = node._size * 2 - distance * 0.35;
                if (score > splitScore) {
                    splitScore = score;
                    splitTarget = node;
                    splitDistance = distance;
                }
            }

            result.add(displacement.normalize().product(this.influence));
        }

        return {
            result,
            splitTarget,
            splitDistance,
            splitScore
        };
    }

    findUnstuckTarget(anchor, largestCell) {
        let bestNode = null;
        let bestScore = -Infinity;

        for (const node of this.viewNodes) {
            if (!node || node.owner == this)
                continue;

            const distance = Math.max(1, node.position.difference(anchor).dist());
            let score = 0;

            if (node.type === 1) {
                // Food: weak but stable pull to keep motion alive.
                score = 2 / distance;
            }
            else if (node.type === 3) {
                // Ejected mass: better short-term objective when stuck.
                score = 3 / distance;
            }
            else if (node.type === 0 && largestCell && largestCell._size > node._size * 1.15) {
                score = (node._size * 1.2) / distance;
            }

            if (score > bestScore) {
                bestScore = score;
                bestNode = node;
            }
        }

        return bestNode ? bestNode.position.clone() : null;
    }

    getWanderTarget(anchor) {
        this.wanderAngle += (Math.random() - 0.5) * 0.9;
        return anchor.sum(Vec2.fromAngle(this.wanderAngle).product(700));
    }

    applySmoothedMovement(anchor, steeringResult, largestCell) {
        if (steeringResult.dist() > 0.0001) {
            this.steerVec.multiply(0.8).add(steeringResult.product(0.2));
        }
        else {
            this.steerVec.multiply(0.9);
        }

        const steerMag = this.steerVec.dist();
        if (steerMag > 0.001) {
            this.lastMoveDir.assign(this.steerVec.quotient(steerMag));
            this.idleTicks = 0;
        }
        else {
            this.idleTicks++;
        }

        if (this.idleTicks > 18) {
            const unstuckTarget = this.findUnstuckTarget(anchor, largestCell) || this.getWanderTarget(anchor);
            this.mouse.assign(unstuckTarget);
            this.idleTicks = 6;
            return;
        }

        const moveDistance = steerMag > 0.001
            ? 900 * Math.max(0.45, Math.min(1.25, steerMag * 1.8))
            : 320;
        this.mouse.assign(anchor.sum(this.lastMoveDir.product(moveDistance)));
    }

    checkConnection() {
        // Respawn if bot is dead
        if (!this.cells.length)
            this.server.mode.onPlayerSpawn(this.server, this);
    }

    buildDecisionSnapshot() {
        const nodes = [];
        const maxNodes = 220;
        for (let i = 0; i < this.viewNodes.length && nodes.length < maxNodes; i++) {
            const node = this.viewNodes[i];
            if (!node || node.owner == this)
                continue;
            nodes.push({
                nodeId: node.nodeId,
                type: node.type,
                x: node.position.x,
                y: node.position.y,
                size: node._size,
                isMotherCell: !!node.isMotherCell,
                ownerId: node.owner ? node.owner.pID : null,
                ownerTeam: node.owner ? node.owner.team : null
            });
        }

        const cells = this.cells.map((cell) => ({
            x: cell.position.x,
            y: cell.position.y,
            size: cell._size,
            team: this.team
        }));

        return {
            id: this.pID,
            centerPosX: this.centerPos.x,
            centerPosY: this.centerPos.y,
            splitCooldown: this.splitCooldown,
            steerVec: { x: this.steerVec.x, y: this.steerVec.y },
            lastMoveDir: { x: this.lastMoveDir.x, y: this.lastMoveDir.y },
            idleTicks: this.idleTicks,
            wanderAngle: this.wanderAngle,
            decisionCellLimit: this.decisionCellLimit,
            cells,
            nodes
        };
    }

    applyWorkerAction(action) {
        if (!action)
            return;

        if (action.state) {
            this.splitCooldown = action.state.splitCooldown;
            if (action.state.steerVec) {
                this.steerVec.x = action.state.steerVec.x;
                this.steerVec.y = action.state.steerVec.y;
            }
            if (action.state.lastMoveDir) {
                this.lastMoveDir.x = action.state.lastMoveDir.x;
                this.lastMoveDir.y = action.state.lastMoveDir.y;
            }
            if (typeof action.state.idleTicks === 'number')
                this.idleTicks = action.state.idleTicks;
            if (typeof action.state.wanderAngle === 'number')
                this.wanderAngle = action.state.wanderAngle;
        }

        if (typeof action.mouseX === 'number' && typeof action.mouseY === 'number') {
            this.mouse.x = action.mouseX;
            this.mouse.y = action.mouseY;
        }

        if (action.split)
            this.socket.packetHandler.pressSpace = true;
    }

    sendUpdate() {
        if (this.decisionWorker && this.decisionWorker.enabled) {
            const action = this.decisionWorker.getAction(this.pID);
            this.applyWorkerAction(action);
            this.decisionWorker.submitSnapshot(this.buildDecisionSnapshot());
            return;
        }
        this.decide();
    }

    decide() {
        var cellsToDecide = 10;

        const decisionCells = this.getDecisionCells(cellsToDecide);
        if (!decisionCells.length)
            return;

        const anchor = this.getWeightedCenter(decisionCells);
        const result = new Vec2(0, 0);
        let totalWeight = 0;
        let splitTarget = null;
        let splitDistance = 0;
        let splitScore = -Infinity;
        const splitCell = this.largest(decisionCells);
        const canAttemptSplit = this.server.config.botsCanSplit && !this.splitCooldown && this.cells.length < this.getMaxCellsForSplit();

        for (const cell of decisionCells) {
            const weight = cell._size;
            const decision = this.evaluateCellDecision(cell, canAttemptSplit);

            result.add(decision.result.product(weight));
            totalWeight += weight;

            if (decision.splitTarget && decision.splitScore > splitScore) {
                splitScore = decision.splitScore;
                splitTarget = decision.splitTarget;
                splitDistance = decision.splitDistance;
            }
        }

        // Validate split once more against the largest active cell before committing.
        if (splitTarget && splitCell && this.canSplitKill(splitCell, splitTarget, splitDistance) && !this.isSplitUnsafe(splitCell, splitTarget, splitDistance)) {
            this.splitCooldown = this.server.config.botSplitCooldown;
            this.mouse.assign(splitTarget.position);
            this.socket.packetHandler.pressSpace = true;
            return;
        }

        if (totalWeight > 0)
            result.multiply(1 / totalWeight);

        this.applySmoothedMovement(anchor, result, splitCell);
        if (this.splitCooldown > 0)
            this.splitCooldown--;
    }
}

module.exports = BotPlayer;
