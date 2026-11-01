import sdk, {
    Camera,
    DeviceCreator,
    DeviceCreatorSettings,
    DeviceProvider,
    MediaObject,
    MediaStreamUrl,
    MotionSensor,
    RequestMediaStreamOptions,
    RequestPictureOptions,
    ResponseMediaStreamOptions,
    ResponsePictureOptions,
    ScryptedDeviceBase,
    ScryptedDeviceType,
    ScryptedInterface,
    ScryptedMimeTypes,
    ScryptedNativeId,
    Setting,
    Settings,
    SettingValue,
    VideoCamera,
} from '@scrypted/sdk';
import crypto from 'crypto';
import { IncomingMessage } from 'http';
import { ChannelInfo, DahuaClient, DahuaEvent, DahuaEventParser, parseChannels } from './dahua-client';

const { deviceManager } = sdk;

// Event codes that mean "motion" for a channel. VideoMotion has real Start/Stop pairs.
// The smart detections tend to be one-shot, so they get a short auto-clear.
const MOTION_CODES = new Set(['VideoMotion', 'SmartMotionHuman', 'SmartMotionVehicle', 'CrossLineDetection', 'CrossRegionDetection', 'VideoMotionInfo']);
const PULSE_CLEAR_MS = 20000;
const RECONNECT_MS = 10000;
const IDLE_RECONNECT_MS = 10 * 60 * 1000;

function channelNativeId(nvrNativeId: string, channel: number) {
    return `${nvrNativeId}-ch${channel}`;
}

export class ChannelCamera extends ScryptedDeviceBase implements VideoCamera, Camera, MotionSensor, Settings {
    private motionTimer?: NodeJS.Timeout;

    constructor(nativeId: string, public nvr: NvrDevice, public channel: number) {
        super(nativeId);
        this.motionDetected = false;
    }

    get channelDetails(): ChannelInfo | undefined {
        return this.nvr.channelInfo(this.channel);
    }

    async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        let streams = this.channelDetails?.streams;
        if (!streams?.length) {
            // discovery hasn't run or failed: fall back to the standard main + sub stream.
            streams = [{ subtype: 0 }, { subtype: 1 }];
        }
        return streams.map(s => {
            const ret: ResponseMediaStreamOptions = {
                id: `channel${s.subtype}`,
                name: s.subtype === 0 ? 'Main Stream' : `Substream ${s.subtype}`,
                container: 'rtsp',
                tool: 'scrypted',
                video: {
                    codec: s.codec,
                    width: s.width,
                    height: s.height,
                    fps: s.fps,
                    bitrate: s.bitrate,
                },
            };
            if (s.audioCodec)
                ret.audio = { codec: s.audioCodec };
            else
                ret.audio = null;
            return ret;
        });
    }

    async getVideoStream(options?: RequestMediaStreamOptions): Promise<MediaObject> {
        const vsos = await this.getVideoStreamOptions();
        const vso = vsos.find(v => v.id === options?.id) || vsos[0];
        const subtype = parseInt(vso.id.substring('channel'.length)) || 0;
        const url = this.nvr.rtspUrl(this.channel, subtype);
        const ret: MediaStreamUrl = {
            container: 'rtsp',
            url,
            mediaStreamOptions: vso,
        };
        return this.createMediaObject(ret, ScryptedMimeTypes.MediaStreamUrl);
    }

    async takePicture(options?: RequestPictureOptions): Promise<MediaObject> {
        const jpeg = await this.nvr.snapshot(this.channel, options?.timeout);
        return this.createMediaObject(jpeg, 'image/jpeg');
    }

    async getPictureOptions(): Promise<ResponsePictureOptions[]> {
        return [];
    }

    setMotion(on: boolean, clearAfterMs?: number) {
        clearTimeout(this.motionTimer);
        this.motionTimer = undefined;
        if (this.motionDetected !== on)
            this.motionDetected = on;
        if (on && clearAfterMs) {
            this.motionTimer = setTimeout(() => {
                this.console.log('motion auto-cleared (no stop event received)');
                this.motionDetected = false;
            }, clearAfterMs);
        }
    }

    async getSettings(): Promise<Setting[]> {
        const info = this.channelDetails;
        return [
            {
                key: 'channel',
                title: 'NVR Channel',
                description: 'The channel this camera uses on the NVR. Video uses this number; snapshots and motion events use it minus 1.',
                value: this.channel.toString(),
                readonly: true,
            },
            {
                key: 'nvrName',
                title: 'Name on NVR',
                value: info?.name || '(unknown)',
                readonly: true,
            },
        ];
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
    }
}

