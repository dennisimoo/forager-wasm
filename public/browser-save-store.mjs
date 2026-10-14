import { File, Directory } from './vendor/browser-wasi-shim/index.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const magic = encoder.encode('FGRSAVE1');

function filesIn(directory, prefix = '') {
  const files = [];
  for (const [name, inode] of directory.contents) {
    const path = prefix + name;
    if (inode instanceof Directory) {
      files.push({ path: encoder.encode(path), data: null });
      files.push(...filesIn(inode, path + '/'));
    }
    else if (inode instanceof File) files.push({ path: encoder.encode(path), data: inode.data });
    else throw new Error(`Unsupported save inode: ${path}`);
  }
  return files;
}

function encode(directory) {
  const files = filesIn(directory);
  const size = 12 + files.reduce((total, file) => total + 9 + file.path.length + (file.data?.length ?? 0), 0);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes.set(magic);
  view.setUint32(8, files.length, true);
  let offset = 12;
  for (const { path, data } of files) {
    view.setUint8(offset, data === null ? 1 : 0);
    view.setUint32(offset + 1, path.length, true);
    view.setUint32(offset + 5, data?.length ?? 0, true);
    offset += 9;
    bytes.set(path, offset); offset += path.length;
    if (data !== null) { bytes.set(data, offset); offset += data.length; }
  }
  return bytes;
}

function decode(bytes) {
  const root = new Directory(new Map());
  if (!bytes.length) return root;
  if (bytes.length < 12 || magic.some((value, index) => value !== bytes[index])) {
    throw new Error('Unrecognized Forager save checkpoint');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(8, true);
  let offset = 12;
  for (let index = 0; index < count; index++) {
    const kind = view.getUint8(offset);
    const pathSize = view.getUint32(offset + 1, true);
    const dataSize = view.getUint32(offset + 5, true);
    offset += 9;
    if (kind > 1 || (kind === 1 && dataSize)) throw new Error("Invalid save entry type");
    if (offset + pathSize + dataSize > bytes.length) throw new Error('Truncated Forager save checkpoint');
    const path = decoder.decode(bytes.subarray(offset, offset + pathSize)).split('/');
    offset += pathSize;
    if (path.some(name => !name || name === '.' || name === '..')) throw new Error('Invalid save path');
    let directory = root;
    for (const name of path.slice(0, -1)) {
      if (!directory.contents.has(name)) directory.contents.set(name, new Directory(new Map()));
      directory = directory.contents.get(name);
      if (!(directory instanceof Directory)) throw new Error('Conflicting save path');
    }
    const name = path.at(-1);
    if (directory.contents.has(name)) throw new Error('Duplicate save path');
    directory.contents.set(name, kind === 1 ? new Directory(new Map())
      : new File(bytes.slice(offset, offset + dataSize)));
    offset += dataSize;
  }
  if (offset !== bytes.length) throw new Error('Trailing data in save checkpoint');
  return root;
}

function containsFile(directory, file) {
  for (const inode of directory.contents.values()) {
    if (inode === file) return true;
    if (inode instanceof Directory && containsFile(inode, file)) return true;
  }
  return false;
}

export async function openSaveStore(filename = 'forager-4.1.9-saves.bin') {
  const root = await navigator.storage.getDirectory();
  const file = await root.getFileHandle(filename, { create: true });
  const access = await file.createSyncAccessHandle();
  try {
    const bytes = new Uint8Array(access.getSize());
    if (access.read(bytes, { at: 0 }) !== bytes.length) throw new Error('Incomplete save checkpoint read');
    const directory = decode(bytes);
    const persist = () => {
      const snapshot = encode(directory);
      if (access.write(snapshot, { at: 0 }) !== snapshot.length) throw new Error('Incomplete save checkpoint write');
      access.truncate(snapshot.length);
      access.flush();
    };
    return { directory, persist, close: () => access.close() };
  } catch (error) {
    access.close();
    throw error;
  }
}

export function attachSaveStorage(wasi, store) {
  // Close/sync occurs at the end of a guest file write. OPFS flush is
  // synchronous in the worker, even while the game's main function is running.
  for (const name of ['fd_close', 'fd_sync', 'fd_datasync']) {
    const original = wasi.wasiImport[name];
    wasi.wasiImport[name] = fd => {
      const file = wasi.fds[fd]?.file;
      const result = original(fd);
      if (result === 0 && file && containsFile(store.directory, file)) store.persist();
      return result;
    };
  }
  for (const name of ['path_rename', 'path_unlink_file', 'path_remove_directory', 'path_create_directory']) {
    const original = wasi.wasiImport[name];
    wasi.wasiImport[name] = (...args) => {
      const result = original(...args);
      if (result === 0) store.persist();
      return result;
    };
  }
}
