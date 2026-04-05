var Packet = require('../packet');
var BinaryReader = require('../packet/BinaryReader');

class PacketHandler {
    constructor(server, socket) {
        this.server = server;
        this.socket = socket;
        this.protocol = 0;
        this.handshakeProtocol = null;
        this.handshakeKey = null;
        this.lastJoinTick = 0;
        this.lastStatTick = 0;
        this.lastQTick = 0;
        this.lastSpaceTick = 0;
        this.pressQ = false;
        this.pressW = false;
        this.pressSpace = false;
        this.mouseData = null;
        this.handler = {
            254: this.handshake_onProtocol.bind(this),
        };
    }
    handleMessage(message) {
        if (!this.handler.hasOwnProperty(message[0]))
            return;
        this.handler[message[0]](message);
        this.socket.lastAliveTime = this.server.stepDateTime;
    }
    handshake_onProtocol(message) {
        if (message.length !== 5)
            return;
        this.handshakeProtocol = message[1] | (message[2] << 8) | (message[3] << 16) | (message[4] << 24);
        if (this.handshakeProtocol < 1 || this.handshakeProtocol > 18) {
            this.socket.close(1002, "Not supported protocol: " + this.handshakeProtocol);
            return;
        }
        this.handler = {
            255: this.handshake_onKey.bind(this),
        };
    }
    handshake_onKey(message) {
        if (message.length !== 5)
            return;
        this.handshakeKey = message[1] | (message[2] << 8) | (message[3] << 16) | (message[4] << 24);
        if (this.handshakeProtocol > 6 && this.handshakeKey !== 0) {
            this.socket.close(1002, "Not supported protocol");
            return;
        }
        this.handshake_onCompleted(this.handshakeProtocol, this.handshakeKey);
    }
    handshake_onCompleted(protocol, key) {
        this.handler = {
            0: this.message_onJoin.bind(this),
            1: this.message_onSpectate.bind(this),
            16: this.message_onMouse.bind(this),
            17: this.message_onKeySpace.bind(this),
            18: this.message_onKeyQ.bind(this),
            21: this.message_onKeyW.bind(this),
            22: this.message_onSpectateZoomIn.bind(this),
            23: this.message_onSpectateZoomOut.bind(this),
            254: this.message_onStat.bind(this),
        };
        this.protocol = protocol;
        // Send handshake response
        this.sendPacket(new Packet.ClearAll());
        this.sendPacket(new Packet.SetBorder(this.socket.playerTracker, this.server.border, this.server.config.serverGamemode, "SFA Server " + this.server.version));
    }
    message_onJoin(message) {
        var tick = this.server.ticks;
        var dt = tick - this.lastJoinTick;
        this.lastJoinTick = tick;
        if (dt < 25 || this.socket.playerTracker.cells.length !== 0) {
            return;
        }
        var reader = new BinaryReader(message);
        reader.skipBytes(1);
        var text = null;
        if (this.protocol < 6)
            text = reader.readStringZeroUnicode();
        else
            text = reader.readStringZeroUtf8();
        this.setNickname(text);
    }
    message_onSpectate(message) {
        if (message.length !== 1 || this.socket.playerTracker.cells.length !== 0) {
            return;
        }
        this.socket.playerTracker.spectate = true;
        this.socket.playerTracker.freeRoam = true;
        this.socket.playerTracker.spectateTarget = null;
        this.socket.playerTracker.spectateScale = 0.12;
    }
    message_onMouse(message) {
        if (message.length !== 13 && message.length !== 9 && message.length !== 21) {
            return;
        }
        this.mouseData = Buffer.concat([message]);
    }
    message_onKeySpace(message) {
        if (this.socket.playerTracker.miQ) {
            this.socket.playerTracker.minionSplit = true;
        }
        else {
            this.pressSpace = true;
        }
    }
    message_onKeyQ(message) {
        if (message.length !== 1)
            return;
        if (this.socket.playerTracker.spectate) {
            this.pressQ = true;
            return;
        }
        var tick = this.server.ticks;
        var dt = tick - this.lastQTick;
        if (dt < this.server.config.ejectCooldown) {
            return;
        }
        this.lastQTick = tick;
        if (!this.server.config.disableQ) {
            this.socket.playerTracker.miQ = !this.socket.playerTracker.miQ;
        }
        else {
            this.pressQ = true;
        }
    }
    message_onKeyW(message) {
        if (message.length !== 1)
            return;
        if (this.socket.playerTracker.miQ) {
            this.socket.playerTracker.minionEject = true;
        }
        else {
            this.pressW = true;
        }
    }
    message_onSpectateZoomIn(message) {
        if (message.length !== 1)
            return;
        if (!this.socket.playerTracker.spectate)
            return;
        this.socket.playerTracker.changeSpectateScale(1);
    }
    message_onSpectateZoomOut(message) {
        if (message.length !== 1)
            return;
        if (!this.socket.playerTracker.spectate)
            return;
        this.socket.playerTracker.changeSpectateScale(-1);
    }
    message_onStat(message) {
        if (message.length !== 1)
            return;
        var tick = this.server.ticks;
        var dt = tick - this.lastStatTick;
        this.lastStatTick = tick;
        if (dt < 25) {
            return;
        }
        this.sendPacket(new Packet.ServerStat(this.socket.playerTracker));
    }
    processMouse() {
        if (this.mouseData == null)
            return;
        var client = this.socket.playerTracker;
        var reader = new BinaryReader(this.mouseData);
        reader.skipBytes(1);
        if (this.mouseData.length === 13) {
            // protocol late 5, 6, 7
            client.mouse.x = reader.readInt32() - client.scrambleX;
            client.mouse.y = reader.readInt32() - client.scrambleY;
        }
        else if (this.mouseData.length === 9) {
            // early protocol 5
            client.mouse.x = reader.readInt16() - client.scrambleX;
            client.mouse.y = reader.readInt16() - client.scrambleY;
        }
        else if (this.mouseData.length === 21) {
            // protocol 4
            client.mouse.x = ~~reader.readDouble() - client.scrambleX;
            client.mouse.y = ~~reader.readDouble() - client.scrambleY;
        }
        this.mouseData = null;
    }
    process() {
        if (this.pressSpace) { // Split cell
            this.socket.playerTracker.pressSpace();
            this.pressSpace = false;
        }
        if (this.pressW) { // Eject mass
            this.socket.playerTracker.pressW();
            this.pressW = false;
        }
        if (this.pressQ) { // Q Press
            this.socket.playerTracker.pressQ();
            this.pressQ = false;
        }
        if (this.socket.playerTracker.minionSplit) {
            this.socket.playerTracker.minionSplit = false;
        }
        if (this.socket.playerTracker.minionEject) {
            this.socket.playerTracker.minionEject = false;
        }
        this.processMouse();
    }
    setNickname(text) {
        var name = "", skin = null;
        if (text != null && text.length > 0) {
            name = text;
        }
        this.socket.playerTracker.joinGame(name, skin);
    }
    sendPacket(packet) {
        var socket = this.socket;
        if (!packet || !socket.isConnected || socket.playerTracker.isMi ||
            socket.playerTracker.isBot) return;
        if (socket.readyState == this.server.WebSocket.OPEN) {
            var buffer = packet.build(this.protocol);
            if (buffer)
                socket.send(buffer, { binary: true });
        }
        else {
            socket.emit('close');
        }
    }
}

module.exports = PacketHandler;
