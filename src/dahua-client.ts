import crypto from 'crypto';
import http, { IncomingMessage } from 'http';

export interface DahuaCredentials {
    host: string;
    httpPort: number;
    username: string;
    password: string;
}

interface DigestChallenge {
    realm: string;
    nonce: string;
    qop?: string;
    opaque?: string;
    algorithm?: string;
}

export interface DahuaResponse {
    statusCode: number;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
}

function md5(s: string) {
    return crypto.createHash('md5').update(s).digest('hex');
}

export function parseDigestChallenge(header: string | string[] | undefined): DigestChallenge | undefined {
    const values = Array.isArray(header) ? header : header ? [header] : [];
    const digest = values.find(v => v.trim().toLowerCase().startsWith('digest'));
    if (!digest)
        return;
    const params: Record<string, string> = {};
    const re = /(\w+)=("([^"]*)"|([^,\s]*))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(digest.substring(digest.indexOf(' ') + 1)))) {
        params[m[1].toLowerCase()] = m[3] ?? m[4];
    }
    if (!params.realm || !params.nonce)
        return;
    return {
        realm: params.realm,
        nonce: params.nonce,
        qop: params.qop,
        opaque: params.opaque,
        algorithm: params.algorithm,
    };
}

/**
 * Minimal HTTP client for the Dahua CGI API.
 *
 * Credentials are sent up front with Basic auth. If the device answers 401 with a
 * Digest challenge, every later request switches to Digest. Sending credentials up
 * front matters: some Lorex/Dahua firmware answers the event stream with 200 OK even
 * without credentials, then sends nothing, so waiting for a 401 challenge never logs in.
 */
export class DahuaClient {
    private digest?: DigestChallenge;
    private nc = 0;

    constructor(public creds: DahuaCredentials, public console: Console = globalThis.console) {
    }

