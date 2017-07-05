'use strict';

import 'source-map-support/register';
import noble from 'noble';
import NodeCache from 'node-cache';
import semaphore from 'semaphore';

const DEBUG = false;
const bleDevices = new NodeCache({
  stdTTL : 10 * 60 * 1000,
  checkperiod : 60 * 1000
});
const configBleDevices = {};
const Semaphores = {
  BLE_SCANNING: semaphore(1)
};

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
  if (value && DEBUG) {
    console.log(`[GenericBLE:DEBUG] Delete => ${addressOrUUID}`);
  }
}

function onDiscover(peripheral) {
  let addressOrUUID = getAddressOrUUID(peripheral);
  if (!addressOrUUID) {
    return;
  } else if (peripheral.connectable) {
    bleDevices.set(addressOrUUID, peripheral);
    if (false && DEBUG) {
      console.log('[GenericBLE:DEBUG] ',peripheral);
    }
  } else {
    deleteBleDevice(addressOrUUID);
  }
}

function startScanning(RED) {
  RED.log.info(`[GenericBLE] Start BLE scanning`);
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
        obj.characteristics = obj.characteristics.concat(s.characteristics.map((c) => {
          if (!c.type) {
            return null;
          }
          let characteristic = {
            uuid: c.uuid,
            name: c.name,
            type: c.type,
            properties: c.properties
          };
          if (c.type === 'org.bluetooth.characteristic.gap.device_name') {
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
      this.characteristics = n.characteristics || [];
      this.on('close', () => {
        stopScanning(RED);
        Object.keys(configBleDevices).forEach(k => delete configBleDevices[k]);
      });
      let key = getAddressOrUUID(n);
      if (key) {
        configBleDevices[key] = this;
      }
    }
  }
  RED.nodes.registerType('Generic BLE', GenericBLENode);

  startScanning(RED);

  // __bledevlist endpoint
  RED.httpAdmin.get(
      '/__bledevlist',
      RED.auth.needsPermission('generic-ble.read'), (req, res) => {
    let promises = bleDevices.keys().map(k => toApiObject(bleDevices.get(k)));
    Promise.all(promises).then(body => {
      if (DEBUG) {
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
      if (peripheral.state !== 'connected') {
        RED.log.debug(`[GenericBLE] <${address}> Connecting peripheral...`);
        let timeout = setTimeout(() => {
          RED.log.error(`[GenericBLE] <${address}> BLE Connection Timeout: ${bleDevice.localName} (${bleDevice.rssi})`);
          res.status(500).send({status:500, message:'Connection Timeout'}).end();
          peripheral.disconnect();
          Semaphores.BLE_SCANNING.leave();
          noble.startScanning([], true);
          deleteBleDevice(address);
          timeout = null;
        }, 5000);
        Semaphores.BLE_SCANNING.take(() => {
          noble.stopScanning();
          peripheral.connect((err) => {
            if (err) {
              RED.log.error(`${err}\n${err.stack}`);
              peripheral.disconnect();
              Semaphores.BLE_SCANNING.leave();
              noble.startScanning([], true);
              return;
            }
            if (!timeout) {
              // timeout is already performed
              return;
            }
            clearTimeout(timeout);
            RED.log.debug(`[GenericBLE] <${address}> Searching services in the peripheral...`);
            peripheral.discoverAllServicesAndCharacteristics(
                (err, services, characteristics) => {
              if (err) {
                RED.log.error(`${err}\n${err.stack}`);
                peripheral.disconnect();
                Semaphores.BLE_SCANNING.leave();
                noble.startScanning([], true);
                return;
              }
              toDetailedObject(peripheral).then(bleDevice => {
                if (DEBUG) {
                  console.log(`services.length=${services.length}, characteristics.length=${characteristics.length}`);
                  console.log(`/__bledev/${address}`, JSON.stringify(bleDevice, null, 2));
                }
                peripheral.disconnect();
                Semaphores.BLE_SCANNING.leave();
                noble.startScanning([], true);
                return res.json(bleDevice);
              }).catch(err => {
                RED.log.error(`${err}\n${err.stack}`);
                peripheral.disconnect();
                Semaphores.BLE_SCANNING.leave();
                noble.startScanning([], true);
                return res.status(500).send(err.toString()).end();
              });
            });
          });
        });
      } else {
        if (DEBUG) {
          console.log(`/__bledev/${address}`, JSON.stringify(bleDevice, null, 2));
        }
        return res.json(bleDevice);
      }
    }).catch(err => {
      RED.log.error(`${err}\n${err.stack}`);
      return res.status(500).send(err.toString()).end();
    });
  });
}
