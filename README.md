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

### Mowing Map

The adapter renders a live mowing map as a PNG image (base64 data URI) in the state `{deviceId}.map`. The map is automatically updated during mowing and cleared when a new mowing session starts.

#### VIS Position Script

To position a mower icon on a static background image (e.g. a screenshot of your garden from the Navimow app) in ioBroker VIS, use the following JavaScript:

```javascript
// === Configuration ===
const deviceId = 'NAVIMOW'; // Your device ID
const prefix = 'navimow.0.' + deviceId;

// Garden bounds (from Navimow app coordinates, adjust to your garden)
const gartenXMin = 0.9;
const gartenXMax = 18.5;
const gartenYMin = -3.25;
const gartenYMax = 14;

// Image size in VIS (px)
const bildX = 580;
const bildY = 573;

// Image position offset in VIS (px)
const bildPosX = 30;
const bildPosY = 30;

// Border offsets if lawn doesn't fill entire image (px)
const randLinks = 18;
const randRechts = 16;
const randOben = 14;
const randUnten = 16;

// Robot icon size (px)
const robX = 32;
const robY = 26;

// Datapoints for VIS widget position (create manually)
const dpPosX = '0_userdata.0.Navimow.Pos_X';
const dpPosY = '0_userdata.0.Navimow.Pos_Y';

// === Calculation ===
const effX = bildX - randLinks - randRechts;
const effY = bildY - randOben - randUnten;

on({ id: [prefix + '.location.postureX', prefix + '.location.postureY'], change: 'any' }, () => {
  const posX = getState(prefix + '.location.postureX').val;
  const posY = getState(prefix + '.location.postureY').val;
  if (posX == null || posY == null) return;

  const pctX = (posX - gartenXMin) / (gartenXMax - gartenXMin);
  const pctY = (posY - gartenYMin) / (gartenYMax - gartenYMin);

  const pixelX = Math.round(effX * pctX + randLinks + bildPosX - robX / 2);
  const pixelY = Math.round(bildY - randUnten - bildPosY - effY * pctY - robY / 2);

  setState(dpPosX, pixelX, true);
  setState(dpPosY, pixelY, true);
});
```

**Setup:**

1. Take a screenshot of your garden map from the Navimow app
2. Use it as background image in a VIS view
3. Adjust the garden bounds (`gartenXMin/Max`, `gartenYMin/Max`) to match your garden coordinates (visible in the location states)
4. Adjust image size and border offsets to match your VIS layout
5. Create the datapoints `Pos_X` and `Pos_Y` under `0_userdata.0`
6. Add a VIS widget with a mower icon and bind its CSS `left`/`top` to the datapoints

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
### 1.0.2 (2026-04-04)

- (TA2k) Add MQTT location topic with real-time position tracking
- (TA2k) Generic MQTT topic handling via wildcard subscription

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
