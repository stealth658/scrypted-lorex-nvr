# Lorex/Dahua NVR Plugin for Scrypted

Add a Lorex or Dahua NVR once and get every camera on it, with correct per-channel snapshots and a single motion event connection for the whole NVR.

## What it does

- **One NVR, all cameras.** Reads the NVR's encode settings to find which channels have cameras, and names each camera from the NVR's channel title.
- **Correct snapshots.** Requests `snapshot.cgi?channel=N` per camera. Lorex numbers snapshot channels from 0 (camera 1 is `channel=0`); this is the default and can be flipped in Advanced settings.
- **One motion connection.** Opens a single `eventManager.cgi` stream for the whole NVR and routes each event to the right camera by its index (index 0 is camera 1). Reconnects automatically if the NVR drops it.
- **Login handled up front.** Sends credentials on the first request and switches to Digest if the NVR asks. Some Lorex firmware accepts the event stream without a login and then sends nothing, so waiting to be challenged never works.

Video uses `rtsp://NVR:554/cam/realmonitor?channel=N&subtype=0|1`, with channel numbered from 1.

## Install

You need Node.js on any computer on the same network as Scrypted.

```
cd scrypted-lorex-nvr
npm install
npx scrypted login 192.168.68.80
npm run build
npm run scrypted-deploy 192.168.68.80
```

`scrypted login` asks for your Scrypted admin username and password once. The plugin then appears under Plugins as **Lorex/Dahua NVR**.

## Set up

1. Open the **Lorex/Dahua NVR** plugin and click **Add Device**.
2. Enter the NVR's IP, admin username and password. It checks the login before adding.
3. The NVR device appears, finds its cameras, and creates one camera per channel.
4. Remove or disable the old Amcrest plugin cameras so HomeKit doesn't get duplicates, and turn off homebridge-dahua-alerts so it isn't holding its own event connection.
5. Pair each new camera with HomeKit as usual.

## Settings on the NVR device

| Setting | What it's for |
|---|---|
| Ignore Channels | Channel numbers to skip, e.g. `6` |
| Rediscover Cameras | Re-read the NVR after adding a camera or changing stream settings |
| Event Connection / Last Event | Live status of the motion connection |
| Motion Failsafe (seconds) | Clears motion if the NVR never sends a Stop (default 120) |
| Extra Motion Event Codes | Treat other event codes as motion, if your NVR uses Lorex-specific ones |
| Snapshot / Motion Event Numbering | Flip to 1-based if a firmware numbers differently |
| Debug Events | Log every raw event from the NVR |

## Troubleshooting motion

Turn on **Debug Events** on the NVR device and walk in front of a camera.

- **Events appear but the wrong camera triggers:** flip **Motion Event Numbering**.
- **Events appear with a code that isn't motion here:** add it to **Extra Motion Event Codes**.
- **Nothing appears at all:** the NVR isn't sending events. Check motion detection is enabled for that channel on the NVR. Software motion detection (OpenCV Motion Sensor extension) still works on these cameras as a fallback.

## Motion codes handled

`VideoMotion` (Start/Stop), plus `SmartMotionHuman`, `SmartMotionVehicle`, `CrossLineDetection`, `CrossRegionDetection` and `VideoMotionInfo`, which clear 20 seconds after their last pulse.