export class NvrDevice extends ScryptedDeviceBase implements DeviceProvider, Settings {
    private cameras = new Map<number, ChannelCamera>();
    private channels: ChannelInfo[] = [];
    private client?: DahuaClient;
    private eventResponse?: IncomingMessage;
    private reconnectTimer?: NodeJS.Timeout;
    private idleTimer?: NodeJS.Timeout;
    private released = false;
    private eventStatus = 'Not connected';
    private lastEvent = 'None yet';
    private generation = 0;

    constructor(nativeId: string) {
        super(nativeId);
        try {
            this.channels = JSON.parse(this.storage.getItem('channels') || '[]');
        }
        catch (e) {
            this.channels = [];
        }
        process.nextTick(() => this.start());
    }

    private get configured() {
        return !!this.storage.getItem('ip') && !!this.storage.getItem('username');
    }

    getClient() {
        if (!this.client) {
            this.client = new DahuaClient({
                host: this.storage.getItem('ip')!,
                httpPort: parseInt(this.storage.getItem('httpPort') || '') || 80,
                username: this.storage.getItem('username') || '',
                password: this.storage.getItem('password') || '',
            }, this.console);
        }
        return this.client;
    }

    channelInfo(channel: number) {
        return this.channels.find(c => c.channel === channel);
    }

    private get snapshotBase() {
        return this.storage.getItem('snapshotNumbering') === '1-based' ? 1 : 0;
    }

    private get eventBase() {
        return this.storage.getItem('eventNumbering') === '1-based' ? 1 : 0;
    }

    rtspUrl(channel: number, subtype: number) {
        const ip = this.storage.getItem('ip');
        const port = parseInt(this.storage.getItem('rtspPort') || '') || 554;
        const user = encodeURIComponent(this.storage.getItem('username') || '');
        const pass = encodeURIComponent(this.storage.getItem('password') || '');
        // keep the trailing colon for blank passwords, ffmpeg needs it.
        return `rtsp://${user}:${pass}@${ip}:${port}/cam/realmonitor?channel=${channel}&subtype=${subtype}`;
    }

    async snapshot(channel: number, timeout?: number) {
        return this.getClient().snapshot(channel - 1 + this.snapshotBase, timeout);
    }

    private async start() {
        if (!this.configured) {
            this.console.warn('NVR is not configured yet. Set the IP address, username and password in settings.');
            return;
        }
        try {
            await this.discover();
        }
        catch (e) {
            this.console.error('camera discovery failed, using the last known channel list.', (e as Error).message);
            await this.reportChannels(false);
        }
        this.connectEvents();
    }

    private ignoredChannels(): Set<number> {
        const raw = this.storage.getItem('ignoredChannels') || '';
        return new Set(raw.split(/[\s,]+/).map(s => parseInt(s)).filter(n => !isNaN(n)));
    }

    async discover() {
        const client = this.getClient();
        this.console.log('discovering cameras on the NVR...');

        let maxExtra = 1;
        try {
            maxExtra = parseInt(await client.magicBox('getProductDefinition', '&name=MaxExtraStream')) || 1;
        }
        catch (e) {
            this.console.warn('MaxExtraStream not reported, assuming 1 substream.');
        }

        const encode = await client.getConfig('Encode');
        let titles = new Map<string, string>();
        try {
            titles = await client.getConfig('ChannelTitle');
        }
        catch (e) {
            this.console.warn('could not read channel names, using defaults.', (e as Error).message);
        }

        const found = parseChannels(encode, titles, maxExtra);
        if (!found.length)
            throw new Error('the NVR reported no channels with video. Check that the user is an admin.');

        this.channels = found;
        this.storage.setItem('channels', JSON.stringify(found));
        this.console.log('found channels:', found.map(c => `${c.channel} (${c.name || 'unnamed'})`).join(', '));

        try {
            const info = {
                manufacturer: await client.magicBox('getVendor').catch(() => undefined),
                model: await client.magicBox('getDeviceType').catch(() => undefined),
                serialNumber: await client.magicBox('getSerialNo').catch(() => undefined),
                firmware: await client.magicBox('getSoftwareVersion').catch(() => undefined),
            };
            this.storage.setItem('deviceInfo', JSON.stringify(info));
        }
        catch (e) {
        }

        await this.reportChannels(true);
    }

