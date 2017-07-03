'use strict';

import 'source-map-support/register';
import noble from 'noble';
import NodeCache from 'node-cache';

const DEBUG = false;
const bleDevices = new NodeCache({
  stdTTL : 10 * 60 * 1000,
  checkperiod : 60 * 1000
});

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
  bleDevices.del(addressOrUUID);
  if (DEBUG) {
    console.log(`[GenericBLE:DEBUG] Delete => ${addressOrUUID}`);
  }
}

function onDiscover(peripheral) {
  let addressOrUUID = getAddressOrUUID(peripheral);
  if (!addressOrUUID) {
    return;
  } else if (peripheral.connectable) {
    bleDevices.set(addressOrUUID, peripheral);
    if (DEBUG) {
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
      obj.services = peripheral.services.map((s) => {
        let service = {
          uuid: s.uuid,
          name: s.name,
          type: s.type
        };
        service.characteristics = s.characteristics.map((c) => {
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
        });
        return service;
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
      this.on('close', () => {
        stopScanning(RED);
      });
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
        console.log('/__bledevlist', body);
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
      return res.status(404).end();
    }
    let peripheral = bleDevices.get(address);
    if (!peripheral) {
      return res.status(404).end();
    }
    // load the live object for invoking functions
    // as cached object is disconnected from noble context
    peripheral = noble._peripherals[peripheral.uuid];
    if (!peripheral) {
      return res.status(404).end();
    }
    toApiObject(peripheral).then(bleDevice => {
      if (!bleDevice.services && peripheral.state === 'disconnected') {
        RED.log.debug(`[GenericBLE] Connecting ${address}`);
        let timeout = setTimeout(() => {
          RED.log.error(`[GenericBLE] BLE Connection Timeout`);
          res.status(500).send('Connection Timeout').end();
          peripheral.disconnect();
          deleteBleDevice(address);
        }, 5000);
        peripheral.connect((err) => {
          if (err) {
            RED.log.error(`${err}\n${err.stack}`);
            return;
          }
          clearTimeout(timeout);
          RED.log.debug(`[GenericBLE] Searching services in ${address}`);
          peripheral.discoverAllServicesAndCharacteristics(
              (err, services, characteristics) => {
            if (err) {
              RED.log.error(`${err}\n${err.stack}`);
              return;
            }
            toDetailedObject(peripheral).then(bleDevice => {
              if (DEBUG) {
                console.log(`services.length=${services.length}, characteristics.length=${characteristics.length}`);
                console.log(`/__bledev/${address}`, bleDevice);
              }
              res.json(bleDevice);
              peripheral.disconnect();
            }).catch(err => {
              RED.log.error(`${err}\n${err.stack}`);
              return res.status(500).send(err.toString()).end();
            });
          });
        });
      } else {
        if (DEBUG) {
          console.log(`/__bledev/${address}`, bleDevice);
        }
        res.json(bleDevice);
      }
    }).catch(err => {
      RED.log.error(`${err}\n${err.stack}`);
      return res.status(500).send(err.toString()).end();
    });
  });
}
