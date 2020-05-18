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
import NodeCache from 'node-cache';
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
const bleDevices = new NodeCache({
  stdTTL: 10 * 60 * 1000,
  checkperiod: 60 * 1000,
});
const configBleDevices = {};
const genericBleState = {
  scanning: false,
};
let onDiscover;
let onStateChange;

function getAddressOrUUID(peripheral) {
  if (!peripheral) {
    return null;
  }
  if (!peripheral.address || peripheral.address === 'unknown') {
    return peripheral.uuid;
  }
  return peripheral.address;
}

function deleteBleDevice(addressOrUUID) {
  const value = bleDevices.del(addressOrUUID);
  if (value) {
    debug(`[GenericBLE] Delete => ${addressOrUUID}`);
  }
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

function onDiscoverFunc() {
  return (peripheral) => {
    const addressOrUUID = getAddressOrUUID(peripheral);
    if (!addressOrUUID) {
      return;
    } else if (peripheral.connectable) {
      bleDevices.set(addressOrUUID, peripheral.uuid);
      debug(
        `[GenericBLE:DISCOVER] <${addressOrUUID}> ${peripheral.advertisement.localName}`
      );
    } else {
      deleteBleDevice(addressOrUUID);
    }
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
  if (!onDiscover) {
    onDiscover = onDiscoverFunc();
  }
  if (!onStateChange) {
    onStateChange = onStateChangeFunc(RED);
  }
  noble.removeListener('stateChange', onStateChange);
  noble.removeListener('discover', onDiscover);
  noble.addListener('stateChange', onStateChange);
  noble.addListener('discover', onDiscover);
  if (noble.state === 'poweredOn') {
    noble.startScanning([], true);
    genericBleState.scanning = true;
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
          peripheral.discoverAllServicesAndCharacteristics((err, services) => {
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
                  !peripheral.advertisement.localName &&
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
  // Start Noble Initialization
  RED.log.debug(`noble.state=>${noble.state}`);
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
      this.muteNotifyEvents = n.muteNotifyEvents;
      this.operationTimeout = n.operationTimeout;
      this.characteristics = [];
      const key = getAddressOrUUID(n);
      if (key) {
        configBleDevices[key] = this;
      }
      this.nodes = {};
      ['connected', 'disconnected', 'error', 'timeout'].forEach((ev) => {
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
      this.emit('disconnected');
      this.on('close', (done) => {
        if (genericBleState.scanning) {
          stopBLEScanning();
        }
        Object.keys(configBleDevices).forEach(
          (k) => delete configBleDevices[k]
        );
        this.shutdown().then(done).catch(done);
      });
    }

    preparePeripheral() {
      debugCfg(
        `<preparePeripheral> this.uuid:${
          this.uuid
        }, noble._peripherals=>${Object.keys(noble._peripherals)}`
      );
      const peripheral = noble._peripherals[this.uuid];
      if (!peripheral) {
        this.emit('disconnected');
        return Promise.resolve();
      }
      let connecting = peripheral.state === 'connecting';
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
                this.log(`<preparePeripheral:connect> error:${err.message}`);
                return;
              }
              peripheral._connectHandlerSet = false;
              peripheral.discoverAllServicesAndCharacteristics(
                (err, services) => {
                  if (err) {
                    this.log(
                      `<preparePeripheral:discoverAllServicesAndCharacteristics> error:${err.message}`
                    );
                    return;
                  }
                  this.emit('connected');
                  this.characteristics = services
                    .reduce((prev, curr) => {
                      return prev.concat(curr.characteristics);
                    }, [])
                    .map((c) => toCharacteristic(c));
                }
              );
            });
            peripheral.connect(); // peripheral.state => connecting
          }
          connecting = true;
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
        default: {
          break;
        }
      }
      if (connecting) {
        return new Promise((resolve) => {
          let retry = 0;
          const connectedHandler = () => {
            ++retry;
            if (peripheral.state === 'connected') {
              return resolve(peripheral.state);
            } else if (retry < 10) {
              setTimeout(connectedHandler, 500);
            } else {
              this.emit('timeout');
              return resolve(peripheral.state);
            }
          };
          setTimeout(connectedHandler, 500);
        });
      } else {
        return Promise.resolve(peripheral.state);
      }
    }
    shutdown() {
      return Promise.all(this.characteristics.map((c) => c.unsubscribe()));
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
        return;
      }
      const state = await this.preparePeripheral();
      if (state !== 'connected') {
        debugCfg(
          `[write] Peripheral:${this.uuid} is NOT ready. state=>${state}`
        );
        return;
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
      return await Promise.all(
        writables.map((w) => {
          // {uuid:'characteristic-uuid-to-write', data:Buffer()}
          return new Promise((resolve, reject) => {
            const buf = valToBuffer(dataObj[w.uuid]);
            debugCfg(
              `<Write> uuid => ${w.uuid}, data => ${buf}, writeWithoutResponse => ${w.writeWithoutResponse}`
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
      const state = await this.preparePeripheral();
      if (state !== 'connected') {
        debugCfg(
          `[read] Peripheral:${this.uuid} is NOT ready. state=>${state}`
        );
        return null;
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
    subscribe(uuids = '', period = 0) {
      return this.preparePeripheral().then((state) => {
        if (state !== 'connected') {
          this.log(
            `[subscribe] Peripheral:${this.uuid} is NOT ready. state=>${state}`
          );
          return Promise.resolve();
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
          return false;
        }
        return Promise.all(
          notifiables.map((r) => {
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
                    this.emit('connected');
                  }
                });
              }, 5000);
            }
          })
        );
      });
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
          this.genericBleNode.on('ble-notify', (uuid, readObj, err) => {
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
              payload: payload,
            });
          });
        }
        this.on('connected', () => {
          this.status({
            fill: 'green',
            shape: 'dot',
            text: `generic-ble.status.connected`,
          });
        });
        ['disconnected', 'error', 'timeout'].forEach((ev) => {
          this.on(ev, () => {
            this.status({
              fill: 'red',
              shape: 'ring',
              text: `generic-ble.status.${ev}`,
            });
          });
        });
        this.genericBleNode.register(this);

        this.on('input', async (msg) => {
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
            if (obj.notify) {
              await this.genericBleNode.subscribe(msg.topic, obj.period);
              debugOut(`<${this.genericBleNode.uuid}> subscribe: OK`);
            } else {
              const readObj = await this.genericBleNode.read(msg.topic);
              debugOut(`<${this.genericBleNode.uuid}> read: OK`);
              if (!readObj) {
                this.warn(
                  `<${this.genericBleNode.uuid}> read[${msg.topic}]: (no data)`
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
              this.send({
                payload,
              });
            }
          } catch (err) {
            this.error(
              `<${this.genericBleNode.uuid}> read[${msg.topic}]: (err:${err}, stack:${err.stack})`
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
        ['disconnected', 'error', 'timeout'].forEach((ev) => {
          this.on(ev, () => {
            this.status({
              fill: 'red',
              shape: 'ring',
              text: `generic-ble.status.${ev}`,
            });
          });
        });
        this.genericBleNode.register(this);
        this.on('input', async (msg) => {
          debugOut(`input arrived! msg=>${JSON.stringify(msg)}`);
          try {
            await this.genericBleNode.write(msg.payload);
            debugOut(`<${this.genericBleNode.uuid}> write: OK`);
          } catch (err) {
            this.error(`<${this.genericBleNode.uuid}> write: (err:${err})`);
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
      bleDevices.flushAll();
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
            bleDevices.keys().map((k) => {
              // load the live object for invoking functions
              // as cached object is disconnected from noble context
              const uuid = bleDevices.get(k);
              const apiObject = toApiObject(noble._peripherals[uuid]);
              if (apiObject) {
                return apiObject;
              } else {
                deleteBleDevice(uuid, RED);
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
    '/__bledev/:address',
    RED.auth.needsPermission('generic-ble.read'),
    async (req, res) => {
      debugApi(`${req.method}:${req.originalUrl}`);
      const address = req.params.address;
      if (!address) {
        return res
          .status(404)
          .send({ status: 404, message: 'missing peripheral' })
          .end();
      }
      const uuid = bleDevices.get(address);
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
          `/__bledev/${address} OUTPUT`,
          JSON.stringify(bleDevice, null, 2)
        );
        return res.json(bleDevice);
      } catch (err) {
        RED.log.error(
          `/__bledev/${address} err:${err}\n=>${err.stack || err.message}`
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