    private async reportChannels(rename: boolean) {
        const ignored = this.ignoredChannels();
        const known = new Set(deviceManager.getNativeIds());
        let info: any = {};
        try {
            info = JSON.parse(this.storage.getItem('deviceInfo') || '{}');
        }
        catch (e) {
        }
        for (const c of this.channels) {
            if (ignored.has(c.channel))
                continue;
            const nativeId = channelNativeId(this.nativeId!, c.channel);
            // only name the device when first created, so renames in Scrypted stick.
            if (known.has(nativeId) && !rename)
                continue;
            const existing = known.has(nativeId) ? deviceManager.getDeviceState(nativeId) : undefined;
            await deviceManager.onDeviceDiscovered({
                providerNativeId: this.nativeId,
                nativeId,
                name: existing?.name || c.name || `Channel ${c.channel}`,
                type: ScryptedDeviceType.Camera,
                interfaces: [
                    ScryptedInterface.VideoCamera,
                    ScryptedInterface.Camera,
                    ScryptedInterface.MotionSensor,
                    ScryptedInterface.Settings,
                ],
                info: {
                    manufacturer: info.manufacturer || 'Lorex/Dahua',
                    model: `${info.model || 'NVR'} channel ${c.channel}`,
                    serialNumber: info.serialNumber ? `${info.serialNumber}-${c.channel}` : undefined,
                    firmware: info.firmware,
                    ip: this.storage.getItem('ip') || undefined,
                    managementUrl: `http://${this.storage.getItem('ip')}`,
                },
            });
        }
    }

    // ---------- events: one connection for the whole NVR ----------

    private stopEvents() {
        this.generation++;
        clearTimeout(this.reconnectTimer);
        clearTimeout(this.idleTimer);
        this.reconnectTimer = undefined;
        this.idleTimer = undefined;
        this.eventResponse?.destroy();
        this.eventResponse = undefined;
    }

    private scheduleReconnect(reason: string) {
        if (this.released)
            return;
        this.stopEvents();
        this.eventStatus = `Reconnecting (${reason})`;
        this.console.warn(`event connection ${reason}, reconnecting in ${RECONNECT_MS / 1000}s.`);
        // clear any motion that would otherwise be stuck on while disconnected.
        for (const cam of this.cameras.values())
            cam.setMotion(false);
        this.reconnectTimer = setTimeout(() => this.connectEvents(), RECONNECT_MS);
    }

    private resetIdle() {
        clearTimeout(this.idleTimer);
        // some firmware ignores the heartbeat option, so a quiet period is normal.
        // reconnecting after a long silence protects against half-dead sockets.
        this.idleTimer = setTimeout(() => this.scheduleReconnect('was idle for 10 minutes'), IDLE_RECONNECT_MS);
    }

