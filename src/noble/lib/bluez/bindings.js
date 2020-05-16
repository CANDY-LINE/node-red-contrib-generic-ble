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

    this._state = null;
    this._scanFilterDuplicates = null;
    this._scanning = false;
    this.hciObjectPath = `/org/bluez/${process.env.HCIDEVICE || 'hci0'}`;

    debug('BluezBindings instance created!');
  }

  startScanning(/* never used */ serviceUuids, allowDuplicates) {
    if (this._initialized) {
      this._scanFilterDuplicates = !allowDuplicates;
      if (this._scanning) {
        debug(`[startScanning] Scan already ongoing...`);
      } else {
        debug(`[startScanning] Start Scanning...`);
        this.hciAdapter.StartDiscovery();
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

  stopScanning() {
    if (this._initialized) {
      debug(`[startScanning] Stop Scanning...`);
      this.hciAdapter.StopDiscovery();
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

  async getDeviceObject(/*deviceUuid*/ objectPath) {
    return this.bus.getProxyObject('org.bluez', objectPath);
  }

  async getDeviceInterface(/*deviceUuid*/ objectPath) {
    return (await this.getDeviceObject(objectPath)).getInterface(
      'org.bluez.Device1'
    );
  }

  async getDevicePropertiesInterface(/*deviceUuid*/ objectPath) {
    return (await this.getDeviceObject(objectPath)).getInterface(
      'org.freedesktop.DBus.Properties'
    );
  }

  async connect(deviceUuid) {
    debug(`connect:deviceUuid=>${deviceUuid}`);
    const deviceInterface = await this.getDeviceInterface(deviceUuid);
    try {
      await deviceInterface.Connect();
    } catch (err) {
      debug(
        `[ERROR] connect:deviceUuid=>${deviceUuid} => err.message:${
          err.message
        }, err.toString:${err.toString()}`
      );
      this.emit('stateChange', 'error', err);
    }
  }

  async disconnect(deviceUuid) {
    debug(`disconnect:deviceUuid=>${deviceUuid}`);
    const deviceInterface = await this.getDeviceInterface(deviceUuid);
    try {
      await deviceInterface.Disconnect();
    } catch (err) {
      debug(
        `[ERROR] disconnect:deviceUuid=>${deviceUuid} => err.message:${
          err.message
        }, err.toString:${err.toString()}`
      );
      this.emit('stateChange', 'error', err);
    }
  }

  async discoverServices(deviceUuid, uuids) {
    debug(`discoverServices:deviceUuid=>${deviceUuid},uuids=>${uuids}`);
    const props = await this.getDevicePropertiesInterface(deviceUuid);
    const servicesResolved = (
      await props.Get('org.bluez.Device1', 'ServicesResolved')
    ).value;
    if (servicesResolved) {
      this.onServicesResolved(props, deviceUuid);
    }
  }

  async discoverCharacteristics(deviceUuid, serviceUuid, characteristicUuids) {
    debug(
      `discoverCharacteristics:deviceUuid=>${deviceUuid},serviceUuid=>${serviceUuid},characteristicUuids=>${characteristicUuids}`
    );
    setTimeout(async () => {
      debug(
        `[${deviceUuid}] Collecting characteristsics for the service ${serviceUuid}`
      );
      const objectPathPrefix = `${deviceUuid}/service`;
      const bluezObjects = await this.bluezObjectManager.GetManagedObjects();
      const serviceObjectPaths = Object.keys(bluezObjects).filter(
        (objectPath) => objectPath.indexOf(objectPathPrefix) === 0
      );
      const serviceObjectPath = serviceObjectPaths.filter((objectPath) => {
        const serviceObject = bluezObjects[objectPath];
        return (
          serviceObject['org.bluez.GattService1'] &&
          serviceObject['org.bluez.GattService1'].UUID.value === serviceUuid
        );
      })[0];
      const characteristicPathPrefix = `${serviceObjectPath}/char`;
      const discoveredCharacteristics = serviceObjectPaths
        .filter(
          (objectPath) => objectPath.indexOf(characteristicPathPrefix) === 0
        )
        .map((objectPath) => {
          const chr = bluezObjects[objectPath]['org.bluez.GattCharacteristic1'];
          if (
            characteristicUuids.length > 0 &&
            !characteristicUuids.includes(chr.UUID.value)
          ) {
            return null;
          }
          return {
            uuid: chr.UUID.value,
            properties: chr.Flags.value,
          };
        })
        .filter((chr) => chr);
      this.emit(
        'characteristicsDiscover',
        deviceUuid,
        serviceUuid,
        discoveredCharacteristics
      );
      debug(
        `[${deviceUuid}] OK. Found ${discoveredCharacteristics.length} Characteristics.`
      );
    }, CHRARACTERISTICS_DISCOVERY_TIMEOUT_MS);
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
      if (device.RSSI) {
        this.onDeviceDiscovered(objectPath, device);
      } else {
        debug(
          `<onDevicesServicesCharacteristicsDiscovered> objectPath:${objectPath}, RSSI is missing. Removing the device ${
            device.Address.value
          }(${this.option(device, 'Alias', 'n/a')})`
        );
        this.hciAdapter.RemoveDevice(objectPath);
      }
    } else {
      debug(
        `<onDevicesServicesCharacteristicsDiscovered> objectPath:${objectPath}, interfaces:${JSON.stringify(
          interfaces
        )}`
      );
    }
  }

  async onDeviceDiscovered(peripheralUuid, device) {
    debug(
      `<onDeviceDiscovered> peripheralUuid:${peripheralUuid}, alias:${
        device.Alias.value || 'n/a'
      }, device: ${JSON.stringify(device)}`
    );

    const address = device.Address.value;
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
            data: Buffer.from(device.ServiceData.value[uuid]),
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
    const rssi = this.option(device, 'RSSI');

    // Device Properties Change Listener
    const props = await this.getDevicePropertiesInterface(peripheralUuid);
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
          this.onServicesResolved(props, peripheralUuid);
        }
        if (changedProps.RSSI) {
          this.emit('rssiUpdate', peripheralUuid, changedProps.RSSI.value);
        }
      }
    });

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
    /*getDevicePropertiesInterface()*/ props,
    /*peripheralUuid*/ objectPath
  ) {
    const serviceUuids = (await props.Get('org.bluez.Device1', 'UUIDs')).value;
    this.emit('servicesDiscover', objectPath, serviceUuids);
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
      this.emit('miss', /*peripheralUuid*/ objectPath);
    }
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
    debug(`[onScanStarted] fired`);
    const bluezObjects = await this.bluezObjectManager.GetManagedObjects();
    // Invoke DevicesDiscovered event listerner if devices already exists
    const deviceObjectPathPrefix = `${this.hciObjectPath}/dev_`;
    Object.keys(bluezObjects)
      .filter(
        (objectPath) =>
          objectPath.indexOf(deviceObjectPathPrefix) === 0 &&
          /*Exclude Service/Characteristic Paths*/ objectPath.length ===
            37 /*=> '/org/bluez/hci0/dev_11_22_33_44_55_66'.length*/
      )
      .forEach(
        /*deviceUuid*/ (objectPath) => {
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
