const IUNKNOWN = '0000000000000000c000000000000046';
const MM_DEVICE_ENUMERATOR = '9503debc2fe57c468e3dc4579291692e';
const E_POINTER = 0x80004003;
const E_NOINTERFACE = 0x80004002;
const E_INVALIDARG = 0x80070057;

// WASAPI objects use the existing native COM dispatcher. Their device format
// comes from the main thread's real AudioContext; unimplemented calls fail loudly.
export class BrowserAudio {
  constructor(configuration, interfaces, report, request, events, fail) {
    if (!Number.isInteger(configuration.sampleRate) || configuration.sampleRate <= 0 ||
        ![1, 2].includes(configuration.channels) ||
        !Number.isFinite(configuration.baseLatency) || configuration.baseLatency < 0) {
      throw new Error('Invalid browser audio output configuration');
    }
    this.configuration = configuration;
    this.interfaces = new Map(interfaces.map(record => [record.id, record]));
    this.objects = new Map();
    this.vtables = new Map();
    this.report = report;
    this.request = request;
    this.events = events;
    this.fail = fail;
  }
  progress(client, generation, consumed) {
    const stream = this.objects.get(client)?.stream;
    // Completion messages already in flight can outlive a disposed stream.
    if (!stream || stream.generation !== generation) return;
    if (!Number.isSafeInteger(consumed) || consumed < 0 || consumed > stream.submitted)
      throw new Error('Invalid audio consumption counter');
    stream.consumed = Math.max(stream.consumed, consumed);
    stream.padding = stream.submitted - stream.consumed;
  }
  get memory() { return new DataView(this.instance.exports.memory.buffer); }
  defer(operation, detail, resume) { return { promise: this.request(operation, detail), resume }; }
  read(address) { return this.memory.getUint32(address >>> 0, true); }
  write(address, value) { this.memory.setUint32(address >>> 0, value >>> 0, true); }
  guid(address) {
    return Array.from(new Uint8Array(this.instance.exports.memory.buffer, address >>> 0, 16),
      byte => byte.toString(16).padStart(2, '0')).join('');
  }
  alloc(size) {
    const pointer = this.instance.exports.malloc(size) >>> 0;
    if (!pointer) throw new Error('WASM audio allocation failed');
    new Uint8Array(this.instance.exports.memory.buffer, pointer, size).fill(0);
    return pointer;
  }
  create(group) {
    const descriptor = this.interfaces.get(group);
    if (!descriptor) throw new Error(`Unknown audio interface ${group}`);
    if (!this.vtables.has(group)) {
      const vtable = this.alloc(descriptor.methods.length * 4);
      descriptor.methods.forEach((method, index) => this.write(vtable + index * 4,
        this.instance.exports.aret_browser_method_va((group << 8) | index, method.pop)));
      this.vtables.set(group, vtable);
    }
    const pointer = this.alloc(4);
    this.write(pointer, this.vtables.get(group));
    this.objects.set(pointer, { group, references: 1 });
    return pointer;
  }
  mixFormat() {
    const { channels, sampleRate } = this.configuration;
    const pointer = this.alloc(40);
    this.memory.setUint16(pointer, 0xfffe, true); // WAVE_FORMAT_EXTENSIBLE
    this.memory.setUint16(pointer + 2, channels, true);
    this.write(pointer + 4, sampleRate);
    this.write(pointer + 8, sampleRate * channels * 4);
    this.memory.setUint16(pointer + 12, channels * 4, true);
    this.memory.setUint16(pointer + 14, 32, true);
    this.memory.setUint16(pointer + 16, 22, true);
    this.memory.setUint16(pointer + 18, 32, true);
    this.write(pointer + 20, channels === 2 ? 3 : 4);
    // KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
    new Uint8Array(this.instance.exports.memory.buffer, pointer + 24, 16).set(
      [3, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71]);
    return pointer;
  }
  release(pointer) {
    const object = this.objects.get(pointer);
    if (--object.references) return object.references;
    this.objects.delete(pointer);
    this.instance.exports.free(pointer);
    if (object.parent) {
      this.objects.get(object.parent).renderClient = 0;
      const result = this.release(object.parent);
      return result?.promise ? { ...result, resume: value => { result.resume(value); return 0; } } : 0;
    }
    if (object.stream) return this.defer('dispose', { client: pointer }, () => 0);
    return 0;
  }
  call(method, esp) {
    const arg = index => this.read(esp + index * 4);
    if (method === 0x20000) {
      const output = arg(4);
      if (!output) return E_POINTER;
      this.write(output, 0);
      if (arg(1)) return 0x80040110; // CLASS_E_NOAGGREGATION
      if (!(arg(2) & 1) || this.guid(arg(0)) !== MM_DEVICE_ENUMERATOR) return E_INVALIDARG;
      const iid = this.guid(arg(3));
      if (iid !== IUNKNOWN && !this.interfaces.get(32).iids.some(value => value.bytes === iid)) return E_NOINTERFACE;
      this.write(output, this.create(32));
      this.report('audio-device', this.configuration);
      return 0;
    }
    const group = method >>> 8;
    const index = method & 255;
    const descriptor = this.interfaces.get(group);
    const object = this.objects.get(arg(0));
    if (!descriptor || !object || object.group !== group) throw new Error('Invalid browser audio COM object');
    const name = descriptor.methods[index]?.name;
    if (name === 'QueryInterface') {
      if (!arg(2)) return E_POINTER;
      this.write(arg(2), 0);
      const iid = this.guid(arg(1));
      if (iid !== IUNKNOWN && !descriptor.iids.some(value => value.bytes === iid)) return E_NOINTERFACE;
      object.references++;
      this.write(arg(2), arg(0));
      return 0;
    }
    if (name === 'AddRef') return ++object.references;
    if (name === 'Release') {
      return this.release(arg(0));
    }
    if (group === 32 && name === 'GetDefaultAudioEndpoint') {
      if (!arg(3)) return E_POINTER;
      this.write(arg(3), 0);
      if (arg(1) !== 0 || arg(2) > 2) return E_INVALIDARG;
      this.write(arg(3), this.create(33));
      return 0;
    }
    if (group === 33 && name === 'Activate') {
      if (!arg(4)) return E_POINTER;
      this.write(arg(4), 0);
      if (!(arg(2) & 1) || arg(3)) return E_INVALIDARG;
      if (!this.interfaces.get(34).iids.some(value => value.bytes === this.guid(arg(1)))) return E_NOINTERFACE;
      this.write(arg(4), this.create(34));
      return 0;
    }
    if (group === 33 && name === 'GetState') {
      if (!arg(1)) return E_POINTER;
      this.write(arg(1), 1); // DEVICE_STATE_ACTIVE: real browser output destination
      return 0;
    }
    if (group === 34 && name === 'GetMixFormat') {
      if (!arg(1)) return E_POINTER;
      this.write(arg(1), this.mixFormat());
      return 0;
    }
    if (group === 34 && name === 'GetDevicePeriod') {
      if (!arg(1) && !arg(2)) return E_POINTER;
      const period = BigInt(Math.ceil(128 * 1e7 / this.configuration.sampleRate));
      if (arg(1)) this.memory.setBigInt64(arg(1), period, true);
      if (arg(2)) this.memory.setBigInt64(arg(2), period, true);
      return 0;
    }
    if (group === 34 && name === 'Initialize') {
      if (object.stream) return 0x88890002; // AUDCLNT_E_ALREADY_INITIALIZED
      if (!arg(7)) return E_POINTER;
      const pointer = arg(7);
      const format = {
        tag: this.memory.getUint16(pointer, true),
        channels: this.memory.getUint16(pointer + 2, true),
        sampleRate: this.read(pointer + 4),
        bytesPerSecond: this.read(pointer + 8),
        blockAlign: this.memory.getUint16(pointer + 12, true),
        bits: this.memory.getUint16(pointer + 14, true),
        extraSize: this.memory.getUint16(pointer + 16, true),
      };
      if (format.tag === 0xfffe && format.extraSize >= 22) {
        format.validBits = this.memory.getUint16(pointer + 18, true);
        format.channelMask = this.read(pointer + 20);
        format.subFormat = this.guid(pointer + 24);
      }
      this.report('audio-stream-request', { shareMode: arg(1), flags: arg(2), format });
      const float = format.tag === 3 || format.tag === 0xfffe &&
        format.subFormat === '0300000000001000800000aa00389b71' && format.validBits === 32;
      if (!float || format.bits !== 32 || format.channels !== this.configuration.channels ||
          format.sampleRate !== this.configuration.sampleRate || format.blockAlign !== format.channels * 4 ||
          format.bytesPerSecond !== format.sampleRate * format.blockAlign) return 0x88890008;
      if (arg(1) !== 0 || (arg(2) & ~0x40000) || arg(5) || arg(6)) {
        throw new Error('Unsupported WASAPI stream mode or flags');
      }
      const duration = this.memory.getBigInt64(esp + 3 * 4, true);
      if (duration < 0n) return E_INVALIDARG;
      const frames = Math.max(128, Number((duration * BigInt(format.sampleRate) + 9999999n) / 10000000n));
      return this.defer('initialize', { client: arg(0), format, frames }, stream => {
        object.stream = { ...stream, format, flags: arg(2), started: false, padding: 0, submitted: 0, consumed: 0 };
        return 0;
      });
    }
    if (group === 34 && name === 'GetBufferSize') {
      if (!arg(1)) return E_POINTER;
      if (!object.stream) return 0x88890001; // AUDCLNT_E_NOT_INITIALIZED
      this.write(arg(1), object.stream.frames);
      return 0;
    }
    if (group === 34 && name === 'SetEventHandle') {
      if (!object.stream) return 0x88890001;
      if (!(object.stream.flags & 0x40000)) return 0x88890011;
      if (object.stream.started) return 0x88890005;
      const event = this.events.handles.get(arg(1));
      if (!event) return 0x80070006;
      return this.defer('set-event', { client: arg(0), handle: arg(1) }, () => {
        object.stream.eventHandle = arg(1);
        return 0;
      });
    }
    if (group === 34 && name === 'GetService') {
      if (!arg(2)) return E_POINTER;
      this.write(arg(2), 0);
      if (!object.stream) return 0x88890001;
      if (!this.interfaces.get(35).iids.some(value => value.bytes === this.guid(arg(1)))) {
        this.report('audio-service-request', { iid: this.guid(arg(1)) });
        return E_NOINTERFACE;
      }
      if (object.renderClient) this.objects.get(object.renderClient).references++;
      else {
        object.renderClient = this.create(35);
        const render = this.objects.get(object.renderClient);
        render.parent = arg(0);
        render.stream = object.stream;
        object.references++;
      }
      this.write(arg(2), object.renderClient);
      return 0;
    }
    if (group === 34 && name === 'GetCurrentPadding') {
      if (!arg(1)) return E_POINTER;
      if (!object.stream) return 0x88890001;
      this.write(arg(1), object.stream.padding);
      return 0;
    }
    if (group === 35 && name === 'GetBuffer') {
      if (!arg(2)) return E_POINTER;
      this.write(arg(2), 0);
      const stream = object.stream;
      if (stream.pending) return 0x88890007; // AUDCLNT_E_OUT_OF_ORDER
      const frames = arg(1);
      if (!frames) return 0;
      const acquire = padding => {
        if (frames > stream.frames - padding) return 0x88890006;
        const pointer = this.alloc(frames * stream.format.blockAlign);
        stream.pending = { pointer, frames };
        this.write(arg(2), pointer);
        return 0;
      };
      // Consumption only frees capacity. Reuse the confirmed lower bound on
      // available space instead of asking the main thread twice per mix.
      if (frames <= stream.frames - stream.padding) return acquire(stream.padding);
      const submitted = stream.submitted;
      return this.defer('padding', { client: object.parent }, padding => {
        this.progress(object.parent, stream.generation, submitted - padding);
        return acquire(stream.padding);
      });
    }
    if (group === 35 && name === 'ReleaseBuffer') {
      const stream = object.stream;
      if (!stream.pending) return arg(1) ? 0x88890007 : 0;
      const frames = arg(1);
      if (frames > stream.pending.frames) return 0x88890009;
      if (arg(2) & ~2) return E_INVALIDARG;
      if (!frames) {
        this.instance.exports.free(stream.pending.pointer);
        stream.pending = null;
        return 0;
      }
      const samples = arg(2) & 2 ? new Float32Array(frames * stream.format.channels) :
        new Float32Array(this.instance.exports.memory.buffer, stream.pending.pointer, frames * stream.format.channels).slice();
      // WASAPI ReleaseBuffer commits a copied buffer synchronously. The host
      // message queue preserves submission order; its acknowledgement must not
      // park the game's mixer while it owns a native critical section.
      stream.padding += frames;
      stream.submitted += frames;
      this.instance.exports.free(stream.pending.pointer);
      stream.pending = null;
      this.request('submit', { client: object.parent, frames, samples }).then(consumed => {
        this.progress(object.parent, stream.generation, consumed);
      }).catch(this.fail);
      return 0;
    }
    if (group === 34 && name === 'Start') {
      if (!object.stream) return 0x88890001;
      if (object.stream.started) return 0x88890005;
      if ((object.stream.flags & 0x40000) && !object.stream.eventHandle) return 0x88890014;
      return this.defer('start', { client: arg(0) }, () => {
        object.stream.started = true;
        return 0;
      });
    }
    const parameters = Array.from({ length: (descriptor.methods[index]?.pop ?? 4) / 4 }, (_, index) => arg(index));
    this.report('audio-method', { interface: descriptor.name, method: name, parameters });
    throw new Error(`Unsupported browser audio method: ${descriptor.name}.${name}`);
  }
}