    private authorization(method: string, path: string): string {
        const { username, password } = this.creds;
        if (!this.digest)
            return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

        const d = this.digest;
        const ha1 = md5(`${username}:${d.realm}:${password}`);
        const ha2 = md5(`${method}:${path}`);
        const parts = [
            `username="${username}"`,
            `realm="${d.realm}"`,
            `nonce="${d.nonce}"`,
            `uri="${path}"`,
        ];
        let response: string;
        if (d.qop) {
            const qop = d.qop.split(',').map(s => s.trim()).includes('auth') ? 'auth' : d.qop.split(',')[0].trim();
            const nc = (++this.nc).toString(16).padStart(8, '0');
            const cnonce = crypto.randomBytes(8).toString('hex');
            response = md5(`${ha1}:${d.nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
            parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
        }
        else {
            response = md5(`${ha1}:${d.nonce}:${ha2}`);
        }
        parts.push(`response="${response}"`);
        if (d.opaque)
            parts.push(`opaque="${d.opaque}"`);
        if (d.algorithm)
            parts.push(`algorithm=${d.algorithm}`);
        return 'Digest ' + parts.join(', ');
    }

    private open(path: string, timeout: number): Promise<IncomingMessage> {
        return new Promise((resolve, reject) => {
            const req = http.request({
                host: this.creds.host,
                port: this.creds.httpPort,
                path,
                method: 'GET',
                headers: {
                    Authorization: this.authorization('GET', path),
                    Accept: '*/*',
                },
                timeout,
            }, resolve);
            req.on('timeout', () => req.destroy(new Error(`timeout requesting ${path}`)));
            req.on('error', reject);
            req.end();
        });
    }

    /**
     * Open a request, retrying once with Digest auth if challenged.
     */
    async openAuthenticated(path: string, timeout = 10000): Promise<IncomingMessage> {
        let res = await this.open(path, timeout);
        if (res.statusCode === 401) {
            const challenge = parseDigestChallenge(res.headers['www-authenticate']);
            res.resume();
            if (!challenge)
                throw new Error(`401 Unauthorized for ${path}. Check the NVR username and password.`);
            // a new or stale nonce: switch to digest and retry once.
            this.digest = challenge;
            this.nc = 0;
            res = await this.open(path, timeout);
        }
        if (res.statusCode === 401) {
            res.resume();
            throw new Error(`401 Unauthorized for ${path}. Check the NVR username and password.`);
        }
        return res;
    }

    async request(path: string, timeout = 10000): Promise<DahuaResponse> {
        const res = await this.openAuthenticated(path, timeout);
        const chunks: Buffer[] = [];
        for await (const chunk of res)
            chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks);
        if (res.statusCode !== 200)
            throw new Error(`HTTP ${res.statusCode} for ${path}: ${body.toString().substring(0, 200)}`);
        return { statusCode: res.statusCode!, headers: res.headers, body };
    }

    async text(path: string, timeout?: number) {
        return (await this.request(path, timeout)).body.toString();
    }

    async getConfig(name: string) {
        return parseTable(await this.text(`/cgi-bin/configManager.cgi?action=getConfig&name=${encodeURIComponent(name)}`));
    }

    async magicBox(action: string, extra = '') {
        const body = await this.text(`/cgi-bin/magicBox.cgi?action=${action}${extra}`);
        const eq = body.indexOf('=');
        return (eq === -1 ? body : body.substring(eq + 1)).trim();
    }

    /**
     * @param snapshotChannel the channel number exactly as the NVR's snapshot.cgi expects it.
     * On Lorex/Dahua NVRs this is usually 0 based (camera 1 = channel=0), unlike RTSP which is 1 based.
     */
    async snapshot(snapshotChannel: number, timeout = 10000) {
        const res = await this.request(`/cgi-bin/snapshot.cgi?channel=${snapshotChannel}`, timeout);
        const type = res.headers['content-type'] || '';
        if (type && !type.toString().toLowerCase().includes('image'))
            throw new Error(`snapshot returned ${type}, not an image: ${res.body.toString().substring(0, 120)}`);
        return res.body;
    }
}

/**
 * Parse "key=value" lines into a map. Dahua returns config this way.
 */
export function parseTable(body: string): Map<string, string> {
    const ret = new Map<string, string>();
    for (const raw of body.split(/\r?\n/)) {
        const line = raw.trim();
        const eq = line.indexOf('=');
        if (eq <= 0)
            continue;
        ret.set(line.substring(0, eq), line.substring(eq + 1).trim());
    }
    return ret;
}

export interface DahuaEvent {
    code: string;
    action: string;
    index: number;
    raw: string;
}

/**
 * Incremental parser for the multipart eventManager stream.
 * Dahua firmware is inconsistent about boundaries, headers and newlines, so rather than
 * parse the multipart structure this scans each line for "Code=...;action=...;index=N".
 */
export class DahuaEventParser {
    private buffer = '';

    push(chunk: string): DahuaEvent[] {
        this.buffer += chunk;
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() ?? '';
        // protect against a runaway line with no newline.
        if (this.buffer.length > 65536)
            this.buffer = '';
        const ret: DahuaEvent[] = [];
        for (const line of lines) {
            const e = parseEventLine(line);
            if (e)
                ret.push(e);
        }
        return ret;
    }
}

export function parseEventLine(line: string): DahuaEvent | undefined {
    const m = /Code=([^;\s]+);\s*action=([^;\s]+);\s*index=(\d+)/i.exec(line);
    if (!m)
        return;
    return {
        code: m[1],
        action: m[2],
        index: parseInt(m[3]),
        raw: line.trim(),
    };
}

export interface ChannelInfo {
    // 1 based channel number, as used in RTSP and snapshot urls.
    channel: number;
    name?: string;
    streams: StreamInfo[];
}

export interface StreamInfo {
    subtype: number;
    codec?: string;
    width?: number;
    height?: number;
    fps?: number;
    bitrate?: number;
    audioCodec?: string;
}

function toCodec(c?: string) {
    c = c?.trim().toUpperCase();
    if (c === 'H.264' || c === 'H264')
        return 'h264';
    if (c === 'H.265' || c === 'H265')
        return 'h265';
    if (c === 'MJPG' || c === 'MJPEG')
        return 'mjpeg';
    return c?.toLowerCase();
}

function toAudioCodec(c?: string) {
    c = c?.trim().toUpperCase();
    if (c === 'AAC')
        return 'aac';
    if (c === 'G.711A')
        return 'pcm_alaw';
    if (c === 'G.711MU')
        return 'pcm_mulaw';
    return c?.toLowerCase();
}

/**
 * Work out which channels have cameras from the Encode table. Channels without a
 * camera only report "ErrorId" lines.
 */
export function parseChannels(encode: Map<string, string>, titles: Map<string, string>, maxExtraStreams: number): ChannelInfo[] {
    const indexes = new Set<number>();
    for (const key of encode.keys()) {
        const m = /^table\.Encode\[(\d+)\]\.MainFormat\[0\]\.Video\.Compression$/.exec(key);
        if (m)
            indexes.add(parseInt(m[1]));
    }

    const ret: ChannelInfo[] = [];
    for (const i of [...indexes].sort((a, b) => a - b)) {
        const streams: StreamInfo[] = [];
        for (let s = 0; s <= maxExtraStreams; s++) {
            const prefix = s === 0 ? `table.Encode[${i}].MainFormat[0]` : `table.Encode[${i}].ExtraFormat[${s - 1}]`;
            const compression = encode.get(`${prefix}.Video.Compression`);
            if (!compression)
                continue;
            if (encode.get(`${prefix}.VideoEnable`) === 'false')
                continue;
            const width = parseInt(encode.get(`${prefix}.Video.Width`) || '');
            const height = parseInt(encode.get(`${prefix}.Video.Height`) || '');
            const fps = parseFloat(encode.get(`${prefix}.Video.FPS`) || '');
            const bitrate = parseInt(encode.get(`${prefix}.Video.BitRate`) || '');
            const audioOn = encode.get(`${prefix}.AudioEnable`) === 'true';
            streams.push({
                subtype: s,
                codec: toCodec(compression),
                width: isNaN(width) ? undefined : width,
                height: isNaN(height) ? undefined : height,
                fps: isNaN(fps) ? undefined : fps,
                bitrate: isNaN(bitrate) ? undefined : bitrate * 1000,
                audioCodec: audioOn ? toAudioCodec(encode.get(`${prefix}.Audio.Compression`)) : undefined,
            });
        }
        if (!streams.length)
            continue;
        const name = titles.get(`table.ChannelTitle[${i}].Name`);
        ret.push({
            channel: i + 1,
            name: name || undefined,
            streams,
        });
    }
    return ret;
}
