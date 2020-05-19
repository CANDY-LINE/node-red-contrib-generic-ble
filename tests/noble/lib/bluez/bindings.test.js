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

describe('bindings', () => {
  const bindings = require('noble/lib/bluez/bindings').default;
  test('object is an instance of NobleBindings class', () => {
    expect(bindings).not.toBeNull();
    expect(bindings.bluez).toBeTruthy();
  });
  test('#_addDashes adds - to 128bit/16bit UUID', () => {
    expect(bindings._addDashes('00002a0000001000800000805f9b34fb')).toBe(
      '00002a00-0000-1000-8000-00805f9b34fb'
    );
    expect(bindings._addDashes('2a00')).toBe(
      '00002a00-0000-1000-8000-00805f9b34fb'
    );
  });
  test('#_stripDashes strips - from 128bit/16bit UUID', () => {
    expect(bindings._stripDashes('00002a00-0000-1000-8000-00805f9b34fb')).toBe(
      '2a00'
    );
    expect(bindings._stripDashes('00000000-0000-1000-8000-00805F9B34FB')).toBe(
      '0000'
    );
    expect(bindings._stripDashes('f000aa44-0451-4000-b000-000000000000')).toBe(
      'f000aa4404514000b000000000000000'
    );
  });
});
