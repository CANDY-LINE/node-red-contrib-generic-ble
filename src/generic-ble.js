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

'use strict';

import 'source-map-support/register';
import noble from '@abandonware/noble';
import NodeCache from 'node-cache';

const TRACE = (process.env.GENERIC_BLE_TRACE === 'true');
const bleDevices = new NodeCache({
  stdTTL : 10 * 60 * 1000,
  checkperiod : 60 * 1000
});
const configBleDevices = {};
let onDiscover;

function onStateChange(state) {
  if (state === 'poweredOn') {
    noble.startScanning([], true);
  } else {
    noble.stopScanning();
  }
}

function getAddressOrUUID(peripheral) {
  if (!peripheral) {
    return null;
  }
  if (!peripheral.address || peripheral.address === 'unknown') {
    return peripheral.uuid;
  }
  return peripheral.address;
}

function deleteBleDevice(addressOrUUID, RED) {
  let value = bleDevices.del(addressOrUUID);
  if (value && TRACE) {
    RED.log.info(`[GenericBLE:TRACE] Delete => ${addressOrUUID}`);
  }
}

function valToBuffer(hexOrIntArray, len=1) {
  if (Buffer.isBuffer(hexOrIntArray)) {
    return hexOrIntArray;
  }
  if (typeof hexOrIntArray === 'number') {
    let rawHex = parseInt(hexOrIntArray).toString(16);
    if (rawHex.length < (len * 2)) {
      rawHex = Array((len * 2) - rawHex.length + 1).join('0') + rawHex;
    }
    if (rawHex.length % 2 === 1) {
      rawHex = '0' + rawHex;
    }
    return new Buffer(rawHex, 'hex');
  }
  if (typeof hexOrIntArray === 'string') {
    if (hexOrIntArray.length < (len * 2)) {
      hexOrIntArray = Array((len * 2) - hexOrIntArray.length + 1).join('0') + hexOrIntArray;
    }
    if (hexOrIntArray.length % 2 === 1) {
      hexOrIntArray = '0' + hexOrIntArray;
    }
    return new Buffer(hexOrIntArray, 'hex');
  }
  if (Array.isArray(hexOrIntArray)) {
    for (let i = 0; i < len - hexOrIntArray.length; i++) {
      hexOrIntArray.splice(0, 0, 0);
    }
    return new Buffer(hexOrIntArray);
  }
  return new Buffer(0);
}

function onDiscoverFunc(RED) {
  return (peripheral) => {
    let addressOrUUID = getAddressOrUUID(peripheral);
    if (!addressOrUUID) {
      return;
    } else if (peripheral.connectable) {
      bleDevices.set(addressOrUUID, peripheral.uuid);
      if (false && TRACE) {
        RED.log.info(`[GenericBLE:DISCOVER:TRACE] <${addressOrUUID}> ${peripheral.advertisement.localName}`);
      }
    } else {
      deleteBleDevice(addressOrUUID, RED);
    }
  };
}

function startBLEScanning(RED) {
  RED.log.info(`[GenericBLE] Start BLE scanning`);
  if (!onDiscover) {
    onDiscover = onDiscoverFunc(RED);
  }
  noble.removeListener('stateChange', onStateChange);
  noble.removeListener('discover', onDiscover);
  noble.addListener('stateChange', onStateChange);
  noble.addListener('discover', onDiscover);
  if (noble.state === 'poweredOn') {
    noble.startScanning([], true);
  }
}

function toApiObject(peripheral) {
  if (!peripheral) {
    return Promise.resolve(null);
  }
  return Promise.resolve({
    localName: peripheral.advertisement.localName,
    address: peripheral.address === 'unknown' ? '' : peripheral.address,
    uuid: peripheral.uuid,
    rssi: peripheral.rssi
  });
}

