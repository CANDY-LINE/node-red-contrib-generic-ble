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

    this._state = null;
    this._scanning = false;
    this.hciObjectPath = `/org/bluez/${process.env.HCIDEVICE || 'hci0'}`;

    debug('BluezBindings instance created!');
  }

  startScanning(
    /* never used */ serviceUuids,
    /* never used */ allowDuplicates
  ) {
    this._scanning = true;
    if (this._initialized) {
      this.hciAdapter.StartDiscovery();
    } else {
      this.once('poweredOn', () => {
        this.startScanning(serviceUuids, allowDuplicates);
      });
    }
  }

  stopScanning() {
    this._scanning = false;
    if (this._initialized) {
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

    // Device Discovered/Missed
    this.bluezObjectManager.on(
      'InterfacesAdded',
      this.onDevicesDiscovered.bind(this)
    );
    this.bluezObjectManager.on(
      'InterfacesRemoved',
      this.onDevicesMissed.bind(this)
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

  async onDevicesDiscovered(
    objectPath,
    /*Object<String,Object<String,Variant>>*/ interfacesAndProps
  ) {
    const interfaces = Object.keys(interfacesAndProps);
    const device = interfacesAndProps['org.bluez.Device1'];
    debug(
      `<InterfacesAdded:DevicesDiscovered> objectPath:${objectPath}, alias:${
        device.Alias.value || 'n/a'
      }, interfaces:${JSON.stringify(interfaces)}, device: ${JSON.stringify(
        device
      )}`
    );

    const peripheralUuid = objectPath; // deviceUuid = peripheralUuid = objectPath
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
    const props = await this.getDevicePropertiesInterface(objectPath);
    props.on('PropertiesChanged', async (
      /*string*/ interfaceName,
      /*obj*/ changedProps,
      /*obj*/ invalidatedProps
    ) => {
      debug(
        `[${objectPath}]<PropertiesChanged> interfaceName:${interfaceName}, changedProps:${Object.keys(
          changedProps
        )}, invalidatedProps:${Object.keys(invalidatedProps)}`
      );
      if (interfaceName === 'org.bluez.Device1') {
        if (changedProps.Connected) {
          if (changedProps.Connected.value) {
            this.emit('connect', objectPath);
          } else {
            this.emit('disconnect', objectPath);
          }
        }
        if (
          changedProps.ServicesResolved &&
          changedProps.ServicesResolved.value
        ) {
          this.onServicesResolved(props, objectPath);
        }
        if (changedProps.RSSI) {
          this.emit(
            'rssiUpdate',
            /*peripheralUuid*/ objectPath,
            changedProps.RSSI.value
          );
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

  async onDevicesMissed(objectPath, /*String[]*/ interfaces) {
    debug(
      `<InterfacesRemoved:DevicesMissed> objectPath:${objectPath}, interfaces:${JSON.stringify(
        interfaces
      )}`
    );
    this.emit('miss', objectPath);
  }

  async onAdapterPropertiesChanged(
    /*string*/ interfaceName,
    /*obj*/ changedProps,
    /*obj*/ invalidatedProps
  ) {
    debug(
      `<Adapter:PropertiesChanged> interfaceName:${interfaceName}, changedProps:${Object.keys(
        changedProps
      )}, invalidatedProps:${Object.keys(invalidatedProps)}`
    );
    if (interfaceName === this.hciObjectPath) {
      if (changedProps.Discovering) {
        debug(`Discovering=>${changedProps.Discovering.value}`);
        if (changedProps.Discovering.value) {
          this.emit('scanStart');
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
                this.onDevicesDiscovered(
                  objectPath,
                  /*Object<String,Object<String,Variant>>*/ interfacesAndProps
                );
              }
            );
        } else {
          this.emit('scanStop');
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
