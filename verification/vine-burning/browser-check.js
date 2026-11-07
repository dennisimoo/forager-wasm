async () => {
  const deadline = Date.now() + 30000;
  while (
    !document.getElementById("log").textContent.includes("VINES countdown")
  ) {
    if (Date.now() > deadline) throw new Error("Vine fixture did not complete");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const log = document.getElementById("log").textContent;
  for (const phase of ["ignition", "countdown"]) {
    if (
      !log.includes("VINES " + phase + " PASS") ||
      log.includes("VINES " + phase + " FAIL")
    )
      throw new Error("Vine " + phase + " failed");
  }
  return { ignition: "PASS", countdown: "PASS" };
};
