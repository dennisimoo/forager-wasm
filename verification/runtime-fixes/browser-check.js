async () => {
  for (let i = 0; i < 1000; i++) {
    runner._onKeyDown(65);
    runner._onMouseDown(1);
  }
  runner._onKeyUp(65);
  runner._onMouseUp(1);
  const frame = runner._getRunnerFrameCount() + 3;
  const deadline = Date.now() + 15000;
  while (runner._getRunnerFrameCount() < frame) {
    if (Date.now() > deadline) throw new Error("Runner stopped advancing");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  runner._dumpRunnerState();
  const text = document.getElementById("log").textContent;
  const dump = text.slice(text.lastIndexOf("=== Frame"));
  for (const expected of ["auditKey = 0", "auditMouse = 0"]) {
    if (!dump.includes(expected)) throw new Error("Missing " + expected);
  }
  for (const field of ["auditReleased", "auditMouseReleased"]) {
    const match = dump.match(new RegExp(field + " = ([0-9]+)"));
    if (!match || Number(match[1]) < 1)
      throw new Error("Missing release for " + field);
  }
  return { events: 2002, keyHeld: false, mouseHeld: false };
};
