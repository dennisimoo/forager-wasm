class ThreadExit extends Error {
  constructor(code) { super('Translated thread exited'); this.code = code; }
}

// One native continuation runs at a time. Every asynchronous import parks its
// C stack and runtime context; a FIFO queue restores both before resuming it.
export class BrowserThreads {
  constructor(report) {
    this.report = report;
    this.threads = new Map([[0, { index: 0, state: 'running', priority: 0, waiters: [] }]]);
    this.active = 0;
    this.jobs = [];
    this.criticalSections = new Map();
    this.lastYield = performance.now();
    this.lastBrowserTurn = performance.now();
    this.dispatch = new MessageChannel();
    this.dispatch.port1.onmessage = () => {
      this.lastBrowserTurn = performance.now();
      this.resumeNext();
    };
    this.failed = new Promise((_, reject) => { this.rejectFailure = reject; });
  }
  get e() { return this.instance.exports; }
  get memory() { return new DataView(this.e.memory.buffer); }
  read(address) { return this.memory.getUint32(address >>> 0, true); }
  write(address, value) { this.memory.setUint32(address >>> 0, value >>> 0, true); }
  defer(promise, resume) { return { promise, resume }; }
  park() {
    const thread = this.threads.get(this.active);
    if (!thread) throw new Error('No active native continuation');
    thread.stack = this.e.__stack_pointer.value;
    this.e.aret_browser_context_save(thread.index);
    thread.saved = true;
    thread.state = 'parked';
    this.active = null;
    return thread;
  }
  enqueue(thread, action) {
    if (this.stopped) return;
    this.jobs.push({ thread, action, queuedAt: performance.now() });
    this.pump();
  }
  pump() {
    if (this.dispatchPending || this.active !== null || !this.jobs.length || this.stopped) return;
    this.dispatchPending = true;
    // Resume ready native work without another browser task after every wait.
    // An ordinary task turn every eight milliseconds still services input,
    // audio messages and timers, avoiding an endless microtask chain.
    if (performance.now() - this.lastBrowserTurn < 8) {
      queueMicrotask(() => this.resumeNext());
    } else this.dispatch.port2.postMessage(null);
  }
  resumeNext() {
    this.dispatchPending = false;
    if (this.active !== null || this.stopped) return;
    // A lock owner must inherit its waiters' priority, otherwise background
    // work can indefinitely delay the owner and every continuation behind it.
    const priorities = new Map([...this.threads].map(([index, thread]) => [index, thread.priority]));
    let changed;
    do {
      changed = false;
      for (const section of this.criticalSections.values()) {
        if (section.owner === null) continue;
        for (const waiter of section.waiters) {
          if (priorities.get(waiter.owner) > priorities.get(section.owner)) {
            priorities.set(section.owner, priorities.get(waiter.owner));
            changed = true;
          }
        }
      }
    } while (changed);
    // Honor effective priority, but don't let native polling threads starve
    // ready work on this single browser worker. Old jobs retain FIFO order.
    const now = performance.now();
    let next = 0;
    for (let index = 1; index < this.jobs.length; index++) {
      const candidate = this.jobs[index], selected = this.jobs[next];
      const candidateAged = now - candidate.queuedAt >= 16;
      const selectedAged = now - selected.queuedAt >= 16;
      if (candidateAged ? (!selectedAged || candidate.queuedAt < selected.queuedAt)
        : (!selectedAged && priorities.get(candidate.thread.index) > priorities.get(selected.thread.index))) next = index;
    }
    const { thread, action } = this.jobs.splice(next, 1)[0];
    this.active = thread.index;
    this.e.__stack_pointer.value = thread.stack;
    this.e.aret_browser_context_restore(thread.index);
    thread.state = 'running';
    this.lastYield = performance.now();
    try { action(); } catch (error) { this.fail(error); }
  }
  invoke(call, method) {
    const result = call();
    let suspension = result instanceof Promise ? { promise: result } : result?.promise ? result : null;
    // CPU-heavy startup repeatedly enters the platform bridge without blocking.
    // Give ready threads and browser messages a turn at those real call boundaries.
    // Ready background threads must not force a full JSPI/context switch on
    // every draw call. Explicit waits still park immediately; runnable work
    // shares the existing eight-millisecond cooperative time slice.
    if (!suspension && performance.now() - this.lastYield >= 8) {
      suspension = { promise: Promise.resolve(result) };
    }
    if (!suspension) return result;
    this.lastYield = performance.now();
    const thread = this.park();
    if (thread.index && !thread.observedSuspend) {
      thread.observedSuspend = true;
      this.report('thread-suspended', { index: thread.index, method, stack: thread.stack });
    }
    const continuation = new Promise((resolve, reject) => {
      suspension.promise.then(value => this.enqueue(thread, () => {
        try { resolve(suspension.resume ? suspension.resume(value) : value); } catch (error) { reject(error); }
      }), error => this.enqueue(thread, () => reject(error)));
    });
    this.pump();
    return continuation;
  }
  fail(error) {
    this.stopped = true;
    this.dispatch.port1.close();
    this.dispatch.port2.close();
    this.jobs.length = 0;
    this.rejectFailure(error);
  }
  create(esp) {
    const arg = index => this.read(esp + index * 4);
    if (arg(0) || (arg(4) & ~4)) throw new Error('Unsupported thread security or creation flags');
    let index = 1;
    while (this.threads.has(index) && index < 64) index++;
    if (index === 64) throw new Error('Translated thread context limit reached');
    const machineSize = Math.max(65536, arg(1) || 1048576);
    const machineStack = this.e.malloc(machineSize) >>> 0;
    const cStackSize = 2097152;
    const cStack = this.e.malloc(cStackSize + 15) >>> 0;
    if (!machineStack || !cStack) {
      if (machineStack) this.e.free(machineStack);
      if (cStack) this.e.free(cStack);
      return 0;
    }
    if (!this.e.aret_browser_context_create(index, machineStack + machineSize, machineStack)) {
      this.e.free(machineStack); this.e.free(cStack); return 0;
    }
    const mainId = this.threads.get(0).id ??= this.e.aret_GetCurrentThreadId(0) - this.active;
    const thread = { index, id: mainId + index, state: arg(4) & 4 ? 'suspended' : 'ready',
      stack: (cStack + cStackSize) & ~15, machineStack, machineSize, cStack,
      start: arg(2), parameter: arg(3), priority: 0, waiters: [], handle: 0x70000000 + index };
    this.threads.set(index, thread);
    if (arg(5)) this.write(arg(5), thread.id);
    const entryStack = (machineStack + machineSize - 16) & ~15;
    this.write(entryStack, 0); this.write(entryStack + 4, thread.parameter);
    thread.entryStack = entryStack;
    this.report('thread-created', { index, id: thread.id, start: thread.start, parameter: thread.parameter });
    if (thread.state === 'ready') {
      this.enqueue(thread, () => this.start(thread));
      // Win32 permits the new entry to run before CreateThread returns. Yield
      // here so a runnable thread can start even if its caller next polls.
      return this.defer(Promise.resolve(thread.handle), handle => handle);
    }
    return thread.handle;
  }
  start(thread) {
    this.report('thread-started', { index: thread.index, start: thread.start });
    WebAssembly.promising(this.e.aret_browser_thread_entry)(thread.start, thread.entryStack).then(
      code => this.finish(thread, code), error => {
        if (error instanceof ThreadExit) this.finish(thread, error.code);
        else this.fail(error);
      });
  }
  finish(thread, code) {
    if (this.stopped) return;
    if (this.active !== thread.index) return this.fail(new Error('Thread returned under a different context'));
    this.park();
    thread.state = 'done'; thread.code = code >>> 0;
    this.report('thread-exit', { index: thread.index, code: thread.code });
    for (const waiter of thread.waiters.splice(0)) waiter(0);
    this.pump();
  }
  thread(handle) { return this.threads.get(handle === 0xfffffffe ? this.active : handle - 0x70000000); }
  wait(handle, milliseconds) {
    const thread = this.thread(handle);
    if (!thread) throw new Error(`Unknown translated thread handle ${handle}`);
    if (thread.state === 'done') return 0;
    if (!milliseconds) return 258;
    return new Promise(resolve => {
      let timer;
      const done = result => {
        clearTimeout(timer);
        const index = thread.waiters.indexOf(done);
        if (index >= 0) thread.waiters.splice(index, 1);
        resolve(result);
      };
      thread.waiters.push(done);
      if (milliseconds !== 0xffffffff) timer = setTimeout(() => done(258), milliseconds);
    });
  }
  updateCriticalSection(pointer, section) {
    this.write(pointer + 4, section.depth - 1 + section.waiters.length);
    this.write(pointer + 8, section.depth);
    this.write(pointer + 12, section.owner === null ? 0 : this.threads.get(section.owner).id ?? this.e.aret_GetCurrentThreadId(0));
  }
  critical(method, esp) {
    const pointer = this.read(esp);
    if (!pointer) throw new Error('Null critical section');
    const operation = method - 0x40100;
    if (operation <= 2) {
      if (this.criticalSections.has(pointer)) throw new Error('Critical section is already initialized');
      const section = { owner: null, depth: 0, waiters: [] };
      this.criticalSections.set(pointer, section);
      new Uint8Array(this.e.memory.buffer, pointer, 24).fill(0);
      this.write(pointer + 20, operation ? this.read(esp + 4) : 0);
      this.updateCriticalSection(pointer, section);
      return operation === 0 ? 0 : 1;
    }
    const section = this.criticalSections.get(pointer);
    if (!section) throw new Error('Uninitialized critical section');
    if (operation === 3) {
      if (section.depth || section.waiters.length) throw new Error('Deleting an acquired critical section');
      this.criticalSections.delete(pointer); return 0;
    }
    if (operation === 4 || operation === 5) {
      if (section.owner === null || section.owner === this.active) {
        section.owner = this.active; section.depth++;
        this.updateCriticalSection(pointer, section); return operation === 5 ? 1 : 0;
      }
      if (operation === 5) return 0;
      const owner = this.active;
      return new Promise(resolve => {
        section.waiters.push({ owner, resolve }); this.updateCriticalSection(pointer, section);
      });
    }
    if (operation === 6) {
      if (section.owner !== this.active) throw new Error('Critical section released by a different thread');
      if (--section.depth === 0) {
        section.owner = null;
        const next = section.waiters.shift();
        if (next) { section.owner = next.owner; section.depth = 1; next.resolve(0); }
      }
      this.updateCriticalSection(pointer, section); return 0;
    }
    throw new Error(`Unsupported critical section operation ${method}`);
  }
  call(method, esp) {
    if (method === 0x400ff) return this.lastError ?? 0;
    if (method >= 0x40100 && method <= 0x40106) return this.critical(method, esp);
    if (method === 0x40000) return this.create(esp);
    if (method === 0x40001) {
      const thread = this.thread(this.read(esp));
      if (!thread || thread.state !== 'suspended') return 0xffffffff;
      thread.state = 'ready'; this.enqueue(thread, () => this.start(thread)); return 1;
    }
    if (method === 0x40002) {
      if (!this.active) throw new Error('ExitThread on the main thread is not implemented');
      throw new ThreadExit(this.read(esp));
    }
    if (method === 0x40003) {
      const thread = this.thread(this.read(esp));
      const output = this.read(esp + 4);
      if (!thread || !output) return 0;
      this.write(output, thread.state === 'done' ? thread.code : 259); return 1;
    }
    if (method === 0x40004) {
      const thread = this.thread(this.read(esp));
      if (!thread || !thread.index) return 0;
      if (thread.state !== 'done') throw new Error('Closing an active thread handle is not implemented');
      this.e.aret_browser_context_destroy(thread.index);
      this.e.free(thread.machineStack); this.e.free(thread.cStack);
      this.threads.delete(thread.index); return 1;
    }
    if (method === 0x40005) {
      this.lastSleep = { thread: this.active, milliseconds: this.read(esp) };
      this.sleepCalls = (this.sleepCalls ?? 0) + 1;
      return new Promise(resolve => setTimeout(() => resolve(0), this.lastSleep.milliseconds));
    }
    if (method === 0x40006 || method === 0x40007) {
      const thread = this.thread(this.read(esp));
      if (!thread) { this.lastError = 6; return method === 0x40006 ? 0 : 0x7fffffff; }
      if (method === 0x40007) return thread.priority;
      const priority = this.memory.getInt32(esp + 4, true);
      if (![-15, -2, -1, 0, 1, 2, 15].includes(priority)) { this.lastError = 87; return 0; }
      thread.priority = priority; return 1;
    }
    throw new Error(`Unsupported thread operation ${method}`);
  }
  async runMain() {
    try { return await Promise.race([WebAssembly.promising(this.e._start)(), this.failed]); }
    finally {
      this.stopped = true;
      this.dispatch.port1.close();
      this.dispatch.port2.close();
    }
  }
}
