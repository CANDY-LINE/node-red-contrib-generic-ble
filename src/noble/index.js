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

import Noble from '../../node_modules/@abandonware/noble/lib/noble';
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
  bindings = require('../../node_modules/@abandonware/noble/lib/resolve-bindings')();
}

class PeripheralRemovableNoble extends Noble {
  constructor(bindings) {
    super(bindings);
    bindings.on('miss', this.onMiss.bind(this));
  }
  onMiss(uuid) {
    if (super._peripherals[uuid]) {
      delete super._peripherals[uuid];
      delete super._services[uuid];
      delete super._characteristics[uuid];
      delete super._descriptors[uuid];
      const previouslyDiscoverdIndex = super._discoveredPeripheralUUids.indexOf(
        uuid
      );
      if (previouslyDiscoverdIndex >= 0) {
        super._discoveredPeripheralUUids.splice(previouslyDiscoverdIndex, 1);
      }
      debug(`Peripheral(uuid:${uuid}) has gone.`);
    }
  }
}

module.exports = new PeripheralRemovableNoble(bindings);
