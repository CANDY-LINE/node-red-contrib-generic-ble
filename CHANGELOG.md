# Revision History

* 4.0.3
  - Always show BLE error info
  - Update dependencies

* 4.0.2
  - Fix Module Loading Error on macOS

* 4.0.1
  - Fix Module Loading Error

* 4.0.0
  - The node category is now `Network` rather than `Input` and `Output`.
  - Improve stability on Linux by introducing BlueZ 5 D-Bus API
    - On Linux, this node is no longer dependent on the HCI socket library, which has lots of problematic issues that caused inconsistent results with old BlueZ CLI tools.
    - Note that when Node-RED process is run by non-root user, add the user to `bluetooth` group so to access BlueZ D-Bus API. For example, run `sudo usermod -G bluetooth -a pi` prior to starting the process if it's run by `pi` user.
    - BlueZ's BLE scanning seems to detect devices having `random` address type. But not sure if such devices work with this node properly.
    - Tested on Raspbian (4.19.97-v7l+) and Raspberry Pi 3/4.
      - With the following packages
        - bluez 5.50-1.2~deb10u1
        - bluez-firmware 1.2-4+rpt2
  - Improve BLE Device Scanning UI/UX
    - Check `BLE Scanning` in order to start scanning, and `Scan Result` select box will be fullfilled automatically whenever devices are found. The update will be performed every 10 seconds. The first scan result will appear after 5 seconds since the scanning starts. See the updated README document for detail.
  - `GENERIC_BLE_TRACE` environment variable is no longer working. Use `DEBUG` environment variable instead.
    - `DEBUG=node-red-contrib-generic-ble:index` is compatible with `GENERIC_BLE_TRACE=true`.
    - `DEBUG=node-red-contrib-generic-ble:*` will output all trace logs within the project.
    - `DEBUG=node-red-contrib-generic-ble:index:api` will output all API endpoint access logs.
    - `DEBUG=node-red-contrib-generic-ble:noble:*` will output all trace logs under `src/noble` modules.

* 3.1.0
  - Support Node.js v10.x LTS (Fix #14 and #17)

* 3.0.0
  - Refactor entire architecture
  - Peripheral connections are retained until it disconnects
  - Characteristic subscriptions are retained while the ongoing flows are running (will be unsubscribed on stopping them though)
  - The max number of concurrent BLE connections is 5 or 6 according to [this document](https://github.com/noble/noble#maximum-simultaneous-connections)

* 2.0.4
  - Fix an issue where this node don't work with noble@1.9.x

* 2.0.3
  - Fix an issue where noble looses a reference to a peripheral after it is disconnected

* 2.0.2
  - Fix an issue where Write operation cannot be performed properly (#4)

* 2.0.1
  - Fix an issue where `Select from scan result` failed to list characteristics

* 2.0.0
  - Add `Poll Notify Events` message support so that Generic BLE out node can start to subscribe the given characteristic events
  - Support characteristic query by one or more uuids
  - Add `Mute Notify Events` to `Generic BLE` config node for this node to avoid unnecessary device connection for event subscription
  - Replace `RED.log` functions with node logging functions as possible to offer precise logging control via UI
  - Add `Operation Timeout` to `Generic BLE` config node to set the waiting time for Read/Write/Notify response **per characteristic** rather than per device
  - `GENERIC_BLE_OPERATION_WAIT_MS` is introduced for default `Operation Timeout` value
  - Remove `Listening Period` from `Generic BLE` config node
  - `GENERIC_BLE_NOTIFY_WAIT_MS` is removed

* 1.0.2
  - Improve README
  - Add an example flow file available from the editor UI

* 1.0.1
  - Fix an issue where custom characteristics cannot be listed on the Generic BLE config node dialog

* 1.0.0
  - Fix an issue where some devices cannot be discovered within a specific time window even after they can be connected
  - Fix an issue where the Scan Result select widget didn't show the same item as the stored device info
  - Update Scan Result option list whenever Local Name is resolved
  - Improve stability by fixing minor bugs

* 0.1.0
  - Initial Release (alpha)
  - `node-red` keyword is not yet added
