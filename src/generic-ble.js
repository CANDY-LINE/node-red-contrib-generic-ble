'use strict';

import 'source-map-support/register';
import noble from 'noble';
import NodeCache from 'node-cache';
import queue from 'queue';

const TRACE = (process.env.GENERIC_BLE_TRACE === 'true');
const BLE_CONNECTION_TIMEOUT_MS = parseInt(process.env.BLE_CONNECTION_TIMEOUT_MS || 5000);
const BLE_CONCURRENT_CONNECTIONS = parseInt(process.env.BLE_CONCURRENT_CONNECTIONS || 1);
const BLE_READ_WRITE_INTERVAL_MS = parseInt(process.env.BLE_READ_WRITE_INTERVAL_MS || 50);
const BLE_NOTIFY_WAIT_MS = parseInt(process.env.BLE_NOTIFY_WAIT_MS || 300);
const MAX_REQUESTS = parseInt(process.env.MAX_REQUESTS || 10);
const bleDevices = new NodeCache({
  stdTTL : 10 * 60 * 1000,
  checkperiod : 60 * 1000
});
const configBleDevices = {};
const q = queue({
  concurrency: BLE_CONCURRENT_CONNECTIONS,
  autostart: true
});
let onDiscover;
let timeouts = [];

function addTimeout(fn, ms) {
  let timeout = setTimeout(fn, ms);
  timeouts.push(timeout);
  return timeout;
}

function deleteTimeout(t) {
  clearTimeout(t);
  let i = timeouts.indexOf(t);
  if (i < 0) {
    return t;
  }
  timeouts.splice(i, 1);
}

function deleteAllTimeouts() {
  timeouts.forEach((t) => {
    clearTimeout(t);
  });
  timeouts = [];
}

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

