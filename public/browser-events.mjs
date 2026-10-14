// Win32 event objects backed by JSPI suspension, shared by audio and native waits.
export class BrowserEvents {
  constructor(report) {
    this.report = report;
    this.handles = new Map();
    this.names = new Map();
    this.nextHandle = 0x6e000000;
    this.lastError = 0;
  }
  get memory() { return new DataView(this.instance.exports.memory.buffer); }
  read(pointer) { return this.memory.getUint32(pointer >>> 0, true); }
  name(pointer, wide) {
    if (!pointer) return null;
    let name = '';
    for (let offset = 0; ; offset += wide ? 2 : 1) {
      const value = wide ? this.memory.getUint16(pointer + offset, true) : this.memory.getUint8(pointer + offset);
      if (!value) return name;
      name += String.fromCharCode(value);
    }
  }
  create(name, manual, signaled, access) {
    let event = name === null ? undefined : this.names.get(name);
    this.lastError = event ? 183 : 0; // ERROR_ALREADY_EXISTS
    if (!event) {
      event = { name, manual, signaled, waiters: [], handles: 0 };
      if (name !== null) this.names.set(name, event);
    }
    const handle = ++this.nextHandle;
    if (handle >= 0x6f000000) throw new Error('Browser event handles exhausted');
    event.handles++;
    this.handles.set(handle, { event, access });
    this.report('event-created', { handle, name, manual: event.manual, signaled: event.signaled, access });
    return handle;
  }
  signal(handle) {
    const record = this.handles.get(handle);
    if (!record) throw new Error(`Unknown browser event ${handle}`);
    const event = record.event;
    event.signaled = true;
    while (event.waiters.length && event.signaled) {
      const waiter = event.waiters.shift();
      if (!event.manual) event.signaled = false;
      waiter.finish(0);
    }
  }
  wait(handle, milliseconds) {
    const record = this.handles.get(handle);
    if (!record) { this.lastError = 6; return 0xffffffff; }
    if (!(record.access & 0x100000)) { this.lastError = 5; return 0xffffffff; }
    const event = record.event;
    if (event.signaled) {
      if (!event.manual) event.signaled = false;
      return 0;
    }
    if (milliseconds === 0) return 258; // WAIT_TIMEOUT
    return new Promise(resolve => {
      let timer;
      const waiter = { finish: result => {
        clearTimeout(timer);
        const index = event.waiters.indexOf(waiter);
        if (index >= 0) event.waiters.splice(index, 1);
        resolve(result);
      } };
      event.waiters.push(waiter);
      if (milliseconds !== 0xffffffff) timer = setTimeout(() => waiter.finish(258), milliseconds);
    });
  }
  call(method, esp) {
    if (method === 0x300ff) return this.lastError;
    const arg = index => this.read(esp + index * 4);
    this.lastError = 0;
    const operation = method - 0x30000;
    if (operation >= 0 && operation <= 3) {
      if (arg(0)) throw new Error('Browser events do not implement security descriptors');
      const extended = operation >= 2;
      const flags = extended ? arg(2) : (arg(1) ? 1 : 0) | (arg(2) ? 2 : 0);
      if (flags & ~3) { this.lastError = 87; return 0; }
      const name = this.name(arg(extended ? 1 : 3), !!(operation & 1));
      const access = extended ? arg(3) : 0x1f0003;
      return this.create(name, !!(flags & 1), !!(flags & 2), access);
    }
    if (operation === 6) return this.wait(arg(0), arg(1));
    const handle = arg(0);
    const record = this.handles.get(handle);
    if (!record) { this.lastError = 6; return 0; }
    if (operation === 4 || operation === 5) {
      if (!(record.access & 2)) { this.lastError = 5; return 0; }
      if (operation === 4) this.signal(handle);
      else record.event.signaled = false;
      return 1;
    }
    if (operation === 7) {
      if (record.event.waiters.length) throw new Error('Closing an event during a pending wait');
      this.handles.delete(handle);
      if (--record.event.handles === 0 && record.event.name !== null) this.names.delete(record.event.name);
      return 1;
    }
    throw new Error(`Unsupported browser event operation ${method}`);
  }
}
