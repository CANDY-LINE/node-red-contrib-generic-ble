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
| `GENERIC_BLE_READ_WRITE_INTERVAL_MS` | Read/Write operation interval in milliseconds. 50 by default | `GENERIC_BLE_NOTIFY_WAIT_MS`         | Default waiting time for listening notify events. 300 by default |
| `GENERIC_BLE_MAX_REQUESTS`           | The length of Read/Write operation queues. 10 by default |

**ALPHA RELEASE** : not yet available in [flows.nodered.org](https://flows.nodered.org)

# How to install

This will take approx. 3 minutes on Raspberry Pi 3.

## Node-RED

```
cd ~/.node-red
sudo npm install --unsafe-perm node-red-contrib-generic-ble
```

Then restart Node-RED process.

When you have trouble with connecting your BLE devices, reset your HCI socket by the following command.

```
# stop Node-RED first then run the following command:
sudo hciconfig hci0 reset
```
And restart Node-RED.

## CANDY RED

```
cd /opt/candy-red/.node-red
sudo npm install --unsafe-perm node-red-contrib-generic-ble
```

Then restart `candy-red` service.

```
sudo systemctl restart candy-red
```
The above command performs `hciconfig hci0 reset` as well. So you don't have to run `hciconfig` command separately.

# HCI Dump Debugging (Raspbian/Ubuntu/Debian)

```
sudo apt-get update
sudo apt-get install bluez-hcidump
```

then

```
sudo hcidump -t -x
```

# Enabling trace log

Set `GENERIC_BLE_TRACE=true` on starting Node-RED and you can find the precise log in `/var/log/syslog`.

# Revision History

* 0.1.0
  - Initial Release (alpha)
  - `node-red` keyword is not yet added
