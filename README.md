node-red-contrib-generic-ble
===

A Node-RED node for providing access to generic BLE devices via GATT.

**ALPHA RELEASE** : not yet available in [flows.nodered.org](https://flows.nodered.org)

# How to install

```
cd ~/.node-red
npm install node-red-contrib-generic-ble
```

# HCI Dump Debugging

```
sudo apt-get update
sudo apt-get install bluez-hcidump
```

then

```
sudo hcidump -t -x
```

# Enabling trace log

Set `GENERIC_BLE_TRACE=true` on starting Node-RED.

# Known Issues

Connecting to peripherals keeps failing in some cases after selecting a BLE peripheral from the scan result select box in the Generic BLE node configuration dialog. If you get stuck in that case, stop Node-RED and run `sudo hciconfig hci0 reset` (replace `hci0` with a proper interface if necessary) then start Node-RED again.

# Revision History

* 0.1.0
  - Initial Release (alpha)
  - `node-red` keyword is not yet added
