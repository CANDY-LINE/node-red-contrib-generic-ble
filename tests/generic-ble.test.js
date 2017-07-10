'use strict';

import 'source-map-support/register';
import * as sinon from 'sinon';
import { assert } from 'chai';
import genericBLEModule from '../dist/generic-ble';
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
      registerType: () => {}
    });
    RED.log = sandbox.stub({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {}
    });
    RED.httpAdmin = sandbox.stub({
      get: () => {}
    });
    RED.auth = sandbox.stub({
      needsPermission: () => {}
    });
	});
	afterEach(() => {
		sandbox = sandbox.restore();
	});
  describe('generic-ble module', () => {
    it('should have valid Node-RED plugin classes', () => {
      assert.isNotNull(RED);
      genericBLEModule(RED);
      assert.isTrue(RED.nodes.registerType.withArgs('Generic BLE out', sinon.match.any).calledOnce);
    });
  });
});
