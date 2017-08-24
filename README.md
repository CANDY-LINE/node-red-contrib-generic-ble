node-red-contrib-generic-ble
===

A Node-RED node for providing access to generic BLE devices via GATT.

Supported operations are as follows:

- Read
- Write
- Write without Response
- Notify

Read and Write operations are performed asynchronously and they're stored into the separate queues (read queue and write queue). Each queue has up to 10 operation requests. The parameter can be modified by providing `GENERIC_BLE_MAX_REQUESTS`.

These are environmental variables for systemwidely configuring this node:

| Variable | Description |
|----------|-------------|
| `GENERIC_BLE_CONNECTION_TIMEOUT_MS`  | Connection Timeout in milliseconds. 5s by default |
| `GENERIC_BLE_CONCURRENT_CONNECTIONS` | Number of Concurrent BLE connections. 1 by default |
| `GENERIC_BLE_READ_WRITE_INTERVAL_MS` | Read/Write operation interval in milliseconds. 50ms by default |
| `GENERIC_BLE_NOTIFY_WAIT_MS`         | Default waiting time for listening notify events. 300 by default |
| `GENERIC_BLE_MAX_REQUESTS`           | The length of Read/Write operation queues. 10 by default |

You can easily get started by importing the example flow shown below.

# How to install

This will take approx. 3 minutes on Raspberry Pi 3.

## Node-RED users

Run the following commands:
```
cd ~/.node-red
sudo npm install --unsafe-perm node-red-contrib-generic-ble
```

Then restart Node-RED process.

When you have trouble with connecting your BLE devices, reset your HCI socket by the following command.

```
# STOP Node-RED first!!
sudo hciconfig hci0 reset
```
And restart Node-RED.

## CANDY RED users

Run the following commands:
```
cd $(npm -g root)/candy-red
sudo npm install --unsafe-perm node-red-contrib-generic-ble
```

Then restart `candy-red` service.

```
sudo systemctl restart candy-red
```
The above command performs `hciconfig hci0 reset` as well. So you don't have to run `hciconfig` command separately.

# Example Flow

You can import this flow on Node-RED UI. You need to change Generic BLE config node named `nRF5x` or add a new config node for your device.

```
[
    {
        "id": "12121a3f.3ee31e",
        "type": "tab",
        "label": "Generic BLE Example",
        "disabled": false,
        "info": "This flow shows BLE Read/Write example.\n"
    },
    {
        "id": "11b829f1.d5215e",
        "type": "Generic BLE in",
        "z": "12121a3f.3ee31e",
        "name": "",
        "genericBle": "95ea8a12.e7aa38",
        "useString": false,
        "notification": false,
        "x": 337.5,
        "y": 259.25,
        "wires": [
            [
                "486cfab5.aec02c",
                "f5a90326.7009a"
            ]
        ]
    },
    {
        "id": "64b63eaf.52e4a8",
        "type": "inject",
        "z": "12121a3f.3ee31e",
        "name": "Get Battery Level",
        "topic": "",
        "payload": "",
        "payloadType": "date",
        "repeat": "",
        "crontab": "",
        "once": false,
        "x": 223.5,
        "y": 129.25,
        "wires": [
            [
                "11b829f1.d5215e"
            ]
        ]
    },
    {
        "id": "486cfab5.aec02c",
        "type": "debug",
        "z": "12121a3f.3ee31e",
        "name": "",
        "active": false,
        "console": "false",
        "complete": "false",
        "x": 706.5,
        "y": 259.5,
        "wires": []
    },
    {
        "id": "3c6ec3aa.24cfbc",
        "type": "Generic BLE out",
        "z": "12121a3f.3ee31e",
        "name": "",
        "genericBle": "95ea8a12.e7aa38",
        "x": 576.5,
        "y": 489.5,
        "wires": []
    },
    {
        "id": "90562835.fb6488",
        "type": "inject",
        "z": "12121a3f.3ee31e",
        "name": "Write Some Data",
        "topic": "",
        "payload": "{\"2a00\":\"yayyay\"}",
        "payloadType": "json",
        "repeat": "",
        "crontab": "",
        "once": false,
        "x": 212.5,
        "y": 490.25,
        "wires": [
            [
                "3c6ec3aa.24cfbc"
            ]
        ]
    },
    {
        "id": "f5a90326.7009a",
        "type": "function",
        "z": "12121a3f.3ee31e",
        "name": "Extract Battery Level",
        "func": "var payload = msg.payload;\nvar buff = payload.characteristics['2a19'] || []\nmsg.payload = buff[0];\nreturn msg;",
        "outputs": 1,
        "noerr": 0,
        "x": 457.5,
        "y": 353.75,
        "wires": [
            [
                "33bc905d.f4a09"
            ]
        ]
    },
    {
        "id": "33bc905d.f4a09",
        "type": "debug",
        "z": "12121a3f.3ee31e",
        "name": "",
        "active": true,
        "console": "false",
        "complete": "false",
        "x": 704.5,
        "y": 353.5,
        "wires": []
    },
    {
        "id": "95ea8a12.e7aa38",
        "type": "Generic BLE",
        "z": "",
        "localName": "nRF5x",
        "address": "f9:00:99:99:99:99",
        "uuid": "f90099999999",
        "listeningPeriod": "1000",
        "characteristics": [
            {
                "uuid": "2a00",
                "name": "Device Name",
                "type": "org.bluetooth.characteristic.gap.device_name",
                "notifiable": false,
                "readable": true,
                "writable": true,
                "writeWithoutResponse": false
            },
            {
                "uuid": "2a01",
                "name": "Appearance",
                "type": "org.bluetooth.characteristic.gap.appearance",
                "notifiable": false,
                "readable": true,
                "writable": false,
                "writeWithoutResponse": false
            },
            {
                "uuid": "2a04",
                "name": "Peripheral Preferred Connection Parameters",
                "type": "org.bluetooth.characteristic.gap.peripheral_preferred_connection_parameters",
                "notifiable": false,
                "readable": true,
                "writable": false,
                "writeWithoutResponse": false
            },
            {
                "uuid": "2a05",
                "name": "Service Changed",
                "type": "org.bluetooth.characteristic.gatt.service_changed",
                "notifiable": false,
                "readable": false,
                "writable": false,
                "writeWithoutResponse": false
            },
            {
                "uuid": "2a19",
                "name": "Battery Level",
                "type": "org.bluetooth.characteristic.battery_level",
                "notifiable": true,
                "readable": true,
                "writable": false,
                "writeWithoutResponse": false
            }
        ]
    }
]
```

# Appendix

## How to build

```
# build
$ NODE_ENV=development npm run build
# package
$ NODE_ENV=development npm pack
```

## HCI Dump Debugging (Raspbian/Ubuntu/Debian)

```
sudo apt-get update
sudo apt-get install bluez-hcidump
```

then

```
sudo hcidump -t -x
```

## Enabling trace log

Set `GENERIC_BLE_TRACE=true` on starting Node-RED and you can find the precise log in `/var/log/syslog`.

# Revision History
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
