myLog = require('./common').myLog;
color = require('./common').colors;

const crypto = require('crypto');
const noble = require('@abandonware/noble');

const RSSI_THRESHOLD = -92;
const BLE_devices = [];

noble.on('stateChange', state => {
    if (state === 'poweredOn') {
        myLog('noble.startScanning', color.green);
        noble.startScanning([], true);
    } else {
        noble.stopScanning();
    }
});

noble.on('discover', async (peripheral) => {
    if (peripheral.rssi < RSSI_THRESHOLD) {
        return;
    }
    try {
        let result = new miParser(peripheral.advertisement.serviceData[0].data, 'e85feb9d97474fcf329b0d611afb4e4a').parse();

        Object.keys(result.event).forEach(function(key){
            let id = peripheral.id;

            if (!BLE_devices[id]) {
                BLE_devices[id] = { id }
                BLE_devices.push(
                    {
                        "id": id,
                        "type": key,
                        "value": result.event[key],
                        "lastSeen": Date.now()
                    }
                );
                //myLog('store: ' + id + ', ' + key + ' : ' + result.event[key]);
            } else {
                BLE_devices[id].value = result.event[key];
                BLE_devices[id].lastSeen = Date.now();
                //myLog('update: ' + id + ', ' + key + ' : ' + result.event[key]);
            }
        });

        //require('./mqtt_client').publish_ble_sensor('battery', , peripheral);
    } catch (e) {
        //console.log(e);
    }
});

// Отправляем информацию обустройствах
this.getDevices = () => {
    myLog('devices = ' + BLE_devices.length, color.cyan);
    BLE_devices.forEach(element => {
        require('./mqtt_client').publish_ble_sensor(element);
    });
}

///////////////////////////////////////////

const FrameControlFlags = {
    isFactoryNew: 1 << 0,
    isConnected: 1 << 1,
    isCentral: 1 << 2,
    isEncrypted: 1 << 3,
    hasMacAddress: 1 << 4,
    hasCapabilities: 1 << 5,
    hasEvent: 1 << 6,
    hasCustomData: 1 << 7,
    hasSubtitle: 1 << 8,
    hasBinding: 1 << 9
};

const CapabilityFlags = {
    connectable: 1 << 0,
    central: 1 << 1,
    secure: 1 << 2,
    io: (1 << 3) | (1 << 4)
};

const EventTypes = {
    temperature: 4100,
    humidity: 4102,
    illuminance: 4103,
    moisture: 4104,
    fertility: 4105,
    battery: 4106,
    temperatureAndHumidity: 4109
};

class miParser {
    constructor(buffer, bindKey = null) {
        this.baseByteLength = 5;
        if (buffer == null) {
            throw new Error("A buffer must be provided.");
        }
        this.buffer = buffer;
        if (buffer.length < this.baseByteLength) {
            throw new Error(
                `Service data length must be >= 5 bytes. ${this.toString()}`
            );
        }
        this.bindKey = bindKey;
    }

    parse = () => {
        this.frameControl = this.parseFrameControl();
        this.version = this.parseVersion();
        this.productId = this.parseProductId();
        this.frameCounter = this.parseFrameCounter();
        this.macAddress = this.parseMacAddress();
        this.capabilities = this.parseCapabilities();

        if (this.frameControl.isEncrypted) {
            this.decryptPayload();
        }

        this.eventType = this.parseEventType();
        this.eventLength = this.parseEventLength();
        this.event = this.parseEventData();
        return {
            frameControl: this.frameControl,
            event: this.event,
            productId: this.productId,
            frameCounter: this.frameCounter,
            macAddress: this.macAddress,
            eventType: this.eventType,
            capabilities: this.capabilities,
            eventLength: this.eventLength,
            version: this.version
        };
    };

    parseFrameControl = () => {
        const frameControl = this.buffer.readUInt16LE(0);
        return Object.keys(FrameControlFlags).reduce((map, flag) => {
            map[flag] = (frameControl & FrameControlFlags[flag]) !== 0;
            return map;
        }, {});
    };

    parseVersion = () => this.buffer.readUInt8(1) >> 4;

    parseProductId = () => this.buffer.readUInt16LE(2);

    parseFrameCounter = () => this.buffer.readUInt8(4);

    parseMacAddress = () => {
        if (!this.frameControl.hasMacAddress) {
            return null;
        }
        const macBuffer = this.buffer.slice(
            this.baseByteLength,
            this.baseByteLength + 6
        );
        return Buffer.from(macBuffer)
            .reverse()
            .toString("hex");
    };