    private async connectEvents() {
        if (this.released || !this.configured)
            return;
        this.stopEvents();
        const generation = this.generation;
        const path = '/cgi-bin/eventManager.cgi?action=attach&codes=[All]&heartbeat=30';
        this.eventStatus = 'Connecting';
        let res: IncomingMessage;
        try {
            // no read timeout on the long lived stream; the idle timer handles dead sockets.
            res = await this.getClient().openAuthenticated(path, 0);
        }
        catch (e) {
            if (generation === this.generation)
                this.scheduleReconnect(`failed: ${(e as Error).message}`);
            return;
        }
        if (generation !== this.generation) {
            res.destroy();
            return;
        }
        if (res.statusCode !== 200) {
            res.resume();
            this.scheduleReconnect(`returned HTTP ${res.statusCode}`);
            return;
        }

        this.eventResponse = res;
        res.socket?.setKeepAlive(true, 30000);
        this.eventStatus = `Connected since ${new Date().toLocaleString()}`;
        this.console.log('event connection open (one connection for all channels).');
        this.resetIdle();

        const parser = new DahuaEventParser();
        const debug = this.storage.getItem('debug') === 'true';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
            if (generation !== this.generation)
                return;
            this.resetIdle();
            if (debug)
                this.console.log('raw event data:\n' + chunk);
            for (const e of parser.push(chunk))
                this.handleEvent(e);
        });
        res.on('end', () => {
            if (generation === this.generation)
                this.scheduleReconnect('was closed by the NVR');
        });
        res.on('error', (e) => {
            if (generation === this.generation)
                this.scheduleReconnect(`error: ${e.message}`);
        });
    }

    private extraMotionCodes(): Set<string> {
        const raw = this.storage.getItem('extraMotionCodes') || '';
        return new Set(raw.split(/[\s,]+/).filter(s => !!s));
    }

    handleEvent(e: DahuaEvent) {
        if (e.code === 'Heartbeat')
            return;
        const channel = e.index + 1 - this.eventBase;
        this.lastEvent = `${new Date().toLocaleTimeString()}: ${e.code} ${e.action} (channel ${channel})`;
        const isMotion = MOTION_CODES.has(e.code) || this.extraMotionCodes().has(e.code);
        if (!isMotion) {
            if (this.storage.getItem('debug') === 'true')
                this.console.log('ignoring non-motion event', e.raw);
            return;
        }

        const cam = this.getCamera(channel);
        if (!cam) {
            this.console.log(`motion on channel ${channel}, which has no camera in Scrypted (ignored or undiscovered).`);
            return;
        }

        const action = e.action.toLowerCase();
        const failsafeMs = (parseInt(this.storage.getItem('motionFailsafe') || '') || 120) * 1000;
        if (e.code === 'VideoMotion') {
            if (action === 'start')
                cam.setMotion(true, failsafeMs);
            else if (action === 'stop')
                cam.setMotion(false);
        }
        else if (action === 'start' || action === 'pulse' || action === 'state') {
            cam.setMotion(true, PULSE_CLEAR_MS);
        }
        else if (action === 'stop' && e.code !== 'VideoMotionInfo') {
            cam.setMotion(false);
        }
    }

    // ---------- DeviceProvider ----------

    private getCamera(channel: number) {
        if (this.ignoredChannels().has(channel))
            return;
        let cam = this.cameras.get(channel);
        if (!cam) {
            const nativeId = channelNativeId(this.nativeId!, channel);
            if (!deviceManager.getNativeIds().includes(nativeId))
                return;
            cam = new ChannelCamera(nativeId, this, channel);
            this.cameras.set(channel, cam);
        }
        return cam;
    }

    async getDevice(nativeId: ScryptedNativeId): Promise<any> {
        const m = /-ch(\d+)$/.exec(nativeId || '');
        if (!m)
            return;
        const channel = parseInt(m[1]);
        let cam = this.cameras.get(channel);
        if (!cam) {
            cam = new ChannelCamera(nativeId!, this, channel);
            this.cameras.set(channel, cam);
        }
        return cam;
    }

    async releaseDevice(id: string, nativeId: ScryptedNativeId): Promise<void> {
        const m = /-ch(\d+)$/.exec(nativeId || '');
        if (m)
            this.cameras.delete(parseInt(m[1]));
    }

    release() {
        this.released = true;
        this.stopEvents();
    }

    // ---------- Settings ----------

    async getSettings(): Promise<Setting[]> {
        return [
            { group: 'Connection', key: 'ip', title: 'NVR IP Address', placeholder: '192.168.1.100', value: this.storage.getItem('ip') },
            { group: 'Connection', key: 'username', title: 'Username', value: this.storage.getItem('username') },
            { group: 'Connection', key: 'password', title: 'Password', type: 'password', value: this.storage.getItem('password') },
            { group: 'Connection', key: 'httpPort', title: 'HTTP Port', placeholder: '80', value: this.storage.getItem('httpPort') },
            { group: 'Connection', key: 'rtspPort', title: 'RTSP Port', placeholder: '554', value: this.storage.getItem('rtspPort') },
            {
                group: 'Cameras', key: 'channelList', title: 'Cameras Found', readonly: true,
                value: this.channels.map(c => `${c.channel}: ${c.name || 'unnamed'}`).join(', ') || 'None yet',
            },
            {
                group: 'Cameras', key: 'ignoredChannels', title: 'Ignore Channels',
                description: 'Comma separated channel numbers to skip, e.g. 6. Delete an already added camera from Scrypted separately.',
                value: this.storage.getItem('ignoredChannels'),
            },
            {
                group: 'Cameras', key: 'rediscover', title: 'Rediscover Cameras', type: 'button',
                description: 'Ask the NVR for its cameras again, add any new ones and refresh stream details.',
            },
            { group: 'Motion', key: 'eventStatus', title: 'Event Connection', readonly: true, value: this.eventStatus },
            { group: 'Motion', key: 'lastEvent', title: 'Last Event', readonly: true, value: this.lastEvent },
            {
                group: 'Motion', key: 'motionFailsafe', title: 'Motion Failsafe (seconds)', type: 'number',
                description: 'Clear motion if the NVR never sends a Stop event.',
                placeholder: '120', value: this.storage.getItem('motionFailsafe'),
            },
            {
                group: 'Motion', key: 'extraMotionCodes', title: 'Extra Motion Event Codes',
                description: 'Comma separated event codes to also treat as motion. Turn on Debug Events to see which codes your NVR sends.',
                value: this.storage.getItem('extraMotionCodes'),
            },
            {
                group: 'Advanced', key: 'snapshotNumbering', title: 'Snapshot Channel Numbering',
                description: 'Most Lorex/Dahua NVRs number snapshot channels from 0 (camera 1 = channel=0).',
                choices: ['0-based', '1-based'], value: this.storage.getItem('snapshotNumbering') || '0-based',
            },
            {
                group: 'Advanced', key: 'eventNumbering', title: 'Motion Event Numbering',
                description: 'Dahua motion events normally number channels from 0 (index=0 is camera 1).',
                choices: ['0-based', '1-based'], value: this.storage.getItem('eventNumbering') || '0-based',
            },
            {
                group: 'Advanced', key: 'debug', title: 'Debug Events', type: 'boolean',
                description: 'Log every raw event from the NVR. Noisy; turn off when done.',
                value: this.storage.getItem('debug') === 'true',
            },
        ];
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        if (key === 'rediscover') {
            this.discover().catch(e => this.console.error('rediscover failed', (e as Error).message));
            return;
        }
        this.storage.setItem(key, value?.toString() ?? '');
        if (['ip', 'username', 'password', 'httpPort'].includes(key)) {
            this.client = undefined;
            this.start();
        }
        else if (key === 'debug') {
            this.connectEvents();
        }
        this.onDeviceEvent(ScryptedInterface.Settings, undefined);
    }
}

