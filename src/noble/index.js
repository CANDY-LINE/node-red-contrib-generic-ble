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

import Noble from '@abandonware/noble/lib/noble';
import os from 'os';
import debugLogger from 'debug';

const debug = debugLogger('node-red-contrib-generic-ble:noble');

const platform = os.platform();
debug(`Detected Platform => [${platform}]`);

let bindings;
if (platform === 'linux') {
  bindings = require('./lib/bluez/bindings').default;
}
if (!bindings) {
  debug(`Loading the default resolve-bindings module in @abandonware/noble.`);
  bindings = require('@abandonware/noble/lib/resolve-bindings')();
}

class PeripheralRemovableNoble extends Noble {
  constructor(bindings) {
    super(bindings);
    bindings.on('miss', this.onMiss.bind(this));
    bindings.on('error', this.onError.bind(this));
  }
  onMiss(uuid) {
    debug(`<onMiss:${uuid}> this.initialized => ${this.initialized}`);
    if (this._peripherals[uuid]) {
      const peripheral = this._peripherals[uuid];
      debug(`<onMiss:${uuid}> peripheral.state => ${peripheral.state}`);
      if (peripheral.state === 'connected') {
        peripheral.once('disconnect', () => {
          debug(
            `<onMiss:${uuid}:peripheral:disconnect> peripheral disconnected.`
          );
          this.onMiss(uuid);
        });
        peripheral.disconnect();
        return;
      }
      delete this._peripherals[uuid];
      delete this._services[uuid];
      delete this._characteristics[uuid];
      delete this._descriptors[uuid];
      const previouslyDiscoverdIndex = this._discoveredPeripheralUUids.indexOf(
        uuid
      );
      if (previouslyDiscoverdIndex >= 0) {
        this._discoveredPeripheralUUids.splice(previouslyDiscoverdIndex, 1);
      }
      debug(`Peripheral(uuid:${uuid}) has gone.`);
      this.emit('miss', peripheral);
    }
  }
  onError(err) {
    if (err.type === 'org.freedesktop.DBus.Error.AccessDenied') {
      this.initialized = false;
    }
    this.emit('error', err);
  }
}

module.exports = new PeripheralRemovableNoble(bindings);
