const { parentPort } = require('worker_threads');

if (!parentPort)
    process.exit(0);

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

function getDecisionCells(cells, limit) {
    if (!Array.isArray(cells) || !cells.length)
        return [];
    const sorted = cells.slice().sort((a, b) => b.size - a.size);
    const totalSize = sorted.reduce((sum, cell) => sum + cell.size, 0);
    const largestSize = sorted[0].size;
    const dominance = totalSize > 0 ? largestSize / totalSize : 1;
    const adaptiveCount = Math.max(1, Math.min(limit, Math.round(limit * (1 - dominance) + 1)));
    return sorted.slice(0, adaptiveCount);
}

function weightedCenter(cells) {
    let totalWeight = 0;
    let x = 0;
    let y = 0;
    for (const cell of cells) {
        totalWeight += cell.size;
        x += cell.x * cell.size;
        y += cell.y * cell.size;
    }
    if (!totalWeight)
        return { x: 0, y: 0 };
    return { x: x / totalWeight, y: y / totalWeight };
}

function distance(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
}

function normalize(dx, dy) {
    const mag = Math.sqrt(dx * dx + dy * dy);
    if (!mag)
        return { x: 0, y: 0, mag: 0 };
    return { x: dx / mag, y: dy / mag, mag };
}

function getSplitRange(size, splitVelocity) {
    const splitCellSize = size / Math.sqrt(2);
    const boostDistance = splitVelocity * Math.pow(splitCellSize, 0.0122);
    return boostDistance + splitCellSize * 1.5 + 80;
}

function decideInfluence(node, cell, shared, cellCount) {
    switch (node.type) {
        case 0:
            if (shared.haveTeams && cell.team === node.ownerTeam)
                return 0;
            if (cell.size > node.size * 1.15)
                return node.size * 2.5;
            if (node.size > cell.size * 1.15)
                return -node.size;
            return -(node.size / cell.size) / 3;
        case 1:
            return 1;
        case 2:
            if (cell.size > node.size * 1.15) {
                if (cellCount === shared.config.playerMaxCells)
                    return node.size * 2.5;
                return -shared.config.botsAvoidViruses * 0.8;
            }
            if (node.isMotherCell && node.size > cell.size * 1.15)
                return -1;
            return 0;
        case 3:
            if (cell.size > node.size * 1.15)
                return node.size;
            return 0;
        default:
            return 0;
    }
}

function canSplitKill(cell, node, dist, shared) {
    if (node.type !== 0 || node.ownerId == null)
        return false;
    if (shared.haveTeams && cell.team === node.ownerTeam)
        return false;

    if (cell.size < Math.max(shared.config.playerMinSplitSize, node.size * 2.6))
        return false;

    const minWorthwhileTarget = Math.max(shared.config.playerMinSize * 1.5, cell.size * 0.12);
    if (node.size < minWorthwhileTarget)
        return false;

    return dist <= getSplitRange(cell.size, shared.config.splitVelocity);
}

function isSplitUnsafe(cell, target, dist, nodes, selfId, shared) {
    if (!target || target.type !== 0)
        return false;

    const splitSize = cell.size / Math.sqrt(2);
    const splitRange = getSplitRange(cell.size, shared.config.splitVelocity);
    const toTargetDx = target.x - cell.x;
    const toTargetDy = target.y - cell.y;
    const toTargetNorm = normalize(toTargetDx, toTargetDy);
    const projectedTravel = Math.min(dist, splitRange * 0.92);
    const projectedPos = {
        x: cell.x + toTargetNorm.x * projectedTravel,
        y: cell.y + toTargetNorm.y * projectedTravel
    };
    const safetyMargin = splitSize * 0.65 + 50;

    for (const enemy of nodes) {
        if (!enemy || enemy.type !== 0 || enemy.ownerId == null)
            continue;
        if (enemy.ownerId === selfId || enemy.nodeId === target.nodeId)
            continue;
        if (shared.haveTeams && enemy.ownerTeam === cell.team)
            continue;

        const enemyDist = distance(projectedPos, enemy);
        const directThreat = enemy.size > splitSize * 1.15 &&
            enemyDist <= enemy.size + splitSize + safetyMargin;

        let splitThreat = false;
        const enemySplitSize = enemy.size / Math.sqrt(2);
        if (enemySplitSize > splitSize * 1.15) {
            const enemySplitRange = getSplitRange(enemy.size, shared.config.splitVelocity);
            splitThreat = enemyDist <= enemySplitRange + enemySplitSize + splitSize * 0.4;
        }

        if (directThreat || splitThreat)
            return true;
    }

    return false;
}