export class LorexNvrPlugin extends ScryptedDeviceBase implements DeviceProvider, DeviceCreator {
    private nvrs = new Map<string, NvrDevice>();

    constructor(nativeId?: string) {
        super(nativeId);
        this.systemDevice = {
            deviceCreator: 'Lorex/Dahua NVR',
        };
    }

    async getCreateDeviceSettings(): Promise<Setting[]> {
        return [
            { key: 'name', title: 'Name', placeholder: 'Lorex NVR' },
            { key: 'ip', title: 'NVR IP Address', placeholder: '192.168.1.100' },
            { key: 'username', title: 'Username', placeholder: 'admin' },
            { key: 'password', title: 'Password', type: 'password' },
            { key: 'httpPort', title: 'HTTP Port', placeholder: '80' },
            { key: 'rtspPort', title: 'RTSP Port', placeholder: '554' },
            {
                key: 'skipValidate', title: 'Skip Validation', type: 'boolean',
                description: 'Add the NVR without first checking the login.',
            },
        ];
    }

    async createDevice(settings: DeviceCreatorSettings): Promise<string> {
        const ip = settings.ip?.toString().trim();
        const username = settings.username?.toString() || 'admin';
        const password = settings.password?.toString() || '';
        if (!ip)
            throw new Error('Enter the NVR IP address.');

        if (settings.skipValidate?.toString() !== 'true') {
            const client = new DahuaClient({
                host: ip,
                httpPort: parseInt(settings.httpPort?.toString() || '') || 80,
                username,
                password,
            }, this.console);
            // throws with a readable message on bad login or unreachable NVR.
            const model = await client.magicBox('getDeviceType');
            this.console.log('connected to NVR model', model);
        }

        const nativeId = 'nvr-' + crypto.randomBytes(4).toString('hex');
        await deviceManager.onDeviceDiscovered({
            nativeId,
            name: settings.name?.toString() || 'Lorex NVR',
            type: ScryptedDeviceType.DeviceProvider,
            interfaces: [ScryptedInterface.DeviceProvider, ScryptedInterface.Settings],
        });

        const storage = deviceManager.getDeviceStorage(nativeId);
        storage.setItem('ip', ip);
        storage.setItem('username', username);
        storage.setItem('password', password);
        if (settings.httpPort)
            storage.setItem('httpPort', settings.httpPort.toString());
        if (settings.rtspPort)
            storage.setItem('rtspPort', settings.rtspPort.toString());

        // restart the NVR instance so it picks up the stored settings and discovers cameras.
        const existing = this.nvrs.get(nativeId);
        existing?.release();
        this.nvrs.delete(nativeId);
        await this.getDevice(nativeId);
        return nativeId;
    }

    async getDevice(nativeId: ScryptedNativeId): Promise<any> {
        if (!nativeId)
            return;
        let nvr = this.nvrs.get(nativeId);
        if (!nvr) {
            nvr = new NvrDevice(nativeId);
            this.nvrs.set(nativeId, nvr);
        }
        return nvr;
    }

    async releaseDevice(id: string, nativeId: ScryptedNativeId): Promise<void> {
        if (!nativeId)
            return;
        this.nvrs.get(nativeId)?.release();
        this.nvrs.delete(nativeId);
    }
}

export default LorexNvrPlugin;
