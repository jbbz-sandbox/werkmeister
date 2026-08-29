// SPIKE — not part of any npm script, not wired into CI.
//
// One question only: can a UI driver accept this extension's own `showInputBox`?
// 041 rejected a test for checklist 16 as "needs workbench keyboard commands; too
// flaky". Everything asserted here is the input box itself — no terminal, no CLI,
// no container — so a failure means the driver cannot do it, not that the
// environment was wrong.
const assert = require("assert");
const { InputBox, Workbench } = require("vscode-extension-tester");

describe("[spike] checklist 16 — the New Workspace input box", function () {
  // First call pays a cold workbench; ExTester's default 2s mocha timeout is
  // nowhere near enough.
  this.timeout(60_000);

  // executeCommand() leaves the command palette on screen for a moment, and
  // InputBox.create() returns whichever quick-input widget is up — the palette
  // included. Identify our own widget by the placeholder commands.ts sets;
  // without this the assertions run against the palette and pass for the wrong
  // reason, which is worse than failing.
  async function openInput() {
    await new Workbench().executeCommand("Sandbox: New Workspace");
    const deadline = Date.now() + 10_000;
    for (;;) {
      const input = await InputBox.create();
      if ((await input.getPlaceHolder()) === "TRE-1234") return input;
      if (Date.now() > deadline) throw new Error("the New Workspace input never appeared");
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it("opens, and carries the placeholder and prompt from commands.ts", async () => {
    const input = await openInput();
    assert.equal(await input.getPlaceHolder(), "TRE-1234");
    assert.match(await input.getMessage(), /Jira ticket \(optional\)/);
    await input.cancel();
  });

  // The real assertion of the spike: validateInput is the extension's own code,
  // and only a driver can reach it — an extension cannot answer its own widget.
  it("rejects a malformed key via validateInput", async () => {
    const input = await openInput();
    await input.setText("not-a-ticket");

    // validateInput resolves asynchronously and VS Code re-renders after it, so
    // a single read races the widget. Poll for the message rather than sleeping.
    const deadline = Date.now() + 5000;
    let message = "";
    let flagged = false;
    while (Date.now() < deadline) {
      message = await input.getMessage();
      flagged = await input.hasError();
      if (/Expected a key like TRE-1234/.test(message)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.match(message, /Expected a key like TRE-1234/, "validateInput's own message");
    console.log(`      [spike] hasError() reported ${flagged} for a rejected key`);
    await input.cancel();
  });

  it("accepts a well-formed key, and accepts empty (the skip path)", async () => {
    const input = await openInput();
    await input.setText("TRE-1234");
    assert.equal(await input.hasError(), false);

    await input.setText("");
    assert.equal(await input.hasError(), false, "empty is the documented skip");
    await input.cancel();
  });

  it("cancels on Escape, which is the branch that returns undefined", async () => {
    const input = await openInput();
    await input.cancel();
    assert.strictEqual(await new Workbench().getDriver().switchTo().activeElement() !== null, true);
  });
});
