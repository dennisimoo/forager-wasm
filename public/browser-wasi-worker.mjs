// Browser diagnostic for the translated native game runtime.
import { WASI, WASIProcExit, File, Directory, OpenFile, ConsoleStdout }
  from './vendor/browser-wasi-shim/index.js';

import { openSaveStore, attachSaveStorage } from './browser-save-store.mjs';
import { gameFilesystem } from './browser-filesystem.mjs';
import { BrowserGraphics } from './browser-graphics.mjs';
import { BrowserAudio } from './browser-audio.mjs';
import { BrowserEvents } from './browser-events.mjs';
import { BrowserThreads } from './browser-threads.mjs';

let saveStore;
let reportedLoaderFailure = false;
Error.stackTraceLimit = 64;
const report = (type, detail, transfer = []) => postMessage({ type, detail }, transfer);
function stdout(line) {
  report('stdout', line);
  if (!reportedLoaderFailure && line.includes('LoadLibraryA failed')) {
    reportedLoaderFailure = true;
    report('loader-failure-stack', new Error('Native loader failure').stack);
  }
}
const audioRequests = new Map();
const inputQueue = [];
let nextAudioRequest = 0;
let initialize;
let browserEvents;
let browserAudio;
const initialized = new Promise(resolve => { initialize = resolve; });
onmessage = ({ data }) => {
  if (data.type === 'init') initialize(data);
  if (data.type === 'input') {
    if (!Array.isArray(data.args) || data.args.length !== 5 || data.args.some(value => !Number.isInteger(value))) throw new Error('Invalid input event');
    inputQueue.push(data.args);
  }
  if (data.type === 'audio-event') browserEvents.signal(data.handle);
  if (data.type === 'audio-progress') browserAudio.progress(data.client, data.generation, data.consumed);
  if (data.type === 'audio-reply') {
    const pending = audioRequests.get(data.id);
    if (!pending) throw new Error(`Unknown audio reply ${data.id}`);
    audioRequests.delete(data.id);
    if (data.error) pending.reject(new Error(data.error));
    else pending.resolve(data.result);
  }
};
function requestAudio(operation, detail) {
  const id = ++nextAudioRequest;
  return new Promise((resolve, reject) => {
    audioRequests.set(id, { resolve, reject });
    postMessage({ type: 'audio-request', id, operation, detail });
  });
}
async function loadFile(name, download) {
  const response = await download(`web-game/${name}`);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return new File(await response.arrayBuffer(), { readonly: true });
}

