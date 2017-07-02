'use strict';

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
    bleDevices.del(addressOrUUID);
    if (DEBUG) {
      console.log(`[GenericBLE:DEBUG] Delete => ${addressOrUUID}`);
    }
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
    return null;
  }
  let serviceUuids = peripheral.advertisement.serviceUuids || [];
  return {
    localName: peripheral.advertisement.localName,
    address: peripheral.address,
    uuid: serviceUuids.length > 0 ? serviceUuids[0] : '',
    rssi: peripheral.rssi
  };
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
    res.json(bleDevices.keys().map(k => toApiObject(bleDevices.get(k))));
  });
  // __bledev endpoint
  RED.httpAdmin.get(
      '/__bledev/:address',
      RED.auth.needsPermission('generic-ble.read'), (req, res) => {
    let address = req.params.address;
    if (!address) {
      return res.status(404).end();
    }
    let bleDevice = toApiObject(bleDevices.get(address));
    if (!bleDevice) {
      return res.status(404).end();
    }
    res.json(bleDevice);
  });
}
