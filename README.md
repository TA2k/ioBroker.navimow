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
- Periodic HTTP status polling alongside MQTT
- MQTT location watchdog with controlled reconnect during active mowing
- Remote control: Start, Stop, Pause, Resume, Dock
- Automatic token refresh with MQTT reconnect

Periodic HTTP polling refreshes general status values (for example battery, status and vehicleState) to keep them up to date. Location data and mowing progress (`location.mowingPercentage`) are provided by MQTT. During active mowing, the adapter watches the MQTT location stream and performs a controlled MQTT reconnect if location updates stop arriving while HTTP still reports an active mower state.

## Sentry

This adapter uses Sentry libraries to automatically report exceptions and code errors to the developers. For more details and for information how to disable the error reporting see [Sentry-Plugin Documentation](https://github.com/ioBroker/plugin-sentry#plugin-sentry)! Sentry reporting is used starting with js-controller 3.0.

## Setup

1. Open the adapter settings in ioBroker Admin
2. Click **"Navimow Login öffnen"** to open the Navimow login page
3. Login with your Navimow account
4. After login the browser shows **"Seite nicht erreichbar"** - this is expected
5. Copy the complete URL from the browser address bar (contains `?code=XXXXX`)
6. Paste the URL into the **Authorization Code** field and save
7. The adapter exchanges the code for a token and starts automatically

The token is refreshed automatically. A re-login is only needed if the refresh token expires.

The **Update interval** setting defines the periodic HTTP status polling interval in minutes (minimum: 1 minute). MQTT stays active in parallel for real-time updates.

Setting the interval to `0` disables periodic polling and relies on MQTT alone. Because the broker only pushes the `state` channel while the mower is operating, the adapter still performs a single HTTP status poll whenever no MQTT status update has arrived for 15 minutes. Without that fallback, battery and `vehicleState` would keep their last values for hours while the mower is docked and charging.

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
| `{deviceId}.location`    | Real-time mower position and mowing progress (via MQTT)  |
| `{deviceId}.diagnostics` | MQTT location watchdog diagnostics                       |

### vehicleState

The `status.vehicleState` state contains the current mower state.

It is fed from the MQTT `state` channel as soon as that reports a change. The channel calls the field `state` and the HTTP API calls it `vehicleState`, but both use the same values, and the HTTP one answers from a server-side cache that can be one to two minutes behind — it has been seen reporting `isDocked` for a mower that was out mowing. Where the state channel has spoken within the last three minutes, its value stands and a poll landing in between does not overwrite it. While the mower is docked the channel falls quiet and the poll takes over again.

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

The `location` channel receives real-time position data and mowing progress (`mowingPercentage`) via MQTT while the mower is active. Coordinates are relative to the mowing area (in meters), not GPS. These values are not derived from periodic HTTP status polling.

| State                  | Description            |
| ---------------------- | ---------------------- |
| `location.postureX`    | Position X (m)         |
| `location.postureY`    | Position Y (m)         |
| `location.postureTheta`| Rotation angle (rad)   |
| `location.vehicleState`| Vehicle state code     |
| `location.time`        | Timestamp              |

`location.vehicleState` is a number, and its meaning is not documented — neither the Navimow SDK nor the openHAB binding knows a mapping. The adapter therefore does not translate it and passes it on as it arrives. Use `status.vehicleState` for the documented state.

The position data can be visualized as a mowing map using Grafana (e.g. with the Plotly or Geomap panel) or ioBroker.vis.

### Diagnostics

The `diagnostics` channel contains read-only values for the MQTT location watchdog.

| State                                | Description                                      |
| ------------------------------------ | ------------------------------------------------ |
| `diagnostics.lastLocationMessage`    | Timestamp of the last received MQTT location message |
| `diagnostics.locationMqttStale`      | `true` if the location stream is stale while the mower is active |
| `diagnostics.lastMqttRecovery`       | Timestamp of the last controlled MQTT recovery   |
| `diagnostics.lastLocationAgeSeconds` | Age of the last MQTT location message in seconds |

If HTTP polling reports an active mowing state but no MQTT `location` message is received for at least three minutes, the adapter marks the location stream as stale and reconnects MQTT. Recoveries are rate-limited to at most once every five minutes per device. Battery, status and `vehicleState` continue to be updated by periodic HTTP polling independently from this watchdog.

### Mowing Map

The adapter renders a live mowing map as a PNG image (base64 data URI) in the state `{deviceId}.map`. The map is automatically updated during mowing and cleared when a new mowing session starts.

A new session is recognised by the mowing progress reported with each location message: it starts over at zero for a new session, and picks up where it left off when the mower carries on after a charging break. The mower state cannot tell the two apart — a mower that docks halfway through to charge and then drives back out looks exactly like one starting a fresh session — so the map is cleared when the progress falls below the value last seen, and not on a state change. Should a mower not report a progress at all, the map falls back to being cleared when it leaves the dock for a mowing state; that fallback is switched off for good as soon as a progress has been seen once.

The progress is right but late: for about a minute after leaving the dock the mower still reports the one of the session before. The adapter therefore notes where the track stands when the mower leaves, and the positions driven until the progress catches up survive the reset instead of being cleared away with the session that ended — so a new session keeps its first minute. If the progress never answers, the start counts as a continuation after five minutes and the track is kept.

The track behind it is kept in `{deviceId}.mapTrack` as JSON, `{ "percentage": 42, "points": [[x, y], …] }`, with the positions in mower coordinates rounded to centimetres. It is written at most every 30 seconds while positions are coming in, and once more when the adapter stops, and it is read back on start — so after a restart the map shows the session so far instead of staying frozen on its last image until the mower moves again. The progress is stored with it because otherwise a restart could not tell a new session from a resumed one; a track written by an older version does not carry it and is therefore dropped once, on the first start after the update, so the map stays empty until the mower drives again. It is cleared together with the map when a new mowing session starts.

#### Map Frame

The frame is the rectangle of the garden, in mower coordinates, that the map image covers, and it is published in `{deviceId}.mapFrame`:

```json
{ "minX": -18, "maxX": 14, "minY": -3, "maxY": 29, "width": 800, "height": 800, "scale": 25 }
```

The image covers **exactly** the frame — its left edge is `minX`, its right edge `maxX`, its top edge `maxY`, its bottom edge `minY`, with no border around it and one scale for both axes. A world position therefore lands at `(x - minX) * scale` pixels from the left and `(maxY - y) * scale` pixels from the top. The image is at most 800 px on its longer edge; the shorter edge follows the shape of the frame.

The bounds are **metres in the mower's own coordinate system** — the same numbers as `{deviceId}.location.postureX` and `postureY`, not pixels of an image. The adapter widens the frame by two metres, snapped to whole metres, whenever the mower drives outside it, and never shrinks it again. It survives a restart and a new mowing session, so a position keeps its pixel from one render and one session to the next, which is what makes it possible to lay the map over a photo of the garden at all.

Because the frame never shrinks, a stray position far outside the garden would widen it for good. A position more than ten metres from the one before it is therefore not taken at face value: it is held back until the next message either confirms it — the mower really is somewhere else, for instance after leaving the dock — or contradicts it, in which case it is dropped. Should a frame still come out wrong, delete the `mapFrame` **and** `mapTrack` states of the device and restart the adapter; the frame is only ever built from the track, so both have to go.

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
<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->
### **WORK IN PROGRESS**

- (typhosj) Render a live mowing map as a PNG in `{deviceId}.map`, drawn in a fixed frame so the picture stays put while the mower is out (#7)
- (typhosj) Keep the mowing track in `{deviceId}.mapTrack`, so the map survives an adapter restart instead of freezing on its last image (#7)
- (typhosj) Decide a new mowing session by the mowing progress, so a charging break no longer throws away the track of a session that is still running (#23)
- (typhosj) Publish the mower state from the MQTT state channel instead of the lagging HTTP cache
- (typhosj) Refresh the status over HTTP when MQTT goes quiet in MQTT-only mode (#18)
- (TA2k) Retry the MQTT connection after a transient credential failure (#18)
- (TA2k) Keep the MQTT broker password and the refresh token out of the debug log
- (TA2k) Read the battery level from `capacityRemaining` again
- (typhosj) HTTP polling defaults to 5 minutes and can be switched off with 0; the admin UI checks the range
- (typhosj) Fix the findings of the ioBroker repository checker (#11)

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
