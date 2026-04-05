var BinaryWriter = require('./BinaryWriter');

class KillallNotification {
    constructor(sourceCode) {
        this.sourceCode = sourceCode | 0;
    }

    build(protocol) {
        var writer = new BinaryWriter();
        writer.writeUInt8(0x5A); // Packet ID (90)
        writer.writeUInt8(this.sourceCode);
        return writer.toBuffer();
    }
}

module.exports = KillallNotification;