function findUnstuckTarget(anchor, largestCell, nodes, selfId, shared) {
    let bestNode = null;
    let bestScore = -Infinity;

    for (const node of nodes) {
        if (!node || node.ownerId === selfId)
            continue;

        const dist = Math.max(1, distance(anchor, node));
        let score = 0;

        if (node.type === 1) {
            score = 2 / dist;
        } else if (node.type === 3) {
            score = 3 / dist;
        } else if (node.type === 0 && largestCell && largestCell.size > node.size * 1.15) {
            score = (node.size * 1.2) / dist;
        }

        if (score > bestScore) {
            bestScore = score;
            bestNode = node;
        }
    }

    return bestNode ? { x: bestNode.x, y: bestNode.y } : null;
}

function evaluateCellDecision(cell, nodes, canAttemptSplit, selfId, shared, cellCount) {
    let rx = 0;
    let ry = 0;
    let splitTarget = null;
    let splitDistance = 0;
    let splitScore = -Infinity;

    for (const node of nodes) {
        if (!node || node.ownerId === selfId)
            continue;

        let influence = decideInfluence(node, cell, shared, cellCount);
        if (influence === 0)
            continue;

        const dx = node.x - cell.x;
        const dy = node.y - cell.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (influence < 0)
            dist -= cell.size + node.size;
        if (dist < 1)
            dist = 1;

        influence /= dist;

        if (canAttemptSplit && canSplitKill(cell, node, dist, shared) && !isSplitUnsafe(cell, node, dist, nodes, selfId, shared)) {
            const score = node.size * 2 - dist * 0.35;
            if (score > splitScore) {
                splitScore = score;
                splitTarget = node;
                splitDistance = dist;
            }
        }

        const norm = normalize(dx, dy);
        rx += norm.x * influence;
        ry += norm.y * influence;
    }

    return {
        result: { x: rx, y: ry },
        splitTarget,
        splitDistance,
        splitScore
    };
}

