'use strict';

import 'source-map-support/register';
import noble from 'noble';
import NodeCache from 'node-cache';
import queue from 'queue';

const TRACE = false;
const BLE_CONNECTION_TIMEOUT_MS = parseInt(process.env.BLE_CONNECTION_TIMEOUT_MS || 5000);
const BLE_CONCURRENT_CONNECTIONS = parseInt(process.env.BLE_CONCURRENT_CONNECTIONS || 1);
const BLE_READ_WRITE_INTERVAL_MS = parseInt(process.env.BLE_READ_WRITE_INTERVAL_MS || 50);
const BLE_NOTIFY_WAIT_MS = parseInt(process.env.BLE_NOTIFY_WAIT_MS || 5000);
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
        return new Promise((resolve, reject) => {
          let write = writeRequest[c.uuid];
          c.write(
            valToBuffer(write.data),
            write.writeWithoutResponse,
            (err) => {
              if (err) {
                return reject(err);
              }
              resolve();
            }
          );
        });
      });

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

    let timeout = setTimeout(() => {
      loop = null;
      timeout = null;
      Promise.all(bleDevice.characteristics.filter(c => c.notifiable).map((c) => {
        return new Promise((resolve) => {
          let characteristic = characteristics.filter(chr => chr.uuid === c.uuid)[0];
          if (!characteristic) {
            RED.log.warn(`[GenericBLE] Characteristic(${c.uuid}) is missing`);
            return resolve();
          }
          characteristic.removeAllListeners('data');
          characteristic.unsubscribe(() => {
            if (TRACE) {
              RED.log.info(`<characteristicsTask> UNSUBSCRIBED`);
            }
            return resolve();
          });
        });
      })).then(() => {
        if (TRACE) {
          RED.log.info(`<characteristicsTask> END`);
        }
        resolve();
      }).catch((err) => {
        if (TRACE) {
          RED.log.info(`<characteristicsTask> END`);
        }
        reject(err);
      });
    }, bleDevice.listeningPeriod || BLE_NOTIFY_WAIT_MS);

    if (TRACE) {
      RED.log.info(`<characteristicsTask> START`);
    }
    process.nextTick(loop);

    bleDevice.characteristics.filter(c => c.notifiable).forEach(c => {
      let characteristic = characteristics.filter(chr => chr.uuid === c.uuid)[0];
      if (!characteristic) {
        RED.log.warn(`[GenericBLE] Characteristic(${c.uuid}) is missing`);
        return;
      }
      characteristic.removeAllListeners('data');
      characteristic.on('data', (data, isNotification) => {
        if (isNotification) {
          let readObj = {
            uuid: bleDevice.uuid,
            notification: true
          };
          readObj[c.uuid] = data;
          bleDevice.emit('ble-notify', bleDevice.uuid, readObj);
        }
      });
      characteristic.subscribe((err) => {
        if (err && timeout) {
          clearTimeout(timeout);
          loop = null;
          timeout = null;
          characteristics.forEach(c => c.removeAllListeners('data'));
          return reject(err);
        } else if (TRACE) {
          RED.log.info(`<characteristicsTask> SUBSCRIBED`);
        }
      });
    });
  });
}

function connectToPeripheral(peripheral) {
  return new Promise((resolve, reject) => {
    let timeout;
    let onConnected = (err) => {
      if (err) {
        return reject(`${err}\n${err.stack}`);
      }
      if (!timeout) {
        // timeout is already performed
        return reject(`Already Timed Out`);
      }
      clearTimeout(timeout);
      timeout = null;
      let bleDevice = configBleDevices[getAddressOrUUID(peripheral)];
      if (TRACE) {
        console.log(`<connectToPeripheral> discovering all services and characteristics...`);
      }
      if (peripheral.services) {
        if (TRACE) {
          console.log(`<connectToPeripheral> discovered`);
        }
        return resolve([peripheral.services, bleDevice]);
      }
      let discoveryTimeout = setTimeout(() => {
        peripheral.disconnect();
        delete peripheral.services;
        discoveryTimeout = null;
        onConnected = null;
        reject('Discovery Timeout');
      }, BLE_CONNECTION_TIMEOUT_MS);
      peripheral.discoverAllServicesAndCharacteristics(
          (err, services) => {
        clearTimeout(discoveryTimeout);
        discoveryTimeout = null;
        if (err) {
          if (TRACE) {
            console.log(`<connectToPeripheral> err`, err);
          }
          return reject(`${err}\n${err.stack}`);
        }
        if (TRACE) {
          console.log(`<connectToPeripheral> discovered`);
        }
        return resolve([services, bleDevice]);
      });
    };
    timeout = setTimeout(() => {
      peripheral.removeListener('connect', onConnected);
      peripheral.disconnect();
      delete peripheral.services;
      timeout = null;
      onConnected = null;
      reject('Connection Timeout');
    }, BLE_CONNECTION_TIMEOUT_MS);
    if (TRACE) {
      console.log(`<connectToPeripheral> peripheral.state=>${peripheral.state}`);
    }
    if (peripheral.state === 'connected') {
      return onConnected();
    }
    peripheral.once('connect', onConnected);
    peripheral.connect();
  });
}

