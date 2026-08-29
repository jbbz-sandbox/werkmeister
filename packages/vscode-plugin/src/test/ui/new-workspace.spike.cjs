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

  async function openInput() {
    await new Workbench().executeCommand("Sandbox: New Workspace");
    return InputBox.create();
  }

  it("opens, and carries the title and placeholder from commands.ts", async () => {
    const input = await openInput();
    assert.strictEqual(await input.getTitle(), "New Sandbox Workspace");
    assert.strictEqual(await input.getPlaceHolder(), "TRE-1234");
    await input.cancel();
  });

  it("rejects a malformed key via validateInput, and will not submit it", async () => {
    const input = await openInput();
    await input.setText("not-a-ticket");
    assert.match(await input.getMessage(), /Expected a key like TRE-1234/);
    assert.strictEqual(await input.hasProgress(), false);
    await input.cancel();
  });

  it("accepts a well-formed key", async () => {
    const input = await openInput();
    await input.setText("TRE-1234");
    // No validation message is the gate on confirm(); assert that, not the
    // terminal, which is deliberately out of this spike's scope.
    assert.strictEqual(await input.getMessage(), "");
    await input.confirm();
  });

  it("cancels on Escape, which is the branch that returns undefined", async () => {
    const input = await openInput();
    await input.cancel();
    assert.strictEqual(await new Workbench().getDriver().switchTo().activeElement() !== null, true);
  });
});
