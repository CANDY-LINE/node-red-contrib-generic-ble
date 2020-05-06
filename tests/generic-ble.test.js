/**
 * @license
 * Copyright (c) 2017 CANDY LINE INC.
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

import * as sinon from 'sinon';
import genericBLEModule from 'generic-ble';
import EventEmitter from 'events';

const RED = {};

describe('generic-ble node', () => {
  RED.debug = true;
  let sandbox;
  beforeEach(() => {
    sandbox = sinon.sandbox.create();
    RED._ = sinon.spy();
    RED.events = sandbox.stub(new EventEmitter());
    RED.nodes = sandbox.stub({
      registerType: () => {},
    });
    RED.log = sandbox.stub({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    });
    RED.httpAdmin = sandbox.stub({
      get: () => {},
      post: () => {},
    });
    RED.auth = sandbox.stub({
      needsPermission: () => {},
    });
  });
  afterEach(() => {
    sandbox = sandbox.restore();
  });
  describe('generic-ble module', () => {
    test('should have valid Node-RED plugin classes', () => {
      expect(RED).not.toBeNull();
      genericBLEModule(RED);
      expect(
        RED.nodes.registerType.withArgs('Generic BLE', sinon.match.any)
          .calledOnce
      ).toBeTruthy();
      expect(
        RED.nodes.registerType.withArgs('Generic BLE in', sinon.match.any)
          .calledOnce
      ).toBeTruthy();
      expect(
        RED.nodes.registerType.withArgs('Generic BLE out', sinon.match.any)
          .calledOnce
      ).toBeTruthy();
    });
  });
});