function decideForBot(snapshot, shared) {
    const id = snapshot.id;
    const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
    const cells = Array.isArray(snapshot.cells) ? snapshot.cells : [];

    const state = {
        splitCooldown: typeof snapshot.splitCooldown === 'number' ? snapshot.splitCooldown : 0,
        steerVec: snapshot.steerVec || { x: 0, y: 0 },
        lastMoveDir: snapshot.lastMoveDir || { x: 1, y: 0 },
        idleTicks: typeof snapshot.idleTicks === 'number' ? snapshot.idleTicks : 0,
        wanderAngle: typeof snapshot.wanderAngle === 'number' ? snapshot.wanderAngle : Math.random() * Math.PI * 2
    };

    if (!cells.length) {
        return {
            id,
            split: false,
            mouseX: snapshot.centerPosX || 0,
            mouseY: snapshot.centerPosY || 0,
            state
        };
    }

    const decisionCellLimit = Math.max(1, Math.min(snapshot.decisionCellLimit || 3, 10));
    const decisionCells = getDecisionCells(cells, decisionCellLimit);
    const anchor = weightedCenter(decisionCells);
    let resultX = 0;
    let resultY = 0;
    let totalWeight = 0;
    let splitTarget = null;
    let splitDistance = 0;
    let splitScore = -Infinity;

    const splitCell = decisionCells.reduce((largest, current) => current.size > largest.size ? current : largest);
    const canAttemptSplit = !!shared.config.botsCanSplit && state.splitCooldown <= 0 && cells.length < Math.max(2, Math.min(shared.config.playerMaxCells || 16, 24));

    for (const cell of decisionCells) {
        const weight = cell.size;
        const decision = evaluateCellDecision(cell, nodes, canAttemptSplit, id, shared, cells.length);

        resultX += decision.result.x * weight;
        resultY += decision.result.y * weight;
        totalWeight += weight;

        if (decision.splitTarget && decision.splitScore > splitScore) {
            splitScore = decision.splitScore;
            splitTarget = decision.splitTarget;
            splitDistance = decision.splitDistance;
        }
    }

    if (splitTarget && canSplitKill(splitCell, splitTarget, splitDistance, shared) && !isSplitUnsafe(splitCell, splitTarget, splitDistance, nodes, id, shared)) {
        state.splitCooldown = shared.config.botSplitCooldown || 15;
        return {
            id,
            split: true,
            mouseX: splitTarget.x,
            mouseY: splitTarget.y,
            state
        };
    }

    if (totalWeight > 0) {
        resultX /= totalWeight;
        resultY /= totalWeight;
    }

    const steeringMag = Math.sqrt(resultX * resultX + resultY * resultY);
    if (steeringMag > 0.0001) {
        state.steerVec = {
            x: state.steerVec.x * 0.8 + resultX * 0.2,
            y: state.steerVec.y * 0.8 + resultY * 0.2
        };
    } else {
        state.steerVec = {
            x: state.steerVec.x * 0.9,
            y: state.steerVec.y * 0.9
        };
    }

    const steerMag = Math.sqrt(state.steerVec.x * state.steerVec.x + state.steerVec.y * state.steerVec.y);
    if (steerMag > 0.001) {
        state.lastMoveDir = {
            x: state.steerVec.x / steerMag,
            y: state.steerVec.y / steerMag
        };
        state.idleTicks = 0;
    } else {
        state.idleTicks += 1;
    }

    let mouseX;
    let mouseY;

    if (state.idleTicks > 18) {
        state.wanderAngle += (Math.random() - 0.5) * 0.9;
        const unstuck = findUnstuckTarget(anchor, splitCell, nodes, id, shared) || {
            x: anchor.x + Math.cos(state.wanderAngle) * 700,
            y: anchor.y + Math.sin(state.wanderAngle) * 700
        };
        mouseX = unstuck.x;
        mouseY = unstuck.y;
        state.idleTicks = 6;
    } else {
        const moveDistance = steerMag > 0.001
            ? 900 * clamp(steerMag * 1.8, 0.45, 1.25)
            : 320;
        mouseX = anchor.x + state.lastMoveDir.x * moveDistance;
        mouseY = anchor.y + state.lastMoveDir.y * moveDistance;
    }

    if (state.splitCooldown > 0)
        state.splitCooldown -= 1;

    return {
        id,
        split: false,
        mouseX,
        mouseY,
        state
    };
}

parentPort.on('message', (msg) => {
    if (!msg || msg.type !== 'decideBatch' || !Array.isArray(msg.snapshots))
        return;

    const shared = {
        haveTeams: !!msg.haveTeams,
        config: Object.assign({
            botsAvoidViruses: 1,
            botsCanSplit: 1,
            playerMaxCells: 16,
            splitVelocity: 780,
            playerMinSplitSize: 59.16079783,
            playerMinSize: 31.6227766017,
            botSplitCooldown: 15
        }, msg.config || {})
    };

    const actions = [];
    for (const snapshot of msg.snapshots) {
        if (!snapshot || typeof snapshot.id !== 'number')
            continue;
        actions.push(decideForBot(snapshot, shared));
    }

    parentPort.postMessage({
        type: 'actions',
        actions
    });
});
