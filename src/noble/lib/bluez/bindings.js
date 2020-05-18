/**
 * @license
 * Copyright (c) 2020 CANDY LINE INC.
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

import EventEmitter from 'events';
import debugLogger from 'debug';
import dbus from 'dbus-next';

const debug = debugLogger('node-red-contrib-generic-ble:noble:bluez');
const CHRARACTERISTICS_DISCOVERY_TIMEOUT_MS = parseInt(
  process.env.CHRARACTERISTICS_DISCOVERY_TIMEOUT_MS || '500'
);

// Workaround for a Jest Issue
// https://github.com/kulshekhar/ts-jest/issues/727#issuecomment-422747294
if (process.env.NODE_ENV !== 'test') {
  debug('Requiring "source-map-support/register"...');
  require('source-map-support/register');
}

class BluezBindings extends EventEmitter {
  constructor() {
    super();

    this.bus = dbus.systemBus();

    this._scanFilterDuplicates = null;
    this._scanning = false;
    this.hciObjectPath = `/org/bluez/${process.env.HCIDEVICE || 'hci0'}`;

    debug('BluezBindings instance created!');
  }

  async startScanning(/* never used */ serviceUuids, allowDuplicates) {
    if (this._initialized) {
      this._scanFilterDuplicates = !allowDuplicates;
      if (this._scanning) {
        debug(`[startScanning] Scan already ongoing...`);
      } else {
        debug(`[startScanning] Start Scanning...`);
        try {
          await this.hciAdapter.StartDiscovery();
        } catch (err) {
          debug(
            `[ERROR] startScanning => err.message:${
              err.message
            }, err.toString:${err.toString()}`
          );
        }
      }
    } else {
      this.once('poweredOn', () => {
        debug(
          `[startScanning] Trigger startScanning again as initialization done.`
        );
        this.startScanning(serviceUuids, allowDuplicates);
      });
    }
  }

  async stopScanning() {
    if (this._initialized) {
      debug(`[startScanning] Stop Scanning...`);
      try {
        await this.hciAdapter.StopDiscovery();
      } catch (err) {
        debug(
          `[ERROR] stopScanning => err.message:${
            err.message
          }, err.toString:${err.toString()}`
        );
      }
    }
  }

  async init() {
    if (this._initialized) {
      debug(`init: => already initialzied. Skip!`);
      return;
    }

    this.onSigIntBinded = this.onSigInt.bind(this);
    /* Add exit handlers after `init()` has completed. If no adaptor
    is present it can throw an exception - in which case we don't
    want to try and clear up afterwards (issue #502) */
    process.on('SIGINT', this.onSigIntBinded);
    process.on('exit', this.onExit.bind(this));

    this.bluezService = await this.bus.getProxyObject('org.bluez', '/');
    this.bluezObjectManager = this.bluezService.getInterface(
      'org.freedesktop.DBus.ObjectManager'
    );
    const bluezObjects = await this.bluezObjectManager.GetManagedObjects();
    debug(`Detected Object Paths:${Object.keys(bluezObjects)}`);
    if (!bluezObjects[this.hciObjectPath]) {
      this.emit('stateChange', 'error');
      debug(
        `Missing Bluetooth Object, Path:${
          this.hciObjectPath
        }, Valid Paths:${Object.keys(bluezObjects)}}`
      );
      throw new Error(
        `Missing Bluetooth Object, Path:${
          this.hciObjectPath
        }, Valid Paths:${Object.keys(bluezObjects)}}`
      );
    }
    this.hciObject = await this.bus.getProxyObject(
      'org.bluez',
      this.hciObjectPath
    );
    this.hciProps = this.hciObject.getInterface(
      'org.freedesktop.DBus.Properties'
    );
    this.hciAdapter = this.hciObject.getInterface('org.bluez.Adapter1');
    this._scanning = (
      await this.hciProps.Get('org.bluez.Adapter1', 'Discovering')
    ).value;
    if (this._scanning) {
      this.onScanStarted();
    }

    // Devices/Services/Characteristics Discovered/Missed
    this.bluezObjectManager.on(
      'InterfacesAdded',
      this.onDevicesServicesCharacteristicsDiscovered.bind(this)
    );
    this.bluezObjectManager.on(
      'InterfacesRemoved',
      this.onDevicesServicesCharacteristicsMissed.bind(this)
    );

    // Adapter Properties Change Listener
    this.hciProps.on(
      'PropertiesChanged',
      this.onAdapterPropertiesChanged.bind(this)
    );

    // init finished
    this._initialized = true;
    debug(`async init() => done`);
    this.emit('stateChange', 'poweredOn');
  }

  option(proxy, prop, defaultValue = null) {
    if (proxy[prop]) {
      return proxy[prop].value;
    }
    return defaultValue;
  }

  // /org/bluez/hci0/dev_11_22_33_DD_EE_FF => 112233ddeeff
  _toUuid(objectPath) {
    return objectPath
      .split('/')[4]
      .substring(4)
      .replace(/_/g, '')
      .toLowerCase();
  }

  _toObjectPath(peripheralUuid) {
    // 112233ddeeff => /org/bluez/hci0/dev_11_22_33_DD_EE_FF
    const uuid = peripheralUuid.toUpperCase();
    return `/org/bluez/hci0/dev_${uuid[0]}${uuid[1]}_${uuid[2]}${uuid[3]}_${uuid[4]}${uuid[5]}_${uuid[6]}${uuid[7]}_${uuid[8]}${uuid[9]}_${uuid[10]}${uuid[11]}`;
  }

  async _getDeviceObject(objectPath) {
    return this.bus.getProxyObject('org.bluez', objectPath);
  }

  async _getDeviceInterface(objectPath) {
    return (await this._getDeviceObject(objectPath)).getInterface(
      'org.bluez.Device1'
    );
  }

  async _getDevicePropertiesInterface(objectPath) {
    return (await this._getDeviceObject(objectPath)).getInterface(
      'org.freedesktop.DBus.Properties'
    );
  }

  async connect(deviceUuid) {
    debug(`connect:deviceUuid=>${deviceUuid}`);
    const objectPath = this._toObjectPath(deviceUuid);
    const deviceInterface = await this._getDeviceInterface(objectPath);
    try {
      await deviceInterface.Connect();
    } catch (err) {
      debug(
        `[ERROR] connect:deviceUuid=>${deviceUuid} => err.message:${
          err.message
        }, err.toString:${err.toString()}`
      );
      this.emit('connect', deviceUuid, err);
      try {
        await this.hciAdapter.RemoveDevice(objectPath);
      } catch (err) {
        debug(
          `[${deviceUuid}]<connect> Error while removing the device: ${err.message}, ${err.type}`
        );
      }
    }
  }

  async disconnect(deviceUuid) {
    debug(`disconnect:deviceUuid=>${deviceUuid}`);
    const objectPath = this._toObjectPath(deviceUuid);
    const deviceInterface = await this._getDeviceInterface(objectPath);
    try {
      await deviceInterface.Disconnect();
    } catch (err) {
      debug(
        `[ERROR] disconnect:deviceUuid=>${deviceUuid} => err.message:${
          err.message
        }, err.toString:${err.toString()}`
      );
      this.emit('disconnect', deviceUuid); // swallow err
    }
  }

  async discoverServices(deviceUuid, uuids) {
    debug(`discoverServices:deviceUuid=>${deviceUuid},uuids=>${uuids}`);
    const objectPath = this._toObjectPath(deviceUuid);
    const props = await this._getDevicePropertiesInterface(objectPath);
    const servicesResolved = (
      await props.Get('org.bluez.Device1', 'ServicesResolved')
    ).value;
    if (servicesResolved) {
      debug(
        `discoverServices:deviceUuid=>${deviceUuid}, servicesResolved=>${servicesResolved}`
      );
      this.onServicesResolved(deviceUuid, props);
    }
  }

  async _listCharacteristics(deviceUuid, serviceUuid, characteristicUuids) {
    debug(
      `[${deviceUuid}] Collecting characteristsics for the service ${serviceUuid}`
    );
    const objectPath = this._toObjectPath(deviceUuid);
    const objectPathPrefix = `${objectPath}/service`;
    const bluezObjects = await this.bluezObjectManager.GetManagedObjects();
    const serviceObjectPaths = Object.keys(bluezObjects).filter(
      (serviceObjectPath) => serviceObjectPath.indexOf(objectPathPrefix) === 0
    );
    if (serviceObjectPaths.length === 0) {
      return null;
    }
    const serviceObjectPath = serviceObjectPaths.filter((serviceObjectPath) => {
      const serviceObject = bluezObjects[serviceObjectPath];
      return (
        serviceObject['org.bluez.GattService1'] &&
        serviceObject['org.bluez.GattService1'].UUID.value === serviceUuid
      );
    })[0];
    if (!serviceObjectPath) {
      return null;
    }
    const characteristicPathPrefix = `${serviceObjectPath}/char`;
    const discoveredCharacteristics = {};
    serviceObjectPaths
      .filter(
        (serviceObjectPath) =>
          serviceObjectPath.indexOf(characteristicPathPrefix) === 0
      )
      .forEach((characteristicObjectPath) => {
        const chr =
          bluezObjects[characteristicObjectPath][
            'org.bluez.GattCharacteristic1'
          ];
        if (!chr) {
          // org.bluez.GattDescriptor1
          return;
        }
        if (
          characteristicUuids.length > 0 &&
          !characteristicUuids.includes(chr.UUID.value)
        ) {
          return;
        }
        discoveredCharacteristics[characteristicObjectPath] = chr;
      });
    return discoveredCharacteristics;
  }

  async discoverCharacteristics(deviceUuid, serviceUuid, characteristicUuids) {
    debug(
      `discoverCharacteristics:deviceUuid=>${deviceUuid},serviceUuid=>${serviceUuid},characteristicUuids=>${characteristicUuids}`
    );
    let timeout = 0;
    let discoveredCharacteristics = await this._listCharacteristics(
      deviceUuid,
      serviceUuid,
      characteristicUuids
    );
    if (!discoveredCharacteristics) {
      timeout = CHRARACTERISTICS_DISCOVERY_TIMEOUT_MS;
    }
    setTimeout(async () => {
      if (!discoveredCharacteristics) {
        discoveredCharacteristics = await this._listCharacteristics(
          deviceUuid,
          serviceUuid,
          characteristicUuids
        );
      }
      if (discoveredCharacteristics) {
        const resultChrs = Object.values(discoveredCharacteristics).map(
          (chr) => {
            return {
              uuid: chr.UUID.value,
              properties: chr.Flags.value,
            };
          }
        );
        debug(`resultChrs => ${JSON.stringify(resultChrs)}`);
        this.emit(
          'characteristicsDiscover',
          deviceUuid,
          serviceUuid,
          resultChrs
        );
        debug(
          `[${deviceUuid}] OK. Found ${resultChrs.length} Characteristics.`
        );
      } else {
        debug(`[${deviceUuid}] No Characteristics.`);
      }
    }, timeout);
  }

  async read(deviceUuid, serviceUuid, characteristicUuid) {
    debug(
      `read:deviceUuid=>${deviceUuid},serviceUuid=>${serviceUuid},characteristicUuid=>${characteristicUuid}`
    );
  }

  async write(
    deviceUuid,
    serviceUuid,
    characteristicUuid,
    data,
    withoutResponse
  ) {
    debug(
      `write:deviceUuid=>${deviceUuid},serviceUuid=>${serviceUuid},characteristicUuid=>${characteristicUuid},data=>${data},withoutResponse=>${withoutResponse}`
    );
  }

  async notify(deviceUuid, serviceUuid, characteristicUuid, notify) {
    debug(
      `notify:deviceUuid=>${deviceUuid},serviceUuid=>${serviceUuid},characteristicUuid=>${characteristicUuid},notify=>${notify}`
    );
  }

  // Methods not implemented:
  // updateRssi(deviceUuid)
  // discoverIncludedServices(deviceUuid, serviceUuid, serviceUuids)
  // broadcast(deviceUuid, serviceUuid, characteristicUuid, broadcast)
  // discoverDescriptors(deviceUuid, serviceUuid, characteristicUuid)
  // readValue(deviceUuid, serviceUuid, characteristicUuid, descriptorUuid)
  // writeValue(deviceUuid, serviceUuid, characteristicUuid, descriptorUuid, data)
  // readHandle(deviceUuid, handle)
  // writeHandle(deviceUuid, handle, data, withoutResponse)

  async onDevicesServicesCharacteristicsDiscovered(
    objectPath,
    /*Object<String,Object<String,Variant>>*/ interfacesAndProps
  ) {
    const interfaces = Object.keys(interfacesAndProps);
    if (interfaces.includes('org.bluez.Device1')) {
      const device = interfacesAndProps['org.bluez.Device1'];
      this.onDeviceDiscovered(objectPath, device);
    } else {
      debug(
        `<onDevicesServicesCharacteristicsDiscovered> objectPath:${objectPath}, interfaces:${JSON.stringify(
          interfaces
        )}`
      );
    }
  }

  async onDeviceDiscovered(objectPath, device) {
    debug(
      `<onDeviceDiscovered> objectPath:${objectPath}, alias:${
        device.Alias.value || 'n/a'
      }, device: ${JSON.stringify(device)}`
    );
    const peripheralUuid = this._toUuid(objectPath);

    // Device Properties Change Listener
    const props = await this._getDevicePropertiesInterface(objectPath);
    props.on('PropertiesChanged', async (
      /*string*/ interfaceName,
      /*obj*/ changedProps,
      /*string[]*/ invalidatedProps
    ) => {
      debug(
        `[${peripheralUuid}]<PropertiesChanged> interfaceName:${interfaceName}, changedProps:${Object.keys(
          changedProps
        )}, invalidatedProps:${JSON.stringify(invalidatedProps)}`
      );
      if (interfaceName === 'org.bluez.Device1') {
        if (changedProps.Connected) {
          if (changedProps.Connected.value) {
            this.emit('connect', peripheralUuid);
          } else {
            this.emit('disconnect', peripheralUuid);
          }
        }
        if (
          changedProps.ServicesResolved &&
          changedProps.ServicesResolved.value
        ) {
          this.onServicesResolved(peripheralUuid, props);
        }
        if (changedProps.RSSI) {
          this.emit('rssiUpdate', peripheralUuid, changedProps.RSSI.value);
        }
        if (invalidatedProps.includes('RSSI')) {
          debug(
            `[${peripheralUuid}]<PropertiesChanged> RSSI is invalidated. Removing the device.`
          );
          try {
            await this.hciAdapter.RemoveDevice(objectPath);
          } catch (err) {
            debug(
              `[${peripheralUuid}]<PropertiesChanged> Error while removing the device: ${err.message}, ${err.type}`
            );
          }
        }
      }
    });

    const rssi = this.option(device, 'RSSI');
    const address = (device.Address.value || '').toLowerCase();
    const addressType = device.AddressType.value;
    const connectable = !device.Blocked.value;
    const manufacturerData = device.ManufacturerData
      ? Object.values(device.ManufacturerData.value)[0].value
      : null;
    if (manufacturerData) {
      // Prepend Manufacturer ID
      manufacturerData.unshift(Object.keys(device.ManufacturerData.value)[0]);
    }
    const serviceData = device.ServiceData
      ? Object.keys(device.ServiceData.value).map((uuid) => {
          return {
            uuid,
            data: Buffer.from(device.ServiceData.value[uuid].value),
          };
        })
      : null;
    const advertisement = {
      localName: this.option(device, 'Alias'),
      txPowerLevel: this.option(device, 'TxPower'),
      serviceUuids: this.option(device, 'UUIDs', []),
      manufacturerData: manufacturerData ? Buffer.from(manufacturerData) : null,
      serviceData,
    };

    this.emit(
      'discover',
      peripheralUuid,
      address,
      addressType,
      connectable,
      advertisement,
      rssi
    );
  }

  async onServicesResolved(
    peripheralUuid,
    /*_getDevicePropertiesInterface()*/ props
  ) {
    const serviceUuids = (await props.Get('org.bluez.Device1', 'UUIDs')).value;
    this.emit('servicesDiscover', peripheralUuid, serviceUuids);
  }

  async onDevicesServicesCharacteristicsMissed(
    objectPath,
    /*String[]*/ interfaces
  ) {
    debug(
      `<InterfacesRemoved:DevicesMissed> objectPath:${objectPath}, interfaces:${JSON.stringify(
        interfaces
      )}`
    );
    if (interfaces.includes('org.bluez.Device1')) {
      const peripheralUuid = this._toUuid(objectPath);
      this.onDeviceMissed(peripheralUuid);
    }
  }

  async onDeviceMissed(peripheralUuid) {
    debug(`<onDeviceMissed> peripheralUuid:${peripheralUuid}`);
    this.emit('miss', peripheralUuid);
  }

  async onAdapterPropertiesChanged(
    /*string*/ interfaceName,
    /*obj*/ changedProps,
    /*string[]*/ invalidatedProps
  ) {
    debug(
      `<Adapter:PropertiesChanged> interfaceName:${interfaceName}, changedProps:${Object.keys(
        changedProps
      )}, invalidatedProps:${JSON.stringify(invalidatedProps)}`
    );
    if (interfaceName === 'org.bluez.Adapter1') {
      if (changedProps.Discovering) {
        debug(`Discovering=>${changedProps.Discovering.value}`);
        if (changedProps.Discovering.value) {
          this.onScanStarted();
        } else {
          this.onScanStopepd();
        }
      }
      if (changedProps.Powered) {
        debug(`Powered=>${changedProps.Powered.value}`);
        if (!changedProps.Powered.value) {
          this.emit('stateChange', 'poweredOff');
        }
      }
      // Skip to show other props
    }
  }

  async onScanStarted() {
    debug(`<onScanStarted> fired`);
    const bluezObjects = await this.bluezObjectManager.GetManagedObjects();
    // Invoke DevicesDiscovered event listerner if devices already exists
    const deviceObjectPathPrefix = `${this.hciObjectPath}/dev_`;
    let count = 0;
    Object.keys(bluezObjects)
      .filter(
        (objectPath) =>
          objectPath.indexOf(deviceObjectPathPrefix) === 0 &&
          /*Exclude Service/Characteristic Paths*/ objectPath.length ===
            37 /*=> '/org/bluez/hci0/dev_11_22_33_44_55_66'.length*/
      )
      .forEach(
        /*deviceUuid*/ (objectPath) => {
          debug(`<onScanStarted> ${count++}:${objectPath} Device Found`);
          const interfacesAndProps = bluezObjects[objectPath];
          this.onDevicesServicesCharacteristicsDiscovered(
            objectPath,
            /*Object<String,Object<String,Variant>>*/ interfacesAndProps
          );
        }
      );
    this.emit('scanStart', this._scanFilterDuplicates);
  }

  onScanStopepd() {
    debug(`[onScanStopepd] fired`);
    this.emit('scanStop');
  }

  onSigInt() {
    const sigIntListeners = process.listeners('SIGINT');

    if (sigIntListeners[sigIntListeners.length - 1] === this.onSigIntBinded) {
      // we are the last listener, so exit
      // this will trigger onExit, and clean up
      process.exit(1);
    }
  }

  onExit() {
    this.stopScanning();
  }

  get bluez() {
    return true;
  }
}

export default new BluezBindings();