try {
  const configuration = await initialized;
  const { openDownloadCache } = await import('./browser-download-cache.mjs');
  const download = await openDownloadCache(report);
  const events = new BrowserEvents(report);
  const threads = new BrowserThreads(report);
  globalThis.foragerRuntimeState = () => ({ active: threads.active, stopped: threads.stopped ?? false,
    jobs: threads.jobs.map(job => job.thread.index), sleepCalls: threads.sleepCalls, lastSleep: threads.lastSleep,
    threads: [...threads.threads.values()].map(thread => ({ index: thread.index, state: thread.state,
      stack: thread.stack, priority: thread.priority, waiters: thread.waiters.length })),
    criticalSections: [...threads.criticalSections.entries()].filter(([, section]) => section.depth || section.waiters.length)
      .map(([pointer, section]) => ({ pointer, owner: section.owner, depth: section.depth,
        waiters: section.waiters.map(waiter => waiter.owner) })),
    events: [...events.handles.entries()].map(([handle, record]) => ({ handle,
      signaled: record.event.signaled, waiters: record.event.waiters.length })),
    audioRequests: audioRequests.size });
  browserEvents = events;
  const interfaceResponse = await fetch('./d3d-interfaces.json');
  if (!interfaceResponse.ok) throw new Error(`Graphics interfaces: HTTP ${interfaceResponse.status}`);
  const shaderResponse = await fetch('./dxbc-shaders.json');
  if (!shaderResponse.ok) throw new Error(`Shader translations: HTTP ${shaderResponse.status}`);
  const graphics = new BrowserGraphics(configuration.canvas,
    await interfaceResponse.json(), report, await shaderResponse.json(), true);
  const audioResponse = await fetch('./audio-interfaces.json');
  if (!audioResponse.ok) throw new Error(`Audio interfaces: HTTP ${audioResponse.status}`);
  const audio = new BrowserAudio(configuration.audio, await audioResponse.json(), report, requestAudio, events, error => threads.fail(error));
  browserAudio = audio;
  report('phase', 'Loading module and game files');
  const manifestResponse = await fetch('./web-game/manifest.json');
  if (!manifestResponse.ok) throw new Error(`Game manifest: HTTP ${manifestResponse.status}`);
  const names = await manifestResponse.json();
  if (!Array.isArray(names) || !names.length || new Set(names).size !== names.length ||
      names.some(name => typeof name !== 'string' || name.split('/').some(part => !part || part === '.' || part === '..'))) {
    throw new Error('Invalid game file manifest');
  }
  const [module, files] = await Promise.all([
    WebAssembly.compileStreaming(download('native-build/diagnostic-O1.wasm')),
    Promise.all(names.map(async name => [name, await loadFile(name, download)])),
  ]);
  report('phase', 'Browser WASM compilation passed');
  saveStore = await openSaveStore();
  const saves = saveStore.directory;
  const temp = new Directory(new Map());
  const game = new Map();
  for (const [name, file] of files) {
    const parts = name.split('/');
    let directory = game;
    for (const part of parts.slice(0, -1)) {
      if (!directory.has(part)) directory.set(part, new Directory(new Map()));
      const entry = directory.get(part);
      if (!(entry instanceof Directory)) throw new Error(`Conflicting game path: ${name}`);
      directory = entry.contents;
    }
    if (directory.has(parts.at(-1))) throw new Error(`Conflicting game file: ${name}`);
    directory.set(parts.at(-1), file);
  }
  const wasi = new WASI(['Forager.exe'], [
    'APPDATA=/saves', 'LOCALAPPDATA=/saves', 'TEMP=/tmp', 'TMP=/tmp', 'USERPROFILE=/',
  ], [
    new OpenFile(new File([])),
    ConsoleStdout.lineBuffered(stdout),
    ConsoleStdout.lineBuffered(line => report('stderr', line)),
    ...gameFilesystem(game, saves, temp),
  ], { debug: false });
  attachSaveStorage(wasi, saveStore);
  globalThis.foragerFilesystemState = () => {
    const entries = [];
    const visit = (directory, prefix) => {
      for (const [name, entry] of directory.contents) {
        const path = prefix + name;
        if (entry instanceof Directory) visit(entry, path + '/');
        else entries.push({ path, bytes: entry.data.length });
      }
    };
    visit(saves, '/saves/');
    const writableFiles = [], visited = new Set();
    const inspect = (directory, prefix) => {
      if (visited.has(directory)) return;
      visited.add(directory);
      for (const [name, entry] of directory.contents) {
        const path = prefix + name;
        if (entry instanceof Directory) inspect(entry, path + '/');
        else if (!entry.readonly) writableFiles.push({ path, bytes: entry.data.length });
      }
    };
    inspect(wasi.fds[3].dir, '/');
    return { saves: entries, writableFiles, descriptors: wasi.fds.map((fd, index) => fd?.file
      ? { index, bytes: fd.file.data.length } : null).filter(Boolean) };
  };
  for (const name of ['fd_read', 'fd_write', 'fd_seek', 'fd_filestat_set_size', 'path_open', 'path_filestat_get']) {
    const original = wasi.wasiImport[name];
    let calls = 0;
    wasi.wasiImport[name] = (...args) => {
      const count = ++calls;
      if (count <= 10 || count % 1000 === 0) {
        const memory = new DataView(wasi.inst.exports.memory.buffer);
        const vectors = ['fd_read', 'fd_write'].includes(name)
          ? Array.from({length: Math.min(args[2], 4)}, (_, index) => [memory.getUint32(args[1] + index * 8, true), memory.getUint32(args[1] + index * 8 + 4, true)]) : undefined;
        const path = name.startsWith('path_') ? new TextDecoder().decode(
          new Uint8Array(wasi.inst.exports.memory.buffer, args[2], args[3])) : undefined;
        console.log(JSON.stringify({operation: name, calls: count, args, path, vectors, memory: memory.byteLength, stack: count === 10 || count % 1000 === 0 ? new Error('Diagnostic file operation').stack : undefined}, (_, value) => typeof value === 'bigint' ? value.toString() : value));
      }
      const result = original(...args);
      if (name === 'path_open' && (args[4] & 9)) {
        const path = new TextDecoder().decode(new Uint8Array(wasi.inst.exports.memory.buffer, args[2], args[3]));
        console.log(JSON.stringify({ operation: name, path, flags: args[4], result }));
      }
      return result;
    };
  }
  const clockTime = wasi.wasiImport.clock_time_get;
  let clockCalls = 0;
  wasi.wasiImport.clock_time_get = (...args) => {
    const result = clockTime(...args);
    if (++clockCalls % 100000 === 0) console.log(JSON.stringify({operation:'clock',calls:clockCalls,memory:wasi.inst.exports.memory.buffer.byteLength,stack:new Error('Native clock loop').stack}));
    if (++clockCalls === 10000) report('clock-loop-stack', new Error('Native clock call 10000').stack);
    return result;
  };
  const imports = { wasi_snapshot_preview1: wasi.wasiImport,
    forager_browser: { graphics_call: (method, esp) => threads.invoke(() => {
      while (inputQueue.length && threads.instance.exports.aret_browser_input_event(...inputQueue[0])) inputQueue.shift();
      return method === 0x40200 ? 0 : method >= 0x40000 && method <= 0x401ff ? threads.call(method, esp >>> 0) :
      method === 0x30006 && (events.read(esp) & 0xff000000) === 0x70000000
        ? threads.wait(events.read(esp), events.read(esp + 4)) :
      method >= 0x30000 && method <= 0x300ff ? events.call(method, esp >>> 0) :
      method === 0x20000 || (method >>> 8) >= 32 && (method >>> 8) <= 38
        ? audio.call(method, esp >>> 0) : graphics.call(method, esp >>> 0);
    }, method) } };
  for (const item of WebAssembly.Module.imports(module)) {
    if (item.module === 'wasi_snapshot_preview1') {
      if (typeof wasi.wasiImport[item.name] !== 'function') {
        throw new Error(`Missing browser WASI binding: ${item.name}`);
      }
      continue;
    }
    if (item.kind !== 'function') {
      throw new Error(`Unsupported import: ${item.module}.${item.name} (${item.kind})`);
    }
    if (typeof imports[item.module]?.[item.name] === 'function') continue;
    imports[item.module] ??= {};
    imports[item.module][item.name] = () => {
      throw new Error(`Missing runtime binding reached: ${item.module}.${item.name}`);
    };
  }
  if (typeof WebAssembly.Suspending !== 'function' || typeof WebAssembly.promising !== 'function') {
    throw new Error('This research build requires WebAssembly JSPI for browser audio');
  }
  imports.forager_browser.graphics_call = new WebAssembly.Suspending(imports.forager_browser.graphics_call);
  const instance = await WebAssembly.instantiate(module, imports);
  instance.exports.aret_browser_set_display(configuration.width, configuration.height);
  // Read-only inspection of mapped native data after a startup failure.
  globalThis.foragerNativeRead = (address, count = 1, width = 4) => {
    const memory = new DataView(instance.exports.memory.buffer);
    if (![1, 4].includes(width) || !Number.isInteger(count) || count < 0 || count > 256) {
      throw new Error('Invalid native inspection request');
    }
    return Array.from({ length: count }, (_, index) => width === 1
      ? memory.getUint8(address + index) : memory.getUint32(address + index * 4, true));
  };
  // Read-only renderer state for the existing startup diagnostic.
  globalThis.foragerGraphicsState = () => {
    const owners = [...new Set([...graphics.objects.values()].map(value => value.owner))];
    return {
      counts: owners.reduce((out, owner) => { out[owner.type] = (out[owner.type] ?? 0) + 1; return out; }, {}),
      contexts: owners.filter(owner => owner.type === 'context').map(owner => ({
        draws: owner.draws ?? 0, viewport: owner.viewport, topology: owner.topology,
        bindings: [...owner.bindings].map(([name, resource]) => [name, resource?.type ?? null]),
        renderTargets: owner.renderTargets.map(target => target.resource.description),
        programs: owner.device.programs?.size ?? 0,
      })),
      swapchains: owners.filter(owner => owner.type === 'swap-chain').map(owner => ({description: owner.description})),
    };
  };
  graphics.instance = instance;
  audio.instance = instance;
  events.instance = instance;
  threads.instance = instance;
  const memoryMonitor = setInterval(() => report('runtime-state', {
    memory: instance.exports.memory.buffer.byteLength, graphics: graphics.objects.size,
    jobs: threads.jobs.length, active: threads.active,
    room: globalThis.foragerNativeRead(0x1b8e0f8)[0],
  }), 2000);
  report('phase', 'Browser instantiation passed; executing translated startup');
  // WASI.start is synchronous. Keep its instance binding and exit semantics,
  // but await the real native lifetime before checkpointing or closing OPFS.
  wasi.inst = instance;
  let code = 0;
  try {
    try { await threads.runMain(); } finally { clearInterval(memoryMonitor); }
  } catch (error) {
    if (!(error instanceof WASIProcExit)) throw error;
    code = error.code;
  }
  saveStore.persist();
  report('exit', code);
} catch (error) {
  report('error', { name: error?.name ?? 'Error', message: String(error?.message ?? error), stack: error?.stack });
} finally {
  saveStore?.close();
}
