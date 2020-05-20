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

    // Remove entry on onDevicesServicesCharacteristicsMissed()
    this.objectStore = {
      // key: objectPath, value: any
    };

    debug('BluezBindings instance created!');
  }

  _addDashes(uuid) {
    if (!uuid || typeof uuid !== 'string') {
      return uuid;
    }
    uuid = this._to128bitUuid(uuid);
    if (uuid.length === 32) {
      uuid = `${uuid.substring(0, 8)}-${uuid.substring(8, 12)}-${uuid.substring(
        12,
        16
      )}-${uuid.substring(16, 20)}-${uuid.substring(20)}`;
    }
    return uuid.toLowerCase();
  }

  _stripDashes(uuid) {
    if (typeof uuid === 'string') {
      uuid = uuid.split('-').join('').toLowerCase();
    }
    return this._to16bitUuid(uuid);
  }

  _to128bitUuid(uuid) {
    // Bluetooth Base UUID(00000000-0000-1000-8000-00805F9B34FB)
    // Device Name (w/o dashes) : 2a00 => 00002a0000001000800000805f9b34fb
    if (uuid.length === 4) {
      uuid = `0000${uuid}-0000-1000-8000-00805f9b34fb`;
    }
    return uuid;
  }

  _to16bitUuid(uuid) {
    // Bluetooth Base UUID(00000000-0000-1000-8000-00805F9B34FB)
    // Device Name (w/o dashes) : 00002a0000001000800000805f9b34fb => 2a00
    if (
      uuid.indexOf('0000') === 0 &&
      uuid.indexOf('00001000800000805f9b34fb') === 8
    ) {
      return uuid.substring(4, 8);
    }
    return uuid;
  }

  async _startDiscovery() {
    try {
      const powered = (await this.hciProps.Get('org.bluez.Adapter1', 'Powered'))
        .value;
      if (!powered) {
        debug(`[_startDiscovery] Turning the adapter on...`);
        await this.hciProps.Set(
          'org.bluez.Adapter1',
          'Powered',
          new dbus.Variant('b', true)
        );
      }
      debug(`[_startDiscovery] Setting discovery filter...`);
      await this.hciAdapter.SetDiscoveryFilter({
        DuplicateData: new dbus.Variant('b', !this._scanFilterDuplicates),
      });
      debug(`[_startDiscovery] Start Scanning...`);
      await this.hciAdapter.StartDiscovery();
    } catch (err) {
      debug(
        `[ERROR] _startDiscovery => err.message:${
          err.message
        }, err.toString:${err.toString()}`
      );
      if (!this._scanning) {
        // failed to power on
        this.emit('stateChange', 'poweredOff');
      }
    }
  }

  async startScanning(/* never used */ serviceUuids, allowDuplicates) {
    if (this._initialized) {
      this._scanFilterDuplicates = !allowDuplicates;
      if (this._scanning) {
        debug(`[startScanning] Scan already ongoing...`);
      } else {
        await this._startDiscovery();
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
    debug(`initializing....`);

    this.onSigIntBinded = this.onSigInt.bind(this);
    /* Add exit handlers after `init()` has completed. If no adaptor
    is present it can throw an exception - in which case we don't
    want to try and clear up afterwards (issue #502) */
    process.on('SIGINT', this.onSigIntBinded);
    process.on('exit', this.onExit.bind(this));

    try {
      this.bluezService = await this.bus.getProxyObject('org.bluez', '/');
      this.bluezObjectManager = this.bluezService.getInterface(
        'org.freedesktop.DBus.ObjectManager'
      );
      const bluezObjects = await this.bluezObjectManager.GetManagedObjects();
      debug(`Detected Object Paths:${Object.keys(bluezObjects)}`);
      if (!bluezObjects[this.hciObjectPath]) {
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
    } catch (err) {
      debug(
        `async init() => error { message:${err.message}, type: ${err.type} }`
      );
      this.emit('stateChange', 'error');
      this.emit('error', err);
    }
  }

  _option(proxy, prop, defaultValue = null) {
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

  async _getProxyObject(objectPath) {
    return this.bus.getProxyObject('org.bluez', objectPath);
  }

  async _getDeviceInterface(objectPath) {
    return (await this._getProxyObject(objectPath)).getInterface(
      'org.bluez.Device1'
    );
  }

  async _getPropertiesInterface(objectPath) {
    return (await this._getProxyObject(objectPath)).getInterface(
      'org.freedesktop.DBus.Properties'
    );
  }

  async _getCharacteristicInterface(objectPath) {
    return (await this._getProxyObject(objectPath)).getInterface(
      'org.bluez.GattCharacteristic1'
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
    const props = await this._getPropertiesInterface(objectPath);
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
    const dashedCharacteristicUuids = (characteristicUuids || []).map(
      this._addDashes.bind(this)
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
          dashedCharacteristicUuids.length > 0 &&
          !dashedCharacteristicUuids.includes(chr.UUID.value)
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
    const discoveredCharacteristics = await this._listCharacteristics(
      deviceUuid,
      serviceUuid,
      characteristicUuids
    );
    const resultChrs = Object.values(discoveredCharacteristics || {}).map(
      (chr) => {
        return {
          uuid: this._stripDashes(chr.UUID.value),
          properties: chr.Flags.value,
        };
      }
    );
    debug(`resultChrs => ${JSON.stringify(resultChrs)}`);
    try {
      this.emit('characteristicsDiscover', deviceUuid, serviceUuid, resultChrs);
      debug(
        `[${deviceUuid}] OK. Found ${resultChrs.length} Characteristics. characteristicsDiscover event`
      );
    } catch (err) {
      debug(
        `Failed to emit 'characteristicsDiscover' event. message:${err.message}`
      );
    }
  }

  async read(deviceUuid, serviceUuid, characteristicUuid) {
    const dashedCharacteristicUuid = this._addDashes(characteristicUuid);
    debug(
      `read:deviceUuid=>${deviceUuid},serviceUuid=>${serviceUuid},dashedCharacteristicUuid=>${dashedCharacteristicUuid}`
    );
    const discoveredCharacteristics = await this._listCharacteristics(
      deviceUuid,
      serviceUuid,
      [dashedCharacteristicUuid]
    );
    let data = null; // Buffer object
    const characteristicObjectPath = Object.keys(discoveredCharacteristics)[0];
    if (characteristicObjectPath) {
      const chracteristic = await this._getCharacteristicInterface(
        characteristicObjectPath
      );
      data = Buffer.from(await chracteristic.ReadValue({}));
    }
    debug(
      `read:characteristicObjectPath=>${characteristicObjectPath}, data=>${JSON.stringify(
        data
      )}`
    );
    this.emit('read', deviceUuid, serviceUuid, characteristicUuid, data, false);
  }

  async write(
    deviceUuid,
    serviceUuid,
    characteristicUuid,
    data, // Buffer object
    withoutResponse
  ) {
    const dashedCharacteristicUuid = this._addDashes(characteristicUuid);
    debug(
      `write:deviceUuid=>${deviceUuid},serviceUuid=>${serviceUuid},dashedCharacteristicUuid=>${dashedCharacteristicUuid},data=>${data},withoutResponse=>${withoutResponse}`
    );
    const discoveredCharacteristics = await this._listCharacteristics(
      deviceUuid,
      serviceUuid,
      [dashedCharacteristicUuid]
    );
    const characteristicObjectPath = Object.keys(discoveredCharacteristics)[0];
    if (characteristicObjectPath) {
      const chracteristic = await this._getCharacteristicInterface(
        characteristicObjectPath
      );
      data = data.toJSON().data;
      const type = withoutResponse ? 'command' : 'request';
      await chracteristic.WriteValue(data, {
        type: new dbus.Variant('s', type),
      });
    }
    debug(
      `write:characteristicObjectPath=>${characteristicObjectPath}, data=>${JSON.stringify(
        data
      )}, withoutResponse=>${withoutResponse}`
    );
    this.emit(
      'write',
      deviceUuid,
      serviceUuid,
      characteristicUuid,
      data,
      withoutResponse
    );
  }

  async notify(deviceUuid, serviceUuid, characteristicUuid, subscribe) {
    const dashedCharacteristicUuid = this._addDashes(characteristicUuid);
    debug(
      `notify:deviceUuid=>${deviceUuid},serviceUuid=>${serviceUuid},dashedCharacteristicUuid=>${dashedCharacteristicUuid},subscribe?=>${subscribe}`
    );
    const discoveredCharacteristics = await this._listCharacteristics(
      deviceUuid,
      serviceUuid,
      [dashedCharacteristicUuid]
    );
    const characteristicObjectPath = Object.keys(discoveredCharacteristics)[0];
    if (characteristicObjectPath) {
      const chracteristic = await this._getCharacteristicInterface(
        characteristicObjectPath
      );

      // GattCharacteristic1 Properties Change Listener
      const props = await this._getPropertiesInterface(
        characteristicObjectPath
      );
      if (!this.objectStore[characteristicObjectPath]) {
        this.objectStore[characteristicObjectPath] = {};
      }
      const objectStore = this.objectStore[characteristicObjectPath] || {};
      this.objectStore[characteristicObjectPath] = objectStore;
      if (!objectStore.notificationHandeler) {
        debug(`Setting objectStore.notificationHandeler`);
        objectStore.notificationHandeler = async (
          /*string*/ interfaceName,
          /*obj*/ changedProps,
          /*string[]*/ invalidatedProps
        ) => {
          debug(
            `[${characteristicObjectPath}]<PropertiesChanged> interfaceName:${interfaceName}, changedProps:${Object.keys(
              changedProps
            )}, invalidatedProps:${JSON.stringify(invalidatedProps)}`
          );
          if (interfaceName === 'org.bluez.GattCharacteristic1') {
            if (changedProps.Value) {
              this.emit(
                'read',
                deviceUuid,
                serviceUuid,
                characteristicUuid,
                Buffer.from(changedProps.Value.value),
                objectStore.notifying
              );
            }
            debug(
              `[${characteristicObjectPath}]<PropertiesChanged> GattCharacteristic1 changedProps=>${JSON.stringify(
                changedProps
              )}`
            );
          }
        };
        props.on('PropertiesChanged', objectStore.notificationHandeler);
      }
      const notifying = (
        await props.Get('org.bluez.GattCharacteristic1', 'Notifying')
      ).value;
      debug(
        `${deviceUuid}, subscribing(${characteristicUuid})? => ${notifying}`
      );
      if (subscribe) {
        await chracteristic.StartNotify();
        objectStore.notifying = true;
        debug(
          `${deviceUuid}, START subscribing(${characteristicUuid}) Notify events`
        );
      } else {
        await chracteristic.StopNotify();
        objectStore.notifying = false;
        debug(
          `${deviceUuid}, STOP subscribing(${characteristicUuid}) Notify events`
        );
      }
      this.emit(
        'notify',
        deviceUuid,
        serviceUuid,
        characteristicUuid,
        subscribe
      );
    }
    debug(
      `notify:characteristicObjectPath=>${characteristicObjectPath}, subscribe?=>${subscribe}`
    );
    this.emit('notify', deviceUuid, serviceUuid, characteristicUuid, subscribe);
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
    const props = await this._getPropertiesInterface(objectPath);
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
            if (err.type !== 'org.bluez.Error.DoesNotExist') {
              debug(
                `[${peripheralUuid}]<PropertiesChanged> Error while removing the device: ${err.message}, ${err.type}`
              );
            }
          }
        }
      }
    });

    const rssi = this._option(device, 'RSSI');
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
      localName: this._option(device, 'Alias'),
      txPowerLevel: this._option(device, 'TxPower'),
      serviceUuids: this._option(device, 'UUIDs', []),
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
    /*_getPropertiesInterface()*/ props
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
    delete this.objectStore[objectPath];
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
          this._scanning = false;
          setTimeout(async () => {
            try {
              await this._startDiscovery();
            } catch (err) {
              debug(
                `Error while turning on the adapter. err.message:${err.message}, type:${err.type}`
              );
            }
          }, 5 * 1000);
        }
      }
      // Skip to show other props
    }
  }

  async onScanStarted() {
    debug(`<onScanStarted> fired`);
    this._scanning = true;
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
    this._scanning = false;
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