function deleteBleDevice(addressOrUUID) {
  let value = bleDevices.del(addressOrUUID);
  if (value && TRACE) {
    console.log(`[GenericBLE:TRACE] Delete => ${addressOrUUID}`);
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

function characteristicsTask(services, bleDevice, RED) {
  let characteristics = services.reduce((prev, curr) => {
    return prev.concat(curr.characteristics);
  }, []);
  return new Promise((resolve, reject) => {
    let loop = () => {
      let writeRequest = bleDevice._writeRequests.shift() || [];
      let writeUuidList = writeRequest.map(c => c.uuid);
      let writeChars = writeRequest.length > 0 ?
        characteristics.filter(c => writeUuidList.indexOf(c.uuid) >= 0) : [];
      let writePromises = writeChars.map((c) => {
        if (!writeRequest.data) {
          return null;
        }
        return new Promise((resolve, reject) => {
          c.write(
            valToBuffer(writeRequest.data),
            writeRequest.writeWithoutResponse,
            (err) => {
              if (err) {
                return reject(err);
              }
              resolve();
            }
          );
        });
      }).filter(p => p);

      let readObj = {};
      let readRequest = bleDevice._readRequests.shift() || [];
      let readUuidList = readRequest.map(c => c.uuid);
      let readChars = readUuidList.length > 0 ?
        characteristics.filter(c => readUuidList.indexOf(c.uuid) >= 0) : [];
      let readPromises = readChars.map((c) => {
        return new Promise((resolve, reject) => {
          c.read(
            (err, data) => {
              if (err) {
                return reject(err);
              }
              readObj[c.uuid] = data;
              resolve();
            }
          );
        });
      });

      let promise = Promise.resolve();
      if (writePromises.length > 0) {
        promise = new Promise((resolve) => {
          if (writePromises.length === 0) {
            return resolve();
          }
          Promise.all(writePromises).then(() => {
            bleDevice.emit('ble-write', bleDevice.uuid);
            resolve();
          }).catch((err) => {
            bleDevice.emit('ble-write', bleDevice.uuid, err);
            resolve();
          });
        });
      }
      promise.then(() => {
        if (readPromises.length === 0) {
          return Promise.resolve();
        }
        return new Promise((resolve) => {
          Promise.all(readPromises).then(() => {
            bleDevice.emit('ble-read', bleDevice.uuid, readObj);
            resolve();
          }).catch((err) => {
            bleDevice.emit('ble-read', bleDevice.uuid, readObj, err);
            resolve();
          });
        });
      }).then(() => {
        if (loop) {
          setTimeout(loop, BLE_READ_WRITE_INTERVAL_MS);
        }
      }).catch(() => {
        if (loop) {
          setTimeout(loop, BLE_READ_WRITE_INTERVAL_MS);
        }
      });
    };

    let timeout = addTimeout(() => {
      if (TRACE) {
        RED.log.info(`<characteristicsTask> <${bleDevice.uuid}> SUBSCRIPTION TIMEOUT`);
      }
      deleteTimeout(timeout);
      loop = null;
      timeout = null;
      bleDevice.emit('timeout');
      Promise.all(bleDevice.characteristics.filter(c => c.notifiable).map((c) => {
        return new Promise((resolve) => {
          let characteristic = characteristics.filter(chr => chr.uuid === c.uuid)[0];
          if (!characteristic) {
            RED.log.warn(`[GenericBLE] <${bleDevice.uuid}> Characteristic(${c.uuid}) is missing`);
            return resolve();
          }
          characteristic.removeAllListeners('data');
          if (characteristic._subscribed) {
            delete characteristic._subscribed;
            characteristic.unsubscribe(() => {
              bleDevice.emit('unsubscribed');
              if (TRACE) {
                RED.log.info(`<characteristicsTask> <${bleDevice.uuid}> UNSUBSCRIBED`);
              }
              return resolve();
            });
          } else {
            return resolve();
          }
        });
      })).then(() => {
        if (TRACE) {
          RED.log.info(`<characteristicsTask> <${bleDevice.uuid}> END`);
        }
        resolve();
      }).catch((err) => {
        if (TRACE) {
          RED.log.info(`<characteristicsTask> <${bleDevice.uuid}> END`);
        }
        reject(err);
      });
    }, bleDevice.listeningPeriod || BLE_NOTIFY_WAIT_MS);

    if (TRACE) {
      RED.log.info(`<characteristicsTask> <${bleDevice.uuid}> START`);
    }
    process.nextTick(loop);

    bleDevice.characteristics.filter(c => c.notifiable).forEach(c => {
      let characteristic = characteristics.filter(chr => chr.uuid === c.uuid)[0];
      if (!characteristic) {
        RED.log.warn(`[GenericBLE] <${bleDevice.uuid}> Characteristic(${c.uuid}) is missing`);
        return;
      }
      characteristic.removeAllListeners('data');
      characteristic.on('data', (data, isNotification) => {
        if (isNotification) {
          let readObj = {
            notification: true
          };
          readObj[c.uuid] = data;
          bleDevice.emit('ble-notify', bleDevice.uuid, readObj);
        }
      });
      if (TRACE) {
        RED.log.info(`<characteristicsTask> <${bleDevice.uuid}> START SUBSCRIBING`);
      }
      characteristic.subscribe((err) => {
        if (err) {
          if (timeout) {
            deleteTimeout(timeout);
            bleDevice.emit('error');
          }
          loop = null;
          timeout = null;
          characteristics.forEach(c => c.removeAllListeners('data'));
          return reject(err);
        } else if (TRACE) {
          RED.log.info(`<characteristicsTask> <${bleDevice.uuid}> SUBSCRIBED`);
        }
        bleDevice.emit('subscribed');
        characteristic._subscribed = true;
      });
    });
  });
}

function disconnectPeripheral(peripheral, done) {
  if (peripheral.state === 'disconnected' || peripheral.state === 'disconnecting') {
    delete peripheral._lock;
    if (TRACE) {
      console.log(`<disconnectPeripheral> <${peripheral.uuid}> Skipped to disconnect`);
    }
    if (done) {
      return done();
    }
    return;
  }
  if (peripheral._skipDisconnect) {
    delete peripheral._skipDisconnect;
    if (TRACE) {
      console.log(`<disconnectPeripheral> <${peripheral.uuid}> Skipped to disconnect <LOCKED>`);
    }
    if (done) {
      return done();
    }
    return;
  }
  let bleDevice = configBleDevices[getAddressOrUUID(peripheral)];
  let timeout;
  let onDisconnected = () => {
    if (TRACE) {
      console.log(`<disconnectPeripheral> <${peripheral.uuid}> DISCONNECTED`);
    }
    if (timeout) {
      deleteTimeout(timeout);
      if (bleDevice) {
        bleDevice.emit('disconnected');
      }
    }
    timeout = null;
    if (done) {
      done();
    }
  };
  timeout = addTimeout(() => {
    if (TRACE) {
      console.log(`<disconnectPeripheral> <${peripheral.uuid}> DISCONNECT TIMEOUT`);
    }
    deleteTimeout(timeout);
    timeout = null;
    if (bleDevice) {
      bleDevice.emit('timeout');
    }
    if (done) {
      done();
    }
  }, BLE_CONNECTION_TIMEOUT_MS);
  peripheral.once('disconnect', onDisconnected);
  peripheral.disconnect();
  delete peripheral.services;
  delete peripheral._lock;
}

function connectToPeripheral(peripheral) {
  if (peripheral._lock) {
    if (TRACE) {
      console.log(`<connectToPeripheral> <${peripheral.uuid}> Gave up to connect`);
    }
    peripheral._skipDisconnect = true;
    return Promise.reject(`<${peripheral.uuid}> Try again`);
  }
  let bleDevice = configBleDevices[getAddressOrUUID(peripheral)];
  return new Promise((resolve, reject) => {
    let timeout;
    let onConnected = (err) => {
      if (bleDevice) {
        bleDevice.emit('connected');
      }
      peripheral._lock = true;
      if (err) {
        return reject(`${err}\n${err.stack}`);
      }
      if (!timeout) {
        // timeout is already performed
        return reject(`Already Timed Out`);
      }
      deleteTimeout(timeout);
      timeout = null;
      if (TRACE) {
        console.log(`<connectToPeripheral> <${peripheral.uuid}> discovering all services and characteristics...`);
      }
      if (peripheral.services) {
        if (TRACE) {
          console.log(`<connectToPeripheral> <${peripheral.uuid}> discovered 00`);
        }
        return resolve([peripheral.services, bleDevice]);
      }
      if (peripheral._discovering) {
        let discoveryTimeout = addTimeout(() => {
          deleteTimeout(discoveryTimeout);
          if (peripheral.services) {
            if (TRACE) {
              console.log(`<connectToPeripheral> <${peripheral.uuid}> discovered 00`);
            }
            return resolve([peripheral.services, bleDevice]);
          }
          return reject(`<${peripheral.uuid}> Cannot discover`);
        }, 1000);
        return;
      }
      if (TRACE) {
        console.log(`<connectToPeripheral> <${peripheral.uuid}> Setting up discoveryTimeout`);
      }
      let discoveryTimeout = addTimeout(() => {
        if (TRACE) {
          console.log(`<connectToPeripheral> <${peripheral.uuid}> discoveryTimeout fired`);
        }
        if (bleDevice) {
          bleDevice.emit('timeout');
        }
        peripheral._discovering = false;
        peripheral.removeListener('connect', onConnected);
        deleteTimeout(discoveryTimeout);
        discoveryTimeout = null;
        onConnected = null;
        reject(`<${peripheral.uuid}> Discovery Timeout`);
      }, BLE_CONNECTION_TIMEOUT_MS);
      peripheral._discovering = true;
      peripheral.discoverAllServicesAndCharacteristics(
          (err, services) => {
        peripheral._discovering = false;
        if (TRACE) {
          console.log(`<connectToPeripheral> <${peripheral.uuid}> discoverAllServicesAndCharacteristics OK`);
        }
        deleteTimeout(discoveryTimeout);
        discoveryTimeout = null;
        if (err) {
          if (TRACE) {
            console.log(`<connectToPeripheral> <${peripheral.uuid}> err`, err);
          }
          return reject(`<${peripheral.uuid}> ${err}\n=>${err.stack}`);
        }
        if (TRACE) {
          console.log(`<connectToPeripheral> <${peripheral.uuid}> discovered 01`);
        }
        return resolve([services, bleDevice]);
      });
    };
    timeout = addTimeout(() => {
      if (bleDevice) {
        bleDevice.emit('timeout');
      }
      peripheral.removeListener('connect', onConnected);
      deleteTimeout(timeout);
      timeout = null;
      onConnected = null;
      reject(`<${peripheral.uuid}> Connection Timeout`);
      if (TRACE) {
        console.log(`<connectToPeripheral> <${peripheral.uuid}> Connection Timeout`);
      }
    }, BLE_CONNECTION_TIMEOUT_MS);
    if (TRACE) {
      console.log(`<connectToPeripheral> <${peripheral.uuid}> peripheral.state=>${peripheral.state}`);
    }
    if (peripheral.state === 'connected') {
      return onConnected();
    }
    peripheral.removeAllListeners('disconnect');
    peripheral.once('connect', onConnected);
    peripheral.connect();
  });
}

function peripheralTask(uuid, task, done, RED) {
  return (next) => {
    if (TRACE) {
      RED.log.info(`<peripheralTask> <${uuid}> START`);
    }
    let peripheral = noble._peripherals[uuid];
    if (!peripheral) {
      if (TRACE) {
        RED.log.info(`<peripheralTask> <${uuid}> Missing peripheral END`);
      }
      if (done) {
        done(`<${uuid}> Missing peripheral`);
      }
      return next(`<${uuid}> Missing peripheral`);
    }

    function tearDown(err) {
      if (TRACE) {
        RED.log.info(`<peripheralTask> <${uuid}> Trying to disconnect,${err}`);
      }
      disconnectPeripheral(peripheral, () => {
        if (TRACE) {
          RED.log.info(`<peripheralTask> <${uuid}> END`);
        }
        if (done) {
          done(err);
        }
        next(err);
      });
    }

    connectToPeripheral(peripheral).then((result) => {
      return task(/* services */result[0], /* bleDevice */ result[1], RED);
    }).then(() => {
      tearDown();
    }).catch((err) => {
      tearDown(err);
    });
  };
}

function schedulePeripheralTask(uuid, task, done, RED) {
  if (!task) {
    return;
  }
  q.push(peripheralTask(uuid, task, done, RED));
}

function addErrorListenerToQueue(RED) {
  q.removeAllListeners('error');
  q.on('error', (err) => {
    if (TRACE) {
      RED.log.error(`[GenericBLE] ${err}`);
    }
  });
}

function addDoneListenerToQueue(RED) {
  q.removeAllListeners('end');
  q.on('end', () => {
    process.nextTick(() => {
      Object.keys(configBleDevices).forEach((k) => {
        let bleDevice = configBleDevices[k];
        if (TRACE) {
          RED.log.info(`[GenericBLE] k=>${k}, bleDevice.uuid=>${bleDevice.uuid}`);
        }
        if (noble._peripherals[bleDevice.uuid]) {
          schedulePeripheralTask(bleDevice.uuid, characteristicsTask, null, RED);
        }
      });
    });
  });
}

function onDiscoverFunc(RED) {
  return (peripheral) => {
    let addressOrUUID = getAddressOrUUID(peripheral);
    if (!addressOrUUID) {
      return;
    } else if (peripheral.connectable) {
      bleDevices.set(addressOrUUID, peripheral);
      if (false && TRACE) {
        RED.log.info(`[GenericBLE:DISCOVER:TRACE] <${addressOrUUID}> ${peripheral.advertisement.localName}`);
      }
      if (configBleDevices[addressOrUUID]) {
        schedulePeripheralTask(peripheral.uuid, characteristicsTask, null, RED);
      }
    } else {
      deleteBleDevice(addressOrUUID);
    }
  };
}

function startScanning(RED) {
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

function setupQueue(RED) {
  q.end();
  addDoneListenerToQueue(RED);
  addErrorListenerToQueue(RED);
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

function toDetailedObject(peripheral) {
  let p = Promise.resolve();
  return toApiObject(peripheral).then(obj => {
    if (peripheral.services) {
      obj.characteristics = [];
      peripheral.services.map((s) => {
        obj.characteristics = obj.characteristics.concat((s.characteristics || []).map((c) => {
          if (!c.type) {
            return null;
          }
          let characteristic = {
            uuid: c.uuid,
            name: c.name,
            type: c.type,
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
    }
    return p.then(() => Promise.resolve(obj));
  });
}

export default function(RED) {

  class GenericBLENode {
    constructor(n) {
      RED.nodes.createNode(this, n);
      this.localName = n.localName;
      this.address = n.address;
      this.uuid = n.uuid;
      this.listeningPeriod = n.listeningPeriod;
      this.characteristics = n.characteristics || [];
      let key = getAddressOrUUID(n);
      if (key) {
        configBleDevices[key] = this;
      }
      this.nodes = {};
      this._writeRequests = []; // {uuid:'characteristic-uuid-to-write', data:Buffer()}
      this._readRequests = []; // {uuid:'characteristic-uuid-to-read'}
      this.operations = {
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
            return false;
          }
          let writables = this.characteristics.filter(c => c.writable || c.writeWithoutResponse);
          if (TRACE) {
            RED.log.info(`[GenericBLE] characteristics => ${JSON.stringify(this.characteristics)}`);
            RED.log.info(`[GenericBLE] writables.length => ${writables.length}`);
          }
          if (writables.length === 0) {
            return false;
          }
          let uuidList = Object.keys(dataObj);
          writables = writables.filter(c => uuidList.indexOf(c.uuid) >= 0);
          if (TRACE) {
            RED.log.info(`[GenericBLE] UUIDs to write => ${uuidList}`);
            RED.log.info(`[GenericBLE] writables.length => ${writables.length}`);
          }
          if (writables.length === 0) {
            return false;
          }
          if (this._writeRequests.length >= MAX_REQUESTS) {
            return false;
          }
          this._writeRequests.push(writables.map(w => {
            return {
              uuid: w.uuid,
              data: dataObj[w.uuid],
              writeWithoutResponse: w.writeWithoutResponse
            };
          }));
          return true;
        },
        read: () => {
          let readables = this.characteristics.filter(c => c.readable);
          if (TRACE) {
            RED.log.info(`[GenericBLE] characteristics => ${JSON.stringify(this.characteristics)}`);
            RED.log.info(`[GenericBLE] readables.length => ${readables.length}`);
          }
          if (readables.length === 0) {
            return false;
          }
          if (this._readRequests.length >= MAX_REQUESTS) {
            return false;
          }
          this._readRequests.push(readables.map((r) => {
            return { uuid: r.uuid };
          }));
          return true;
        }
      };
      ['connected', 'disconnected', 'subscribed', 'unsubscribed', 'error', 'timeout'].forEach(ev => {
        this.on(ev, () => {
          try {
            Object.keys(this.nodes).forEach(id => {
              this.nodes[id].emit(ev);
            });
          } catch (e) {
            RED.log.error(e);
          }
        });
      });
      this.on('close', () => {
        Object.keys(configBleDevices).forEach(k => delete configBleDevices[k]);
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
        this.genericBleNode.on('ble-read', (uuid, readObj, err) => {
          if (err) {
            RED.log.error(`[GenericBLE] <${uuid}> read: ${err}`);
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
              RED.log.warn(`[GenericBLE] <${uuid}> read: ${err}`);
              return;
            }
          }
          this.send({
            payload: payload
          });
        });
        if (this.notification) {
          this.genericBleNode.on('ble-notify', (uuid, readObj, err) => {
            if (err) {
              RED.log.error(`[GenericBLE] <${uuid}> notify: ${err}`);
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
                RED.log.warn(`[GenericBLE] <${uuid}> read: ${err}`);
                return;
              }
            }
            this.send({
              payload: payload
            });
          });
          this.on('subscribed', () => {
            this.status({fill:'green',shape:'dot',text:`generic-ble.status.connected`});
          });
          this.on('unsubscribed', () => {
            this.status({fill:'red',shape:'ring',text:`generic-ble.status.unsubscribed`});
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

        this.on('input', () => {
          if (TRACE) {
            RED.log.info(`[GenericBLEIn] input arrived!`);
          }
          this.genericBleNode.operations.read();
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
        this.genericBleNode.on('ble-write', (uuid, err) => {
          if (err) {
            RED.log.error(`[GenericBLE] <${uuid}> write: ${err}`);
            return;
          }
          if (TRACE) {
            RED.log.debug(`[GenericBLE] <${uuid}> write: OK`);
          }
        });
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
          this.genericBleNode.operations.write(msg.payload);
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
      if (TRACE) {
        RED.log.info(`[GenericBLE] Queue started`);
      }
      if (noble._peripherals) {
        Object.keys(noble._peripherals).forEach((k) => {
          delete noble._peripherals[k]._lock;
          delete noble._peripherals[k]._skipDisconnect;
        });
      }
      noble.stopScanning();
      deleteAllTimeouts();
      bleDevices.flushAll();
      startScanning(RED);
      setupQueue(RED);
      q.start();
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
        let peripheral = bleDevices.get(k);
        return toApiObject(noble._peripherals[peripheral.uuid]);
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
    let peripheral = bleDevices.get(address);
    if (!peripheral) {
      return res.status(404).send({status:404, message:'missing peripheral'}).end();
    }
    // load the live object for invoking functions
    // as cached object is disconnected from noble context
    peripheral = noble._peripherals[peripheral.uuid];
    if (!peripheral) {
      return res.status(404).send({status:404, message:'missing peripheral'}).end();
    }

    let task = () => {
      return toDetailedObject(peripheral).then(bleDevice => {
        if (TRACE) {
          RED.log.info(`/__bledev/${address} OUTPUT`, JSON.stringify(bleDevice, null, 2));
        }
        res.json(bleDevice);
        return Promise.resolve();
      });
    };
    schedulePeripheralTask(peripheral.uuid, task, (err) => {
      if (TRACE) {
        RED.log.info(`/__bledev/${address} END err:${err}`);
      }
      if (err) {
        RED.log.error(`/__bledev/${address} ${err}\n=>${err.stack || err.message}`);
        if (!res._headerSent) {
          return res.status(500).send({ status: 500, message: (err.message || err) }).end();
        }
      }
    }, RED);
  });
}
