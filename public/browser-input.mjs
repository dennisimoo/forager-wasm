// DOM events are queued in the worker and enter native USER32 only while it
// owns an active continuation. Coordinates follow the displayed game canvas.
export function attachGameInput(canvas, worker) {
  const held = new Map();
  const scans = { Escape:1, Enter:28, Space:57, Backspace:14, Tab:15,
    ShiftLeft:42, ShiftRight:54, ControlLeft:29, ControlRight:29, AltLeft:56, AltRight:56,
    ArrowLeft:75, ArrowRight:77, ArrowUp:72, ArrowDown:80 };
  for (const [row,start] of [['QWERTYUIOP',16],['ASDFGHJKL',30],['ZXCVBNM',44]]) {
    [...row].forEach((letter,index) => { scans[`Key${letter}`]=start+index; });
  }
  const send = args => worker.postMessage({ type:'input', args });
  const position = event => {
    const rect=canvas.getBoundingClientRect();
    return [Math.round((event.clientX-rect.left)*canvas.width/rect.width),
      Math.round((event.clientY-rect.top)*canvas.height/rect.height)];
  };
  window.addEventListener('keydown', event => {
    if (event.isComposing) return;
    const vk={ShiftLeft:160,ShiftRight:161,ControlLeft:162,ControlRight:163,AltLeft:164,AltRight:165}[event.code] ?? event.keyCode;
    if (!vk) return;
    const scan=scans[event.code] ?? 0;
    const extended=/^(Arrow|ControlRight|AltRight|Insert|Delete|Home|End|Page)/.test(event.code) ? 2 : 0;
    held.set(event.code,[vk,scan,extended]);
    send([0,vk,scan,0,1|extended]);
    if (event.key.length===1 && !event.ctrlKey && !event.metaKey && !event.altKey) send([5,event.key.codePointAt(0),0,0,0]);
    event.preventDefault();
  });
  window.addEventListener('keyup', event => {
    const key=held.get(event.code); if (!key) return;
    held.delete(event.code); send([0,key[0],key[1],0,key[2]]);event.preventDefault();
  });
  let mouse=[0,0];const buttons=new Set();
  canvas.addEventListener('pointermove', event => { mouse=position(event);send([1,0,...mouse,0]); });
  canvas.addEventListener('pointerdown', event => {
    const button=[1,4,2][event.button];if (!button) return;
    canvas.setPointerCapture(event.pointerId);mouse=position(event);buttons.add(button);send([2,button,...mouse,1]);event.preventDefault();
  });
  canvas.addEventListener('pointerup', event => {
    const button=[1,4,2][event.button];if (!button) return;
    mouse=position(event);buttons.delete(button);send([2,button,...mouse,0]);event.preventDefault();
  });
  const release=()=>{
    for (const [vk,scan,extended] of held.values()) send([0,vk,scan,0,extended]);held.clear();
    for (const button of buttons) send([2,button,...mouse,0]);buttons.clear();
  };
  window.addEventListener('blur',release);canvas.addEventListener('pointercancel',release);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)release();});
  canvas.addEventListener('wheel',event=>{mouse=position(event);send([4,event.deltaY<0?120:-120,...mouse,0]);event.preventDefault();},{passive:false});
  canvas.addEventListener('contextmenu',event=>event.preventDefault());
}