    get capabilityOffset() {
        if (!this.frameControl.hasMacAddress) {
            return this.baseByteLength;
        }
        return 11;
    }

    parseCapabilities = () => {
        if (!this.frameControl.hasCapabilities) {
            return null;
        }
        const capabilities = this.buffer.readUInt8(this.capabilityOffset);
        return Object.keys(CapabilityFlags).reduce((map, flag) => {
            map[flag] = (capabilities & CapabilityFlags[flag]) !== 0;
            return map;
        }, {});
    };

    get eventOffset() {
        let offset = this.baseByteLength;
        if (this.frameControl.hasMacAddress) {
            offset = 11;
        }
        if (this.frameControl.hasCapabilities) {
            offset += 1;
        }

        return offset;
    }

    parseEventType = () => {
        if (!this.frameControl.hasEvent) {
            return null;
        }
        return this.buffer.readUInt16LE(this.eventOffset);
    };

    parseEventLength = () => {
        if (!this.frameControl.hasEvent) {
            return null;
        }
        return this.buffer.readUInt8(this.eventOffset + 2);
    };

    decryptPayload = () => {
        const msgLength = this.buffer.length;
        const eventLength = msgLength - this.eventOffset;

        if (eventLength < 3) {
            return;
        }
        if (this.bindKey == null) {
            throw Error("Sensor data is encrypted. Please configure a bindKey.");
        }

        const encryptedPayload = this.buffer.slice(this.eventOffset, msgLength);

        const nonce = Buffer.concat([
            this.buffer.slice(5, 11), //mac_reversed
            this.buffer.slice(2, 4), //device_type
            this.buffer.slice(4, 5), //frame_cnt
            encryptedPayload.slice(-7, -4) //ext_cnt
        ]);

        const decipher = crypto.createDecipheriv(
            "aes-128-ccm",
            Buffer.from(this.bindKey, "hex"), //key
            nonce, //iv
            {authTagLength: 4}
        );

        const ciphertext = encryptedPayload.slice(0, -7);

        decipher.setAuthTag(encryptedPayload.slice(-4));
        decipher.setAAD(Buffer.from("11", "hex"), {
            plaintextLength: ciphertext.length
        });

        const receivedPlaintext = decipher.update(ciphertext);

        decipher.final();

        this.buffer = Buffer.concat([
            this.buffer.slice(0, this.eventOffset),
            receivedPlaintext
        ]);
    };

    parseEventData = () => {
        if (!this.frameControl.hasEvent) {
            return null;
        }
        switch (this.eventType) {
            case EventTypes.temperature: {
                return this.parseTemperatureEvent();
            }
            case EventTypes.humidity: {
                return this.parseHumidityEvent();
            }
            case EventTypes.battery: {
                return this.parseBatteryEvent();
            }
            case EventTypes.temperatureAndHumidity: {
                return this.parseTemperatureAndHumidityEvent();
            }
            case EventTypes.fertility: {
                return this.parseFertilityEvent();
            }
            case EventTypes.moisture: {
                return this.parseMoistureEvent();
            }
            case EventTypes.illuminance: {
                return this.parseIlluminanceEvent();
            }
            default: {
                throw new Error(
                    `Unknown event type: ${this.eventType}. ${this.toString()}`
                );
            }
        }
    };

    parseTemperatureEvent = () => ({temperature: this.buffer.readInt16LE(this.eventOffset + 3) / 10});

    parseHumidityEvent = () => ({humidity: this.buffer.readUInt16LE(this.eventOffset + 3) / 10});

    parseBatteryEvent = () => ({battery: this.buffer.readUInt8(this.eventOffset + 3)});

    parseTemperatureAndHumidityEvent = () => {
        const temperature = this.buffer.readInt16LE(this.eventOffset + 3) / 10;
        const humidity = this.buffer.readUInt16LE(this.eventOffset + 5) / 10;
        return {temperature, humidity};
    };

    parseIlluminanceEvent = () => ({illuminance: this.buffer.readUIntLE(this.eventOffset + 3, 3)});

    parseFertilityEvent = () => ({fertility: this.buffer.readInt16LE(this.eventOffset + 3)});

    parseMoistureEvent = () => ({moisture: this.buffer.readInt8(this.eventOffset + 3)});

    toString = () => this.buffer.toString();
}