function toDetailedObject(peripheral, RED) {
  let p = Promise.resolve();
  return toApiObject(peripheral).then(obj => {
    switch (peripheral.state) {
      case 'disconnected': {
        p = new Promise((resolve, reject) => {
          peripheral.once('connect', () => {
            peripheral.discoverAllServicesAndCharacteristics(
            (err, services) => {
              if (err) {
                return reject(err);
              }
              let resolved = false;
              obj.characteristics = services.reduce((prev, curr) => {
                return prev.concat(curr.characteristics);
              }, []).map((c) => {
                let characteristic = {
                  uuid: c.uuid,
                  name: c.name || RED._('generic-ble.label.unnamedChr'),
                  type: c.type || RED._('generic-ble.label.customType'),
                  notifiable: c.properties.indexOf('notify') >= 0,
                  readable: c.properties.indexOf('read') >= 0,
                  writable: c.properties.indexOf('write') >= 0,
                  writeWithoutResponse: c.properties.indexOf('writeWithoutResponse') >= 0,
                };
                if (!peripheral.advertisement.localName &&
                    peripheral.state === 'connected' &&
                    c.type === 'org.bluetooth.characteristic.gap.device_name') {
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
        peripheral.services.map((s) => {
          obj.characteristics = obj.characteristics.concat((s.characteristics || []).map((c) => {
            let characteristic = {
              uuid: c.uuid,
              name: c.name || RED._('generic-ble.label.unnamedChr'),
              type: c.type || RED._('generic-ble.label.customType'),
              notifiable: c.properties.indexOf('notify') >= 0,
              readable: c.properties.indexOf('read') >= 0,
              writable: c.properties.indexOf('write') >= 0,
              writeWithoutResponse: c.properties.indexOf('writeWithoutResponse') >= 0,
            };
            if (!peripheral.advertisement.localName &&
                peripheral.state === 'connected' &&
                c.type === 'org.bluetooth.characteristic.gap.device_name') {
              p = new Promise((resolve) => {
                c.read((err, data) => {
                  if (err) {
                    return resolve();
                  }
                  obj.localName = data.toString();
                  peripheral.advertisement.localName = obj.localName;
                  return resolve();
                });
              });
            }
            return characteristic;
          }).filter(c => c));
        });
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
    return p.then(() => Promise.resolve(obj));
  });
}

export default function(RED) {

  function toCharacteristic(c) {
    let obj = {
      uuid: c.uuid,
      name: c.name || RED._('generic-ble.label.unnamedChr'),
      type: c.type || RED._('generic-ble.label.customType'),
      notifiable: c.properties.indexOf('notify') >= 0,
      readable: c.properties.indexOf('read') >= 0,
      writable: c.properties.indexOf('write') >= 0,
      writeWithoutResponse: c.properties.indexOf('writeWithoutResponse') >= 0,
      object: c,
      addDataListener: (func) => {
        if (obj.dataListener) {
          return false;
        }
        obj.dataListener = func;
        obj.object.removeAllListeners('data');
        obj.object.on('data', func);
        return true;
      },
      unsubscribe: () => {
        return new Promise((resolve) => {
          let peripheral = noble._peripherals[obj._peripheralId];
          if (obj.notifiable && peripheral && peripheral.state === 'connected') {
            delete obj.dataListener;
            obj.object.unsubscribe(resolve);
          } else {
            return resolve();
          }
        });
      },
    };
    return obj;
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
      let key = getAddressOrUUID(n);
      if (key) {
        configBleDevices[key] = this;
      }
      this.nodes = {};
      this.operations = {
        preparePeripheral: () => {
          let peripheral = noble._peripherals[this.uuid];
          if (!peripheral) {
            this.emit('disconnected');
            return Promise.resolve();
          }
          let connecting = (peripheral.state === 'connecting');
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
                peripheral.once('connect', () => {
                  peripheral._connectHandlerSet = false;
                  peripheral.discoverAllServicesAndCharacteristics(
                  (err, services) => {
                    if (err) {
                      this.log(`<discoverAllServicesAndCharacteristics> error:${err.message}`);
                      return;
                    }
                    this.emit('connected');
                    this.characteristics = services.reduce((prev, curr) => {
                      return prev.concat(curr.characteristics);
                    }, []).map((c) => toCharacteristic(c));
                  });
                });
                peripheral.connect(); // peripheral.state => connecting
              }
              connecting = true;
              break;
            }
            case 'connected': {
              if (peripheral.services) {
                this.characteristics = peripheral.services.reduce((prev, curr) => {
                  return prev.concat(curr.characteristics);
                }, []).map((c) => toCharacteristic(c));
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
              let connectedHandler = () => {
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
        },
        shutdown: () => {
          return Promise.all(this.characteristics.map((c) => c.unsubscribe()));
        },
        register: (node) => {
          this.nodes[node.id] = node;
        },
        remove: (node) => {
          delete this.nodes[node.id];
        },
        // dataObj = {
        //   'uuid-to-write-1': Buffer(),
        //   'uuid-to-write-2': Buffer(),
        //   :
        // }
        write: (dataObj) => {
          if (!dataObj) {
            return Promise.resolve();
          }
          return this.operations.preparePeripheral().then((state) => {
            if (state !== 'connected') {
              this.log(`[write] Peripheral:${this.uuid} is NOT ready. state=>${state}`);
              return Promise.resolve();
            }
            let writables = this.characteristics.filter(c => c.writable || c.writeWithoutResponse);
            if (TRACE) {
              this.log(`characteristics => ${JSON.stringify(this.characteristics.map((c) => {
                let obj = Object.assign({}, c);
                delete obj.obj;
                return obj;
              }))}`);
              this.log(`writables.length => ${writables.length}`);
            }
            if (writables.length === 0) {
              return Promise.resolve();
            }
            let uuidList = Object.keys(dataObj);
            writables = writables.filter(c => uuidList.indexOf(c.uuid) >= 0);
            if (TRACE) {
              this.log(`UUIDs to write => ${uuidList}`);
              this.log(`writables.length => ${writables.length}`);
            }
            if (writables.length === 0) {
              return Promise.resolve();
            }
            // perform write here right now
            return Promise.all(writables.map(w => {
              // {uuid:'characteristic-uuid-to-write', data:Buffer()}
              return new Promise((resolve, reject) => {
                let buf = valToBuffer(dataObj[w.uuid]);
                if (TRACE) {
                  this.log(`<Write> uuid => ${w.uuid}, data => ${buf}, writeWithoutResponse => ${w.writeWithoutResponse}`);
                }
                w.object.write(
                  buf,
                  w.writeWithoutResponse,
                  (err) => {
                    if (err) {
                      if (TRACE) {
                        this.log(`<Write> ${w.uuid} => FAIL`);
                      }
                      return reject(err);
                    }
                    if (TRACE) {
                      this.log(`<Write> ${w.uuid} => OK`);
                    }
                    resolve(true);
                  }
                );
              });
            }));
          });
        },
        read: (uuids='') => {
          return this.operations.preparePeripheral().then((state) => {
            if (state !== 'connected') {
              this.log(`[read] Peripheral:${this.uuid} is NOT ready. state=>${state}`);
              return Promise.resolve();
            }
            uuids = uuids.split(',').map((uuid) => uuid.trim()).filter((uuid) => uuid);
            let readables = this.characteristics.filter(c => {
              if (c.readable) {
                if (uuids.length === 0) {
                  return true;
                }
                return uuids.indexOf(c.uuid) >= 0;
              }
            });
            if (TRACE) {
              this.log(`characteristics => ${JSON.stringify(this.characteristics.map((c) => {
                let obj = Object.assign({}, c);
                delete obj.obj;
                return obj;
              }))}`);
              this.log(`readables.length => ${readables.length}`);
            }
            if (readables.length === 0) {
              return Promise.resolve();
            }
            let notifiables = this.characteristics.filter(c => {
              if (c.notifiable) {
                if (uuids.length === 0) {
                  return true;
                }
                return uuids.indexOf(c.uuid) >= 0;
              }
            });
            // perform read here right now
            let readObj = {};
            return Promise.all(notifiables.map((n) => n.unsubscribe())).then(() => {
              return Promise.all(readables.map((r) => {
                // {uuid:'characteristic-uuid-to-read'}
                return new Promise((resolve, reject) => {
                  r.object.read(
                    (err, data) => {
                      if (err) {
                        if (TRACE) {
                          this.log(`<Read> ${r.uuid} => FAIL`);
                        }
                        return reject(err);
                      }
                      if (TRACE) {
                        this.log(`<Read> ${r.uuid} => ${JSON.stringify(data)}`);
                      }
                      readObj[r.uuid] = data;
                      resolve();
                    }
                  );
                });
              }));
            }).then(() => {
              return readObj;
            });
          });
        },
        subscribe: (uuids='', period=0) => {
          return this.operations.preparePeripheral().then((state) => {
            if (state !== 'connected') {
              this.log(`[subscribe] Peripheral:${this.uuid} is NOT ready. state=>${state}`);
              return Promise.resolve();
            }
            uuids = uuids.split(',').map((uuid) => uuid.trim()).filter((uuid) => uuid);
            let notifiables = this.characteristics.filter(c => {
              if (c.notifiable) {
                if (uuids.length === 0) {
                  return true;
                }
                return uuids.indexOf(c.uuid) >= 0;
              }
            });
            if (TRACE) {
              this.log(`characteristics => ${JSON.stringify(this.characteristics.map((c) => {
                let obj = Object.assign({}, c);
                delete obj.obj;
                return obj;
              }))}`);
              this.log(`notifiables.length => ${notifiables.length}`);
            }
            if (notifiables.length === 0) {
              return false;
            }
            return Promise.all(notifiables.map((r) => {
              r.addDataListener((data, isNotification) => {
                if (isNotification) {
                  let readObj = {
                    notification: true
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
            }));
          });
        }
      };
      ['connected', 'disconnected', 'error', 'timeout'].forEach(ev => {
        this.on(ev, () => {
          try {
            Object.keys(this.nodes).forEach(id => {
              this.nodes[id].emit(ev);
            });
          } catch (e) {
            this.error(e);
          }
        });
      });
      this.emit('disconnected');
      this.on('close', (done) => {
        Object.keys(configBleDevices).forEach(k => delete configBleDevices[k]);
        this.operations.shutdown().then(done).catch(done);
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
              this.error(`<${uuid}> notify: (err:${err})`);
              return;
            }
            let payload = {
              uuid: uuid,
              characteristics: readObj
            };
            if (this.useString) {
              try {
                payload = JSON.stringify(payload);
              } catch(err) {
                this.warn(`<${uuid}> notify: (err:${err})`);
                return;
              }
            }
            this.send({
              payload: payload
            });
          });
        }
        this.on('connected', () => {
          this.status({fill:'green',shape:'dot',text:`generic-ble.status.connected`});
        });
        ['disconnected', 'error', 'timeout'].forEach(ev => {
          this.on(ev, () => {
            this.status({fill:'red',shape:'ring',text:`generic-ble.status.${ev}`});
          });
        });
        this.genericBleNode.operations.register(this);

        this.on('input', (msg) => {
          if (TRACE) {
            this.log(`input arrived!`);
          }
          let obj = msg.payload || {};
          try {
            if (typeof(obj) === 'string') {
              obj = JSON.parse(msg.payload);
            }
          } catch (_) {
          }
          let p;
          if (obj.notify) {
            p = this.genericBleNode.operations.subscribe(msg.topic, obj.period);
          } else {
            p = this.genericBleNode.operations.read(msg.topic).then((readObj) => {
              if (!readObj) {
                this.warn(`<${this.genericBleNode.uuid}> Nothing to read`);
                return;
              }
              let payload = {
                uuid: this.genericBleNode.uuid,
                characteristics: readObj
              };
              if (this.useString) {
                payload = JSON.stringify(payload);
              }
              this.send({
                payload: payload
              });
            });
          }
          p.catch((err) => {
            this.error(`<${this.uuid}> read: (err:${err})`);
          });
        });
        this.on('close', () => {
          if (this.genericBleNode) {
            this.genericBleNode.operations.remove(this);
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
          this.status({fill:'green',shape:'dot',text:`generic-ble.status.connected`});
        });
        ['disconnected', 'error', 'timeout'].forEach(ev => {
          this.on(ev, () => {
            this.status({fill:'red',shape:'ring',text:`generic-ble.status.${ev}`});
          });
        });
        this.genericBleNode.operations.register(this);
        this.on('input', (msg) => {
          this.genericBleNode.operations.write(msg.payload).then(() => {
            if (TRACE) {
              this.log(`<${this.genericBleNode.uuid}> write: OK`);
            }
          }).catch((err) => {
            this.error(`<${this.genericBleNode.uuid}> write: (err:${err})`);
          });
        });
        this.on('close', () => {
          if (this.genericBleNode) {
            this.genericBleNode.operations.remove(this);
          }
        });
      }
      this.name = n.name;
    }
  }
  RED.nodes.registerType('Generic BLE out', GenericBLEOutNode);

  RED.events.on('runtime-event', (ev) => {
    if (TRACE) {
      RED.log.info(`[GenericBLE] <runtime-event> ${JSON.stringify(ev)}`);
    }
    if (ev.id === 'runtime-state') {
      noble.stopScanning();
      bleDevices.flushAll();
      startBLEScanning(RED);
    }
  });

  // __bledevlist endpoint
  RED.httpAdmin.get(
      '/__bledevlist',
      RED.auth.needsPermission('generic-ble.read'), (req, res) => {
    let promises = [];
    try {
      promises = bleDevices.keys().map(k => {
        // load the live object for invoking functions
        // as cached object is disconnected from noble context
        let uuid = bleDevices.get(k);
        return toApiObject(noble._peripherals[uuid]);
      });
    } catch (_) {}
    Promise.all(promises).then(body => {
      if (TRACE) {
        RED.log.info('/__bledevlist', JSON.stringify(body, null, 2));
      }
      res.json(body);
    });
  });
  // __bledev endpoint
  RED.httpAdmin.get(
      '/__bledev/:address',
      RED.auth.needsPermission('generic-ble.read'), (req, res) => {
    let address = req.params.address;
    if (!address) {
      return res.status(404).send({status:404, message:'missing peripheral'}).end();
    }
    let uuid = bleDevices.get(address);
    if (!uuid) {
      return res.status(404).send({status:404, message:'missing peripheral'}).end();
    }
    // load the live object for invoking functions
    // as cached object is disconnected from noble context
    let peripheral = noble._peripherals[uuid];
    if (!peripheral) {
      return res.status(404).send({status:404, message:'missing peripheral'}).end();
    }

    return toDetailedObject(peripheral, RED).then(bleDevice => {
      if (TRACE) {
        RED.log.info(`/__bledev/${address} OUTPUT`, JSON.stringify(bleDevice, null, 2));
      }
      res.json(bleDevice);
    }).catch((err) => {
      RED.log.error(`/__bledev/${address} err:${err}\n=>${err.stack || err.message}`);
      if (!res._headerSent) {
        return res.status(500).send({ status: 500, message: (err.message || err) }).end();
      }
    });
  });
}