function schedulePeripheralTask(uuid, task, RED) {
  if (!task) {
    return;
  }
  q.push((done) => {
    if (TRACE) {
      RED.log.info(`<schedulePeripheralTask> START`);
    }
    let peripheral = noble._peripherals[uuid];
    if (!peripheral) {
      if (TRACE) {
        RED.log.info(`<schedulePeripheralTask> END 00`);
      }
      return done();
    }

    function tearDown(err) {
      peripheral.disconnect(() => {
        delete peripheral.services;
        if (TRACE) {
          RED.log.info(`<schedulePeripheralTask> END 01,${err}`);
        }
        done(err);
      });
    }

    connectToPeripheral(peripheral).then((result) => {
      return task(/* services */result[0], /* bleDevice */ result[1], RED);
    }).then(() => {
      tearDown();
    }).catch((err) => {
      tearDown(err);
    });
  });
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
          schedulePeripheralTask(bleDevice.uuid, characteristicsTask, RED);
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
        RED.log.info('[GenericBLE:TRACE] ', peripheral);
      }
      if (configBleDevices[addressOrUUID]) {
        schedulePeripheralTask(peripheral.uuid, characteristicsTask, RED);
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

function stopScanning(RED) {
  RED.log.info(`[GenericBLE] Stop BLE scanning`);
  noble.stopScanning();
  noble.removeListener('stateChange', onStateChange);
  noble.removeListener('discover', onDiscover);
  Object.keys(bleDevices).forEach(k => delete bleDevices[k]);
}

function resetQueue(RED) {
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
      this._writeRequests = []; // {uuid:'characteristic-uuid-to-write', data:Buffer()}
      this._readRequests = []; // {uuid:'characteristic-uuid-to-read'}
      this.operations = {
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
          if (writables.length === 0) {
            return false;
          }
          let uuidList = Object.keys(dataObj);
          writables = writables.filter(c => uuidList.indexOf(c.uuid) >= 0);
          if (writables.length === 0) {
            return false;
          }
          this._writeRequests.push(writables.map(c => {
            return {
              uuid: c.uuid,
              data: dataObj[c.uuid],
              writeWithoutResponse: c.writeWithoutResponse
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
          this._readRequests.push(readables.map((r) => {
            return { uuid: r.uuid };
          }));
          return true;
        }
      };
      this.on('close', () => {
        stopScanning(RED);
        Object.keys(configBleDevices).forEach(k => delete configBleDevices[k]);
        resetQueue(RED);
      });
    }
  }
  RED.nodes.registerType('Generic BLE', GenericBLENode);

  class GenericBLEInNode {
    constructor(n) {
      RED.nodes.createNode(this, n);
      this.toString = n.toString;
      this.genericBleNodeId = n.genericBle;
      this.genericBleNode = RED.nodes.getNode(this.genericBleNodeId);
      if (this.genericBleNode) {
        this.genericBleNode.on('ble-read', (uuid, readObj, err) => {
          if (err) {
            RED.log.error(`[GenericBLE] <${uuid}> read: ${err}`);
            return;
          }
          this.send({
            payload: {
              uuid: uuid,
              characteristics: readObj
            }
          });
        });
        this.genericBleNode.on('ble-notify', (uuid, readObj, err) => {
          if (err) {
            RED.log.error(`[GenericBLE] <${uuid}> notify: ${err}`);
            return;
          }
          this.send({
            payload: {
              uuid: uuid,
              characteristics: readObj
            }
          });
        });
        this.on('input', () => {
          if (TRACE) {
            RED.log.info(`[GenericBLEIn] input arrived!`);
          }
          this.genericBleNode.operations.read();
        });
      }
      this.name = n.name;
    }
  }
  RED.nodes.registerType('Generic BLE in', GenericBLEInNode);

  class GenericBLEOutNode {
    constructor(n) {
      RED.nodes.createNode(this, n);
      this.toString = n.toString;
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
        this.on('input', (msg) => {
          this.genericBleNode.operations.write(msg);
        });
      }
      this.name = n.name;
    }
  }
  RED.nodes.registerType('Generic BLE out', GenericBLEOutNode);

  bleDevices.flushAll();
  startScanning(RED);
  resetQueue(RED);

  RED.events.on('runtime-event', (ev) => {
    if (TRACE) {
      RED.log.info(`[GenericBLE] <runtime-event> ${JSON.stringify(ev)}`);
    }
    if (ev.id === 'runtime-state') {
      if (TRACE) {
        RED.log.info(`[GenericBLE] Queue started`);
      }
      q.start();
    }
  });

  // __bledevlist endpoint
  RED.httpAdmin.get(
      '/__bledevlist',
      RED.auth.needsPermission('generic-ble.read'), (req, res) => {
    let promises = [];
    try {
      promises = bleDevices.keys().map(k => toApiObject(bleDevices.get(k)));
    } catch (_) {}
    Promise.all(promises).then(body => {
      if (TRACE) {
        console.log('/__bledevlist', JSON.stringify(body, null, 2));
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
    toApiObject(peripheral).then(bleDevice => {
      if (peripheral.services) {
        return toDetailedObject(peripheral).then(bleDevice => {
          if (TRACE) {
            console.log(`/__bledev/${address}`, JSON.stringify(bleDevice, null, 2));
          }
          return res.json(bleDevice);
        }).catch(err => {
          RED.log.error(`${err}\n${err.stack}`);
          return res.status(500).send(err.toString()).end();
        });
      }
      let timeout;
      let onConnected = (err) => {
        if (!onConnected) {
          return;
        }
        if (err) {
          RED.log.error(`${err}\n${err.stack}`);
          peripheral.disconnect();
          return;
        }
        if (!timeout) {
          // timeout is already performed
          return;
        }
        clearTimeout(timeout);
        if (TRACE) {
          RED.log.info(`[GenericBLE] <${address}> Searching services in the peripheral...`);
        }
        let promise;
        if (peripheral.services) {
          promise = Promise.resolve(peripheral);
        } else {
          promise = new Promise((resolve, reject) => {
            peripheral.discoverAllServicesAndCharacteristics(
                (err) => {
              if (err) {
                return reject(err);
              }
              return resolve(peripheral);
            });
          });
        }
        promise.then(() => {
          return toDetailedObject(peripheral);
        }).then(bleDevice => {
          if (TRACE) {
            RED.log.info(`/__bledev/${address}`, JSON.stringify(bleDevice, null, 2));
          }
          peripheral.disconnect();
          delete peripheral.services;
          return res.json(bleDevice);
        }).catch(err => {
          RED.log.error(`${err}\n${err.stack}`);
          peripheral.disconnect();
          delete peripheral.services;
          return res.status(500).send(err.toString()).end();
        });
      };
      timeout = setTimeout(() => {
        RED.log.error(`[GenericBLE] <${address}> BLE Connection Timeout: ${bleDevice.localName} (${bleDevice.rssi})`);
        res.status(500).send({status:500, message:'Connection Timeout'}).end();
        peripheral.removeListener('connect', onConnected);
        peripheral.disconnect();
        delete peripheral.services;
        deleteBleDevice(address);
        timeout = null;
        onConnected = null;
      }, BLE_CONNECTION_TIMEOUT_MS);
      if (peripheral.state === 'connected') {
        return onConnected();
      }
      peripheral.once('connect', onConnected);
      if (TRACE) {
        RED.log.info(`[GenericBLE] <${address}> Connecting peripheral...`);
      }
      peripheral.connect();
    }).catch(err => {
      RED.log.error(`${err}\n${err.stack}`);
      return res.status(500).send(err.toString()).end();
    });
  });
}
