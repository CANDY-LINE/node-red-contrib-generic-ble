/**
 * @license
 * Copyright (c) 2017 CANDY LINE INC.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import noble from './noble';
import debugLogger from 'debug';

const debug = debugLogger('node-red-contrib-generic-ble:index');
const debugIn = debugLogger(
  'node-red-contrib-generic-ble:index:generic-ble-in'
);
const debugOut = debugLogger(
  'node-red-contrib-generic-ble:index:generic-ble-out'
);
const debugCfg = debugLogger('node-red-contrib-generic-ble:index:generic-ble');
const debugApi = debugLogger('node-red-contrib-generic-ble:index:api');

// Workaround for a Jest Issue
// https://github.com/kulshekhar/ts-jest/issues/727#issuecomment-422747294
if (process.env.NODE_ENV !== 'test') {
  debug('Requiring "source-map-support/register"...');
  require('source-map-support/register');
}
const configBleDevices = {};
const genericBleState = {
  scanning: false,
};
const handlers = {
  // global event handlers
};

function getAddressOrUUID(peripheral) {
  if (!peripheral) {
    return null;
  }
  if (!peripheral.address || peripheral.address === 'unknown') {
    return peripheral.uuid;
  }
  return peripheral.address;
}

function valToBuffer(hexOrIntArray, len = 1) {
  if (Buffer.isBuffer(hexOrIntArray)) {
    return hexOrIntArray;
  }
  if (typeof hexOrIntArray === 'number') {
    let rawHex = parseInt(hexOrIntArray).toString(16);
    if (rawHex.length < len * 2) {
      rawHex = Array(len * 2 - rawHex.length + 1).join('0') + rawHex;
    }
    if (rawHex.length % 2 === 1) {
      rawHex = '0' + rawHex;
    }
    return Buffer.from(rawHex, 'hex');
  }
  if (typeof hexOrIntArray === 'string') {
    if (hexOrIntArray.length < len * 2) {
      hexOrIntArray =
        Array(len * 2 - hexOrIntArray.length + 1).join('0') + hexOrIntArray;
    }
    if (hexOrIntArray.length % 2 === 1) {
      hexOrIntArray = '0' + hexOrIntArray;
    }
    return Buffer.from(hexOrIntArray, 'hex');
  }
  if (Array.isArray(hexOrIntArray)) {
    for (let i = 0; i < len - hexOrIntArray.length; i++) {
      hexOrIntArray.splice(0, 0, 0);
    }
    return Buffer.from(hexOrIntArray);
  }
  return Buffer.alloc(0);
}

function onDiscoverFunc(RED) {
  return (peripheral) => {
    const addressOrUUID = getAddressOrUUID(peripheral);
    if (!addressOrUUID) {
      return;
    } else if (peripheral.connectable) {
      debug(
        `[GenericBLE:DISCOVER] <${addressOrUUID}> ${peripheral.advertisement.localName}`
      );
      RED.nodes.eachNode((node) => {
        if (node.type === 'Generic BLE' && peripheral.uuid === node.uuid) {
          RED.nodes.getNode(node.id).discovered();
        }
      });
    }
  };
}

function onMissFunc(RED) {
  return (peripheral) => {
    const addressOrUUID = getAddressOrUUID(peripheral);
    debug(
      `[GenericBLE:MISS] <${addressOrUUID}> ${peripheral.advertisement.localName}`
    );
    RED.nodes.eachNode((node) => {
      if (node.type === 'Generic BLE' && node.uuid === peripheral.uuid) {
        RED.nodes.getNode(node.id).missed();
      }
    });
  };
}

function onStateChangeFunc(RED) {
  return (state) => {
    if (state === 'poweredOn') {
      if (!genericBleState.scanning) {
        RED.log.info(`[GenericBLE] Start BLE scanning`);
        noble.startScanning([], true);
        genericBleState.scanning = true;
      }
    } else if (genericBleState.scanning) {
      RED.log.info(`[GenericBLE] Stop BLE scanning`);
      noble.stopScanning();
      genericBleState.scanning = false;
    }
  };
}

function onErrorFunc(RED) {
  return (err) => {
    const message = `[GenericBLE:ERROR] ${err.message}, ${err.stack}`;
    debug(message);
    RED.log.error(message);
    if (!noble.initialized) {
      RED.log.error(
        `The error seems to be a BlueZ Permission Error. See 'Installation Note' in README at https://flows.nodered.org/node/node-red-contrib-generic-ble for addressing the issue.`
      );
    }
    Object.values(configBleDevices).forEach((node) => node.emit('error'));
  };
}

function stopBLEScanning(RED) {
  if (!genericBleState.scanning) {
    return;
  }
  RED.log.info(`[GenericBLE] Stop BLE scanning`);
  noble.stopScanning();
  genericBleState.scanning = false;
}

function startBLEScanning(RED) {
  if (genericBleState.scanning) {
    return;
  }
  if (!handlers.onDiscover) {
    handlers.onDiscover = onDiscoverFunc(RED);
  }
  if (!handlers.onMiss) {
    handlers.onMiss = onMissFunc(RED);
  }
  if (!handlers.onStateChange) {
    handlers.onStateChange = onStateChangeFunc(RED);
  }
  if (!handlers.onError) {
    handlers.onError = onErrorFunc(RED);
  }

  noble.removeListener('discover', handlers.onDiscover);
  noble.removeListener('miss', handlers.onMiss);
  noble.removeListener('stateChange', handlers.onStateChange);
  noble.removeListener('error', handlers.onError);

  noble.addListener('discover', handlers.onDiscover);
  noble.addListener('miss', handlers.onMiss);
  noble.addListener('stateChange', handlers.onStateChange);
  noble.addListener('error', handlers.onError);

  if (noble.state === 'poweredOn') {
    RED.log.info(`[GenericBLE] Start BLE scanning`);
    noble.startScanning([], true);
    genericBleState.scanning = true;
  } else {
    debug(`noble.state=>${noble.state}`);
  }
}

async function toApiObject(peripheral) {
  if (!peripheral) {
    return null;
  }
  return {
    localName: peripheral.advertisement.localName,
    address: peripheral.address === 'unknown' ? '' : peripheral.address,
    uuid: peripheral.uuid,
    rssi: peripheral.rssi,
  };
}

async function toDetailedObject(peripheral, RED) {
  const obj = await toApiObject(peripheral);
  switch (peripheral.state) {
    case 'disconnected': {
      await new Promise((resolve, reject) => {
        peripheral.once('connect', (err) => {
          if (err) {
            return reject(err);
          }
          const discoveryInterrupted = () => {
            return reject(new Error(`Missing Peripheral Device`));
          };
          peripheral.once('disconnect', discoveryInterrupted);
          peripheral.discoverAllServicesAndCharacteristics((err, services) => {
            debug(
              `<toDetailedObject${peripheral.uuid}:discoverAllServicesAndCharacteristics> Callback OK!`
            );
            peripheral.removeListener('disconnect', discoveryInterrupted);
            if (err) {
              return reject(err);
            }
            let resolved = false;
            obj.characteristics = services
              .reduce((prev, curr) => {
                return prev.concat(curr.characteristics);
              }, [])
              .map((c) => {
                const characteristic = {
                  uuid: c.uuid,
                  name: c.name || RED._('generic-ble.label.unnamedChr'),
                  type: c.type || RED._('generic-ble.label.customType'),
                  notifiable: c.properties.indexOf('notify') >= 0,
                  readable: c.properties.indexOf('read') >= 0,
                  writable: c.properties.indexOf('write') >= 0,
                  writeWithoutResponse:
                    c.properties.indexOf('writeWithoutResponse') >= 0,
                };
                if (
                  peripheral.state === 'connected' &&
                  c.type === 'org.bluetooth.characteristic.gap.device_name'
                ) {
                  resolved = true;
                  c.read((err, data) => {
                    if (err) {
                      return resolve();
                    }
                    obj.localName = data.toString();
                    peripheral.advertisement.localName = obj.localName;
                    return resolve();
                  });
                }
                return characteristic;
              });
            if (!resolved) {
              return resolve();
            }
          });
        });
        peripheral.connect(); // peripheral.state => connecting
      });
      break;
    }
    case 'connected': {
      obj.characteristics = [];
      let deviceNameCharacteristic;
      peripheral.services.map((s) => {
        obj.characteristics = obj.characteristics.concat(
          (s.characteristics || []).map((c) => {
            if (c.type === 'org.bluetooth.characteristic.gap.device_name') {
              deviceNameCharacteristic = c;
            }
            return {
              uuid: c.uuid,
              name: c.name || RED._('generic-ble.label.unnamedChr'),
              type: c.type || RED._('generic-ble.label.customType'),
              notifiable: c.properties.indexOf('notify') >= 0,
              readable: c.properties.indexOf('read') >= 0,
              writable: c.properties.indexOf('write') >= 0,
              writeWithoutResponse:
                c.properties.indexOf('writeWithoutResponse') >= 0,
            };
          })
        );
      });
      if (
        deviceNameCharacteristic &&
        !peripheral.advertisement.localName &&
        peripheral.state === 'connected'
      ) {
        await new Promise((resolve) => {
          deviceNameCharacteristic.read((err, data) => {
            if (err) {
              return resolve();
            }
            obj.localName = data.toString();
            peripheral.advertisement.localName = obj.localName;
            return resolve();
          });
        });
      }
      break;
    }
    case 'disconnecting':
    case 'connecting': {
      return;
    }
    default: {
      return;
    }
  }
  return obj;
}

module.exports = function (RED) {
  function toCharacteristic(c) {
    const self = {
      uuid: c.uuid,
      name: c.name || RED._('generic-ble.label.unnamedChr'),
      type: c.type || RED._('generic-ble.label.customType'),
      notifiable: c.properties.indexOf('notify') >= 0,
      readable: c.properties.indexOf('read') >= 0,
      writable: c.properties.indexOf('write') >= 0,
      writeWithoutResponse: c.properties.indexOf('writeWithoutResponse') >= 0,
      object: c,
      addDataListener: (func) => {
        if (self.dataListener) {
          return false;
        }
        self.dataListener = func;
        self.object.removeAllListeners('data');
        self.object.on('data', func);
        return true;
      },
      unsubscribe: () => {
        return new Promise((resolve) => {
          const peripheral = noble._peripherals[self._peripheralId];
          if (
            self.notifiable &&
            peripheral &&
            peripheral.state === 'connected'
          ) {
            delete self.dataListener;
            self.object.unsubscribe(resolve);
          } else {
            return resolve();
          }
        });
      },
    };
    return self;
  }

  class GenericBLENode {
    constructor(n) {
      RED.nodes.createNode(this, n);
      this.localName = n.localName;
      this.address = n.address;
      this.uuid = n.uuid;
      this.characteristics = [];
      const key = getAddressOrUUID(n);
      if (key) {
        configBleDevices[key] = this;
      }
      this.nodes = {};
      [
        'connected',
        'disconnected',
        'error',
        'connecting',
        'disconnecting',
        'missing',
      ].forEach((ev) => {
        this.on(ev, () => {
          try {
            Object.keys(this.nodes).forEach((id) => {
              this.nodes[id].emit(ev);
            });
          } catch (e) {
            this.error(e);
          }
        });
      });
      this.on('close', (done) => {
        if (genericBleState.scanning) {
          stopBLEScanning();
        }
        Object.keys(configBleDevices).forEach(
          (k) => delete configBleDevices[k]
        );
        this.removeAllListeners('ble-notify');
        this.shutdown().then(done).catch(done);
      });
      process.nextTick(() => {
        if (noble.initialized) {
          this.emit('missing');
        }
      });
    }
    async discovered() {
      debugCfg(
        `<discovered:${this.uuid}> noble._peripherals=>${Object.keys(
          noble._peripherals
        )}`
      );
      const peripheral = noble._peripherals[this.uuid];
      if (peripheral) {
        this.emit(peripheral.state || 'disconnected');
      }
    }
    async missed() {
      debugCfg(`<missed:${this.uuid}>`);
      this.emit('missing');
    }
    async connectPeripheral() {
      debugCfg(
        `<connectPeripheral:${this.uuid}> noble._peripherals=>${Object.keys(
          noble._peripherals
        )}`
      );
      const peripheral = noble._peripherals[this.uuid];
      if (!peripheral) {
        this.emit('missing');
        return;
      }
      debug(
        `<connectPeripheral${this.uuid}> peripheral.state=>${peripheral.state}`
      );
      switch (peripheral.state) {
        case 'disconnected': {
          this.emit('disconnected');
          if (!peripheral._disconnectedHandlerSet) {
            peripheral._disconnectedHandlerSet = true;
            peripheral.once('disconnect', () => {
              this.emit('disconnected');
              peripheral._disconnectedHandlerSet = false;
            });
          }
          if (!peripheral._connectHandlerSet) {
            peripheral._connectHandlerSet = true;
            peripheral.once('connect', (err) => {
              if (err) {
                this.log(`<connectPeripheral:connect> error:${err.message}`);
                this.emit('disconnected');
                return;
              }
              this.emit('connected');
              peripheral._connectHandlerSet = false;
              peripheral.discoverAllServicesAndCharacteristics(
                (err, services) => {
                  debug(
                    `<connectPeripheral${this.uuid}:discoverAllServicesAndCharacteristics> Callback OK!`
                  );
                  if (err) {
                    this.log(
                      `<connectPeripheral${this.uuid}:discoverAllServicesAndCharacteristics> error:${err.message}`
                    );
                    return;
                  }
                  this.characteristics = services
                    .reduce((prev, curr) => {
                      return prev.concat(curr.characteristics);
                    }, [])
                    .map((c) => toCharacteristic(c));
                }
              );
            });
            peripheral.connect(); // peripheral.state => connecting
            this.emit('connecting');
          }
          break;
        }
        case 'connected': {
          if (peripheral.services) {
            this.characteristics = peripheral.services
              .reduce((prev, curr) => {
                return prev.concat(curr.characteristics);
              }, [])
              .map((c) => toCharacteristic(c));
          }
          if (!peripheral._disconnectedHandlerSet) {
            peripheral._disconnectedHandlerSet = true;
            peripheral.once('disconnect', () => {
              this.emit('disconnected');
              peripheral._disconnectedHandlerSet = false;
            });
          }
          this.emit('connected');
          break;
        }
        case 'disconnecting':
        case 'connecting': {
          this.emit(peripheral.state);
          break;
        }
        default: {
          break;
        }
      }
      return peripheral.state;
    }
    async disconnectPeripheral() {
      debugCfg(
        `<disconnectPeripheral:${this.uuid}> noble._peripherals=>${Object.keys(
          noble._peripherals
        )}`
      );
      const peripheral = noble._peripherals[this.uuid];
      if (!peripheral) {
        debugCfg(
          `<disconnectPeripheral:${this.uuid}> peripheral is already gone.`
        );
        this.emit('missing');
        return;
      }
      if (peripheral.state === 'disconnected') {
        debugCfg(
          `<disconnectPeripheral:${this.uuid}> peripheral is already disconnected.`
        );
        this.emit('disconnected');
        return;
      }
      if (!peripheral._disconnectedHandlerSet) {
        peripheral._disconnectedHandlerSet = true;
        peripheral.once('disconnect', () => {
          this.emit('disconnected');
          peripheral._disconnectedHandlerSet = false;
        });
      }
      peripheral.disconnect();
      this.emit('disconnecting');
    }
    async shutdown() {
      await Promise.all(this.characteristics.map((c) => c.unsubscribe()));
    }
    register(node) {
      this.nodes[node.id] = node;
    }
    remove(node) {
      delete this.nodes[node.id];
    }
    // dataObj = {
    //   'uuid-to-write-1': Buffer(),
    //   'uuid-to-write-2': Buffer(),
    //   :
    // }
    async write(dataObj) {
      if (!dataObj) {
        throw new Error(`Nothing to write`);
      }
      const state = await this.connectPeripheral();
      if (state !== 'connected') {
        debugCfg(
          `[write] Peripheral:${this.uuid} is NOT ready. state=>${state}`
        );
        throw new Error(`Not yet connected.`);
      }
      let writables = this.characteristics.filter(
        (c) => c.writable || c.writeWithoutResponse
      );
      debugCfg(
        `characteristics => ${JSON.stringify(
          this.characteristics.map((c) => {
            return {
              uuid: c.uuid,
              notifiable: c.notifiable,
              readable: c.readable,
              writable: c.writable,
              writeWithoutResponse: c.writeWithoutResponse,
            };
          })
        )}`
      );
      debugCfg(`writables.length => ${writables.length}`);
      if (writables.length === 0) {
        return;
      }
      const uuidList = Object.keys(dataObj);
      writables = writables.filter((c) => uuidList.indexOf(c.uuid) >= 0);
      debugCfg(`UUIDs to write => ${uuidList}`);
      debugCfg(`writables.length => ${writables.length}`);
      if (writables.length === 0) {
        return;
      }
      // perform write here right now
      await Promise.all(
        writables.map((w) => {
          // {uuid:'characteristic-uuid-to-write', data:Buffer()}
          return new Promise((resolve, reject) => {
            const buf = valToBuffer(dataObj[w.uuid]);
            debugCfg(
              `<Write> uuid => ${w.uuid}, data => ${buf.toString(
                'hex'
              )}, writeWithoutResponse => ${w.writeWithoutResponse}`
            );
            w.object.write(buf, w.writeWithoutResponse, (err) => {
              if (err) {
                debugCfg(`<Write> ${w.uuid} => FAIL`);
                return reject(err);
              }
              debugCfg(`<Write> ${w.uuid} => OK`);
              resolve(true);
            });
          });
        })
      );
    }
    async read(uuids = '') {
      const state = await this.connectPeripheral();
      if (state !== 'connected') {
        debugCfg(
          `[read] Peripheral:${this.uuid} is NOT ready. state=>${state}`
        );
        throw new Error(`Not yet connected.`);
      }
      uuids = uuids
        .split(',')
        .map((uuid) => uuid.trim())
        .filter((uuid) => uuid);
      const readables = this.characteristics.filter((c) => {
        if (c.readable) {
          if (uuids.length === 0) {
            return true;
          }
          return uuids.indexOf(c.uuid) >= 0;
        }
      });
      debugCfg(
        `characteristics => ${JSON.stringify(
          this.characteristics.map((c) => {
            return {
              uuid: c.uuid,
              notifiable: c.notifiable,
              readable: c.readable,
              writable: c.writable,
              writeWithoutResponse: c.writeWithoutResponse,
            };
          })
        )}`
      );
      debugCfg(`readables.length => ${readables.length}`);
      if (readables.length === 0) {
        return null;
      }
      const notifiables = this.characteristics.filter((c) => {
        if (c.notifiable) {
          if (uuids.length === 0) {
            return true;
          }
          return uuids.indexOf(c.uuid) >= 0;
        }
      });
      // perform read here right now
      const readObj = {};
      // unsubscribe all notifiable characteristics
      await Promise.all(notifiables.map((n) => n.unsubscribe()));
      // read all readable characteristics
      await Promise.all(
        readables.map((r) => {
          // {uuid:'characteristic-uuid-to-read'}
          return new Promise((resolve, reject) => {
            r.object.read((err, data) => {
              if (err) {
                debug(`<Read> ${r.uuid} => FAIL`);
                return reject(err);
              }
              debugCfg(`<Read> ${r.uuid} => ${JSON.stringify(data)}`);
              readObj[r.uuid] = data;
              resolve();
            });
          });
        })
      );
      return Object.keys(readObj).length > 0 ? readObj : null;
    }
    async subscribe(uuids = '', period = 0) {
      const state = await this.connectPeripheral();
      if (state !== 'connected') {
        this.log(
          `[subscribe] Peripheral:${this.uuid} is NOT ready. state=>${state}`
        );
        throw new Error(`Not yet connected.`);
      }
      uuids = uuids
        .split(',')
        .map((uuid) => uuid.trim())
        .filter((uuid) => uuid);
      const notifiables = this.characteristics.filter((c) => {
        if (c.notifiable) {
          if (uuids.length === 0) {
            return true;
          }
          return uuids.indexOf(c.uuid) >= 0;
        }
      });
      debugCfg(
        `characteristics => ${JSON.stringify(
          this.characteristics.map((c) => {
            return {
              uuid: c.uuid,
              notifiable: c.notifiable,
              readable: c.readable,
              writable: c.writable,
              writeWithoutResponse: c.writeWithoutResponse,
            };
          })
        )}`
      );
      debugCfg(`notifiables.length => ${notifiables.length}`);
      if (notifiables.length === 0) {
        return;
      }
      await Promise.all(
        notifiables.map(async (r) => {
          r.addDataListener((data, isNotification) => {
            if (isNotification) {
              let readObj = {
                notification: true,
              };
              readObj[r.uuid] = data;
              this.emit('ble-notify', this.uuid, readObj);
            }
          });
          r.object.subscribe((err) => {
            if (err) {
              this.emit('error', err);
              this.log(`subscription error: ${err.message}`);
            }
          });
          if (period > 0) {
            setTimeout(() => {
              r.object.unsubscribe((err) => {
                if (err) {
                  this.emit('error', err);
                  this.log(`unsubscription error: ${err.message}`);
                } else {
                  const peripheral = noble._peripherals[this.uuid];
                  if (peripheral) {
                    this.emit(peripheral.state);
                  } else {
                    this.emit('missing');
                  }
                }
              });
            }, 5000);
          }
        })
      );
    }
  }
  RED.nodes.registerType('Generic BLE', GenericBLENode);

  class GenericBLEInNode {
    constructor(n) {
      RED.nodes.createNode(this, n);
      this.useString = n.useString;
      this.notification = n.notification;
      this.genericBleNodeId = n.genericBle;
      this.genericBleNode = RED.nodes.getNode(this.genericBleNodeId);
      if (this.genericBleNode) {
        if (this.notification) {
          this.genericBleNode.on('ble-notify', this.onBleNotify.bind(this));
        }
        this.on('connected', () => {
          this.status({
            fill: 'green',
            shape: 'dot',
            text: `generic-ble.status.connected`,
          });
        });
        ['disconnected', 'error', 'missing'].forEach((ev) => {
          this.on(ev, () => {
            this.status({
              fill: 'red',
              shape: 'ring',
              text: `generic-ble.status.${ev}`,
            });
          });
        });
        ['connecting', 'disconnecting'].forEach((ev) => {
          this.on(ev, () => {
            this.status({
              fill: 'grey',
              shape: 'ring',
              text: `generic-ble.status.${ev}`,
            });
          });
        });
        this.genericBleNode.register(this);

        this.on('input', async (msg, send) => {
          debugIn(`input arrived! msg=>${JSON.stringify(msg)}`);
          let obj = msg.payload || {};
          try {
            if (typeof obj === 'string') {
              obj = JSON.parse(msg.payload);
            }
          } catch (_) {
            // ignore
          }
          try {
            if (msg.topic === 'scanStart') {
              startBLEScanning(RED);
              return;
            } else if (msg.topic === 'scanStop') {
              stopBLEScanning(RED);
              return;
            } else if (msg.topic === 'scanRestart') {
              stopBLEScanning(RED);
              setTimeout(() => {
                startBLEScanning(RED);
              }, 1000);
              return;
            } else if (msg.topic === 'connect') {
              await this.genericBleNode.connectPeripheral();
            } else if (msg.topic === 'disconnect') {
              await this.genericBleNode.disconnectPeripheral();
            } else if (obj.notify) {
              await this.genericBleNode.subscribe(msg.topic, obj.period);
              debugIn(`<${this.genericBleNode.uuid}> subscribe: OK`);
            } else {
              const readObj = await this.genericBleNode.read(msg.topic);
              debugIn(`<${this.genericBleNode.uuid}> read: OK`);
              if (!readObj) {
                this.warn(
                  `<${this.genericBleNode.uuid}> tpoic[${msg.topic}]: (no data)`
                );
                return;
              }
              let payload = {
                uuid: this.genericBleNode.uuid,
                characteristics: readObj,
              };
              if (this.useString) {
                payload = JSON.stringify(payload);
              }
              const node = this;
              send =
                send ||
                function () {
                  node.send.apply(node, arguments);
                };
              send({
                payload,
              });
            }
          } catch (err) {
            debugIn(
              `<${this.genericBleNode.uuid}> tpoic[${msg.topic}]: (err:${err}, stack:${err.stack})`
            );
            this.error(
              `<${this.genericBleNode.uuid}> tpoic[${msg.topic}]: (err:${err}, stack:${err.stack})`
            );
          }
        });
        this.on('close', () => {
          if (this.genericBleNode) {
            this.genericBleNode.remove(this);
          }
        });
      }
      this.name = n.name;
    }
    onBleNotify(uuid, readObj, err) {
      if (err) {
        this.error(`<${uuid}> notify: (err:${err}, stack:${err.stack})`);
        return;
      }
      let payload = {
        uuid: uuid,
        characteristics: readObj,
      };
      if (this.useString) {
        try {
          payload = JSON.stringify(payload);
        } catch (err) {
          this.warn(`<${uuid}> notify: (err:${err}, stack:${err.stack})`);
          return;
        }
      }
      this.send({
        payload,
      });
    }
  }
  RED.nodes.registerType('Generic BLE in', GenericBLEInNode);

  class GenericBLEOutNode {
    constructor(n) {
      RED.nodes.createNode(this, n);
      this.genericBleNodeId = n.genericBle;
      this.genericBleNode = RED.nodes.getNode(this.genericBleNodeId);
      if (this.genericBleNode) {
        this.on('connected', () => {
          this.status({
            fill: 'green',
            shape: 'dot',
            text: `generic-ble.status.connected`,
          });
        });
        ['disconnected', 'error', 'missing'].forEach((ev) => {
          this.on(ev, () => {
            this.status({
              fill: 'red',
              shape: 'ring',
              text: `generic-ble.status.${ev}`,
            });
          });
        });
        ['connecting', 'disconnecting'].forEach((ev) => {
          this.on(ev, () => {
            this.status({
              fill: 'grey',
              shape: 'ring',
              text: `generic-ble.status.${ev}`,
            });
          });
        });
        this.genericBleNode.register(this);
        this.on('input', async (msg) => {
          debugOut(`input arrived! msg=>${JSON.stringify(msg)}`);
          try {
            if (msg.topic === 'connect') {
              await this.genericBleNode.connectPeripheral();
            } else if (msg.topic === 'disconnect') {
              await this.genericBleNode.disconnectPeripheral();
            } else {
              await this.genericBleNode.write(msg.payload);
              debugOut(`<${this.genericBleNode.uuid}> write: OK`);
            }
          } catch (err) {
            debugOut(`<${this.genericBleNode.uuid}> write: (err:${err})`);
            this.error(err);
          }
        });
        this.on('close', () => {
          if (this.genericBleNode) {
            this.genericBleNode.remove(this);
          }
        });
      }
      this.name = n.name;
    }
  }
  RED.nodes.registerType('Generic BLE out', GenericBLEOutNode);

  RED.events.on('runtime-event', (ev) => {
    debugApi(`[GenericBLE] <runtime-event> ${JSON.stringify(ev)}`);
    if (ev.id === 'runtime-state' && Object.keys(configBleDevices).length > 0) {
      stopBLEScanning(RED);
      startBLEScanning(RED);
    }
  });

  // __blestate endpoint
  RED.httpAdmin.get(
    '/__blestate',
    RED.auth.needsPermission('generic-ble.read'),
    async (req, res) => {
      debugApi(`${req.method}:${req.originalUrl}`);
      return res.status(200).send(genericBleState).end();
    }
  );

  // __blescan/:sw endpoint
  RED.httpAdmin.post(
    '/__blescan/:sw',
    RED.auth.needsPermission('generic-ble.write'),
    async (req, res) => {
      debugApi(
        `${req.method}:${req.originalUrl}, genericBleState.scanning:${genericBleState.scanning}`
      );
      const { sw } = req.params;
      if (sw === 'start') {
        startBLEScanning(RED);
        return res
          .status(200)
          .send({ status: 200, message: 'startScanning' })
          .end();
      } else {
        stopBLEScanning(RED);
        return res
          .status(200)
          .send({ status: 200, message: 'stopScanning' })
          .end();
      }
    }
  );

  // __bledevlist endpoint
  RED.httpAdmin.get(
    '/__bledevlist',
    RED.auth.needsPermission('generic-ble.read'),
    async (req, res) => {
      debugApi(`${req.method}:${req.originalUrl}`);
      try {
        const body = (
          await Promise.all(
            Object.keys(noble._peripherals).map((uuid) => {
              // load the live object for invoking functions
              // as cached object is disconnected from noble context
              const apiObject = toApiObject(noble._peripherals[uuid]);
              if (apiObject) {
                return apiObject;
              }
            })
          )
        ).filter((obj) => obj);
        debugApi('/__bledevlist', JSON.stringify(body, null, 2));
        res.json(body);
      } catch (err) {
        RED.log.error(
          `/__bledevlist err:${err}\n=>${err.stack || err.message}`
        );
        if (!res._headerSent) {
          return res
            .status(500)
            .send({ status: 500, message: err.message || err })
            .end();
        }
      }
    }
  );
  // __bledev endpoint
  RED.httpAdmin.get(
    '/__bledev/:uuid',
    RED.auth.needsPermission('generic-ble.read'),
    async (req, res) => {
      debugApi(`${req.method}:${req.originalUrl}`);
      const { uuid } = req.params;
      if (!uuid) {
        return res
          .status(404)
          .send({ status: 404, message: 'missing peripheral' })
          .end();
      }
      // load the live object for invoking functions
      // as cached object is disconnected from noble context
      const peripheral = noble._peripherals[uuid];
      if (!peripheral) {
        return res
          .status(404)
          .send({ status: 404, message: 'missing peripheral' })
          .end();
      }

      try {
        const bleDevice = await toDetailedObject(peripheral, RED);
        debugApi(
          `/__bledev/${uuid} OUTPUT`,
          JSON.stringify(bleDevice, null, 2)
        );
        return res.json(bleDevice);
      } catch (err) {
        RED.log.error(
          `/__bledev/${uuid} err:${err}\n=>${err.stack || err.message}`
        );
        if (!res._headerSent) {
          return res
            .status(500)
            .send({ status: 500, message: err.message || err })
            .end();
        }
      }
    }
  );
};
