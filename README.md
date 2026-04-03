![Logo](admin/navimow.png)

# ioBroker.navimow

[![NPM version](https://img.shields.io/npm/v/iobroker.navimow.svg)](https://www.npmjs.com/package/iobroker.navimow)
[![Downloads](https://img.shields.io/npm/dm/iobroker.navimow.svg)](https://www.npmjs.com/package/iobroker.navimow)
![Number of Installations](https://iobroker.live/badges/navimow-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/navimow-stable.svg)
[![GitHub license](https://img.shields.io/github/license/TA2k/ioBroker.navimow)](https://github.com/TA2k/ioBroker.navimow/blob/main/LICENSE)
[![GitHub issues](https://img.shields.io/github/issues/TA2k/ioBroker.navimow)](https://github.com/TA2k/ioBroker.navimow/issues)
[![GitHub last commit](https://img.shields.io/github/last-commit/TA2k/ioBroker.navimow)](https://github.com/TA2k/ioBroker.navimow/commits/main)
[![node](https://img.shields.io/node/v/iobroker.navimow)](https://www.npmjs.com/package/iobroker.navimow)

[![NPM](https://nodei.co/npm/iobroker.navimow.png?downloads=true)](https://nodei.co/npm/iobroker.navimow/)

**Tests:** ![Test and Release](https://github.com/TA2k/ioBroker.navimow/workflows/Test%20and%20Release/badge.svg)

## Navimow Adapter for ioBroker

ioBroker adapter for Segway Navimow robotic mowers. Uses the official [Navimow SDK](https://github.com/segwaynavimow/navimow-sdk) REST API and MQTT for real-time updates.

## Features

- OAuth2 login via Navimow account
- Real-time status updates via MQTT (WebSocket Secure)
- HTTP polling as fallback
- Remote control: Start, Stop, Pause, Resume, Dock
- Automatic token refresh with MQTT reconnect

## Setup

1. Open the adapter settings in ioBroker Admin
2. Click **"Navimow Login öffnen"** to open the Navimow login page
3. Login with your Navimow account
4. After login the browser shows **"Seite nicht erreichbar"** - this is expected
5. Copy the complete URL from the browser address bar (contains `?code=XXXXX`)
6. Paste the URL into the **Authorization Code** field and save
7. The adapter exchanges the code for a token and starts automatically

The token is refreshed automatically. A re-login is only needed if the refresh token expires.

## States

For each mower device the following channels are created:

| Channel                  | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| `{deviceId}.general`     | Device info (name, model, serial number, firmware)       |
| `{deviceId}.status`      | Current status (vehicleState, battery, position, signal) |
| `{deviceId}.status.json` | Raw JSON of the last status update                       |
| `{deviceId}.events`      | MQTT events                                              |
| `{deviceId}.attributes`  | MQTT device attributes                                   |
| `{deviceId}.remote`      | Remote control buttons                                   |
| `{deviceId}.location`    | Real-time mower position (via MQTT)                      |

### vehicleState

The `status.vehicleState` state contains the current mower state.

**To check if the mower is currently mowing, check for `isRunning`:**

```javascript
on({ id: 'navimow.0.DEVICE_ID.status.vehicleState', change: 'any' }, (obj) => {
  if (obj.state.val === 'isRunning') {
    log('Mower is mowing!');
  }
});
```

| Value               | Description         |
| ------------------- | ------------------- |
| `isRunning`         | Mowing              |
| `isDocked`          | Docked              |
| `isIdle`            | Idle                |
| `isPaused`          | Paused              |
| `isDocking`         | Returning to Dock   |
| `isMapping`         | Mapping             |
| `isLifted`          | Lifted (Error)      |
| `Error`             | Error               |
| `inSoftwareUpdate`  | Software Update     |
| `Self-Checking`     | Self-Checking       |
| `Offline`           | Offline             |

### Remote Controls

| State            | Description                     |
| ---------------- | ------------------------------- |
| `remote.Refresh` | Trigger a manual status refresh |
| `remote.start`   | Start mowing                    |
| `remote.stop`    | Stop mowing                     |
| `remote.pause`   | Pause mowing                    |
| `remote.resume`  | Resume mowing                   |
| `remote.dock`    | Return to dock                  |

Remote states reflect the current device state with `ack:true`. For example, when the mower is mowing, `remote.start` is `true`.

### Location

The `location` channel receives real-time position data via MQTT while the mower is active. Coordinates are relative to the mowing area (in meters), not GPS.

| State                  | Description            |
| ---------------------- | ---------------------- |
| `location.postureX`    | Position X (m)         |
| `location.postureY`    | Position Y (m)         |
| `location.postureTheta`| Rotation angle (rad)   |
| `location.vehicleState`| Vehicle state code     |
| `location.time`        | Timestamp              |

The position data can be visualized as a mowing map using Grafana (e.g. with the Plotly or Geomap panel) or ioBroker.vis.

## API

Based on the [Navimow SDK](https://github.com/segwaynavimow/navimow-sdk) and [Navimow HA Integration](https://github.com/segwaynavimow/NavimowHA).

| Endpoint                                   | Purpose                                    |
| ------------------------------------------ | ------------------------------------------ |
| `POST /openapi/oauth/getAccessToken`       | OAuth2 token exchange and refresh          |
| `GET /openapi/smarthome/authList`          | Discover devices                           |
| `POST /openapi/smarthome/getVehicleStatus` | Get device status                          |
| `POST /openapi/smarthome/sendCommands`     | Send commands (Google Smart Home protocol) |
| `GET /openapi/mqtt/userInfo/get/v2`        | Get MQTT connection credentials            |

## Changelog

### 1.0.1 (2026-03-15)

- (TA2k) initial release

## License

MIT License

Copyright (c) 2026 TA2k <tombox2020@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
