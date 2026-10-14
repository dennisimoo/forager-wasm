import { Directory, PreopenDirectory }
  from './vendor/browser-wasi-shim/index.js';

// The HLE translates C:\ paths under this prefix and returns these AppData
// folders through SHGetFolderPath. Both aliases use the durable save tree.
export function gameFilesystem(game, saves, temp) {
  const appData = new Directory(new Map([['Local', saves], ['Roaming', saves]]));
  const profile = new Directory(new Map([['AppData', appData]]));
  const users = new Directory(new Map([['aret', profile]]));
  const drive = new Map([...game, ['users', users]]);
  // The runner's working directory also holds saveData0 and its settings.
  const prefix = new Directory(new Map([['drive_c', new Directory(drive)], ['Forager', saves]]));
  const root = new Map([...game, ['aret_prefix', prefix], ['saves', saves], ['tmp', temp]]);
  return [
    new PreopenDirectory('.', root),
    new PreopenDirectory('aret_prefix/drive_c', drive),
    new PreopenDirectory('/saves', saves.contents),
    new PreopenDirectory('/tmp', temp.contents),
  ];
}
