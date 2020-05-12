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

const debug = debugLogger('node-red-contrib-generic-ble:noble:bluetoothctl');

class BluezBindings extends EventEmitter {
  constructor() {
    super();

    this._state = null;

    this._addresses = {};
    this._addresseTypes = {};
    this._connectable = {};

    this._pendingConnectionUuid = null;
    this._connectionQueue = [];

    this._allowDuplicates = false;
    this._scanning = false;
    debug('BluezBindings instance created!');
  }

  startScanning(serviceUuids, allowDuplicates) {
    this._scanServiceUuids = serviceUuids || [];
    this._allowDuplicates = allowDuplicates;
    this._scanning = true;
  }

  stopScanning() {
    this._scanning = false;
  }

  init() {
    this.onSigIntBinded = this.onSigInt.bind(this);
    /* Add exit handlers after `init()` has completed. If no adaptor
    is present it can throw an exception - in which case we don't
    want to try and clear up afterwards (issue #502) */
    process.on('SIGINT', this.onSigIntBinded);
    process.on('exit', this.onExit.bind(this));
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
